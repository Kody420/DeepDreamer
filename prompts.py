"""
Prompt guidance for DeepDreamer: pushes the dream toward a text prompt.

prompt_mode = imagenet  -> the prompt is matched to the 1000 ImageNet object names and the dreaming network's own
                           classifier (vgg16 / googlenet) is asked to see those objects. 2014-era class visualisation.
prompt_mode = clip      -> OpenAI CLIP RN50 (2021) scores how well the picture matches any free text.

Both look at several random crops of the frame each step (so the whole picture is steered, not one spot) and return
a gradient normalised like the dream gradient, so prompt_weight mixes the two on equal terms.
"""
import re
import torch
import torch.nn.functional as F

CLIP_MEAN = torch.tensor([0.48145466, 0.4578275, 0.40821073]).view(1, 3, 1, 1)
CLIP_STD = torch.tensor([0.26862954, 0.26130258, 0.27577711]).view(1, 3, 1, 1)
IMNET_MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
IMNET_STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)

_categories = None


def imagenet_categories():
    global _categories
    if _categories is None:
        import torchvision
        _categories = list(torchvision.models.VGG16_Weights.IMAGENET1K_V1.meta["categories"])
    return _categories


def match_classes(prompt, per_phrase=3):
    """Split the prompt at commas and match each phrase to ImageNet class names.
    Returns (matches, unmatched): matches = [(phrase, [(index, name), ...]), ...]"""
    cats = imagenet_categories()
    low = [c.lower() for c in cats]
    matches, unmatched = [], []
    for phrase in [p.strip().lower() for p in re.split(r"[,;\n]+", prompt or "") if p.strip()]:
        variants = {phrase, phrase.rstrip("s"), re.sub(r"ies$", "y", phrase), re.sub(r"es$", "", phrase)}
        found = [i for i, c in enumerate(low) if c in variants]
        if not found:
            pats = [re.compile(r"\b" + re.escape(v) + r"\b") for v in variants if len(v) > 2]
            found = sorted({i for i, c in enumerate(low) for p in pats if p.search(c)}, key=lambda i: len(low[i]))
        if not found:   # every word of the phrase somewhere in the name
            words = [w.rstrip("s") for w in phrase.split() if len(w) > 2]
            if words:
                found = sorted([i for i, c in enumerate(low) if all(w in c for w in words)], key=lambda i: len(low[i]))
        if found:
            matches.append((phrase, [(i, cats[i]) for i in found[:per_phrase]]))
        else:
            unmatched.append(phrase)
    return matches, unmatched


class PromptGuide:
    def __init__(self, c, dev, dream_model_name):
        self.dev = dev
        self.mode = c["prompt_mode"]
        self.cuts = max(1, int(c.get("prompt_cuts", 8)))
        self.gen = torch.Generator(device="cpu").manual_seed(c["seed"] + 12345)   # crops don't disturb the noise
        if self.mode == "clip":
            try:
                import open_clip
            except ImportError:
                raise SystemExit("prompt_mode = clip needs the CLIP package: venv\\Scripts\\python.exe -m pip install open_clip_torch")
            model, _, _ = open_clip.create_model_and_transforms("RN50", pretrained="openai")
            self.net = model.eval().to(dev)
            for p in self.net.parameters():
                p.requires_grad_(False)
            tok = open_clip.get_tokenizer("RN50")
            with torch.no_grad():
                t = self.net.encode_text(tok([c["prompt"]]).to(dev)).float()
            self.text = t / t.norm(dim=-1, keepdim=True)
            self.mean, self.std = CLIP_MEAN.to(dev), CLIP_STD.to(dev)
            self.description = f'CLIP RN50: "{c["prompt"]}"'
        elif self.mode == "imagenet":
            import torchvision
            tm = torchvision.models
            if dream_model_name == "googlenet":
                net = tm.googlenet(weights=tm.GoogLeNet_Weights.IMAGENET1K_V1)
            else:
                net = tm.vgg16(weights=tm.VGG16_Weights.IMAGENET1K_V1)
            self.net = net.eval().to(dev)
            for p in self.net.parameters():
                p.requires_grad_(False)
            matches, unmatched = match_classes(c["prompt"])
            if not matches:
                raise SystemExit(f'prompt "{c["prompt"]}" matches none of the 1000 ImageNet classes. '
                                 "Use object names like: jellyfish, volcano, peacock, castle (or prompt_mode = clip).")
            self.classes = sorted({i for _, m in matches for i, _ in m})
            self.mean, self.std = IMNET_MEAN.to(dev), IMNET_STD.to(dev)
            names = ", ".join(imagenet_categories()[i] for i in self.classes)
            self.description = f"ImageNet classes ({dream_model_name}): {names}" + \
                               (f"  (no match for: {', '.join(unmatched)})" if unmatched else "")
        else:
            raise SystemExit(f"prompt_mode must be clip or imagenet, not '{self.mode}'")

    def _crops(self, x):
        """One whole-frame view plus random square crops (30-100% of the short side), each 224x224."""
        h, w = x.shape[-2:]
        side = min(h, w)
        views = [F.interpolate(x, size=(224, 224), mode="bilinear", antialias=True, align_corners=False)]
        r = torch.rand(self.cuts - 1, 4, generator=self.gen).tolist() if self.cuts > 1 else []
        for a, b, cx, flip in r:
            s = int(side * (0.3 + 0.7 * a))
            y0 = int((h - s) * b); x0 = int((w - s) * cx)
            v = F.interpolate(x[..., y0:y0 + s, x0:x0 + s], size=(224, 224), mode="bilinear", antialias=True, align_corners=False)
            views.append(v.flip(-1) if flip > 0.5 else v)
        return torch.cat(views)

    def grad(self, img, amp=True):
        x = img.detach().requires_grad_(True)
        batch = (self._crops(x) - self.mean) / self.std
        with torch.autocast(device_type=self.dev.type, dtype=torch.float16, enabled=amp and self.dev.type == "cuda"):
            if self.mode == "clip":
                f = self.net.encode_image(batch).float()
                f = f / f.norm(dim=-1, keepdim=True)
                score = (f @ self.text.T).mean()
            else:
                logp = self.net(batch).float().log_softmax(-1)
                score = logp[:, self.classes].mean()
        score.backward()
        g = x.grad
        self.last_score = float(score.detach())
        return g / (g.abs().mean() + 1e-8)
