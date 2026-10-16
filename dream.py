"""
DeepDreamer - endless DeepDream "fall" video, rendered with a pretrained VGG16.

Usage (the .bat files do this for you):
    python dream.py            -> full render using settings.ini [render]
    python dream.py --preview  -> short low-res test using settings.ini [preview]

Rendering is chunked (segment_seconds). If it is interrupted, just run it again:
finished segments are kept and it resumes where it stopped.
"""
import os, sys, math, time, shutil, argparse, subprocess, configparser
import numpy as np
import torch
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------------------- config
def load_cfg(preview):
    cp = configparser.ConfigParser(inline_comment_prefixes=("#", ";"))
    cp.read(os.path.join(HERE, "settings.ini"), encoding="utf-8")
    sec = "preview" if preview else "render"
    base = dict(cp["render"])
    if preview:
        base.update(dict(cp["preview"]))
    c = {}
    c["width"] = int(base["width"]); c["height"] = int(base["height"])
    c["fps"] = int(base["fps"]); c["seconds"] = float(base["seconds"])
    c["output"] = base["output"]
    c["segment_seconds"] = float(base.get("segment_seconds", 30))
    c["steps"] = int(base.get("steps", 1))
    c["strength"] = float(base.get("strength", 2.2))           # gradient step size (per 1/30 s)
    c["zoom_rate"] = float(base.get("zoom_rate", 0.40))        # zoom into the picture, per second
    c["rotate_rate"] = float(base.get("rotate_rate", 0.05))    # radians per second wobble amplitude
    c["noise"] = float(base.get("noise", 0.02))
    c["target_mean"] = float(base.get("target_mean", 0.45))
    c["target_std"] = float(base.get("target_std", 0.20))
    c["hue_rate"] = float(base.get("hue_rate", 0.15))          # colour rotation, rad per second
    c["saturation"] = float(base.get("saturation", 1.35))
    c["contrast"] = float(base.get("contrast", 1.15))
    c["sharpen"] = float(base.get("sharpen", 0.25))
    c["layer_period"] = float(base.get("layer_period", 14))    # seconds for textures->eyes->objects cycle
    c["object_bias"] = min(1.0, max(0.0, float(base.get("object_bias", 0.0))))  # 0..1, favour whole objects
    c["scales"] = [float(s) for s in base.get("scales", "0.4,0.7,1.0").split(",")]
    c["seed"] = int(base.get("seed", 7))
    c["init_image"] = base.get("init_image", "").strip()
    c["resample"] = base.get("resample", "bilinear").strip().lower()       # warp filter: bilinear or bicubic
    if c["resample"] not in ("bilinear", "bicubic"):
        sys.exit(f"settings.ini: resample must be bilinear or bicubic, not '{c['resample']}'")
    c["model"] = base.get("model", "vgg16").strip().lower()               # which network dreams
    if c["model"] not in MODELS:
        sys.exit(f"settings.ini: model must be one of {', '.join(MODELS)}, not '{c['model']}'")
    c["prompt"] = base.get("prompt", "").strip()                        # empty = plain dreaming
    c["prompt_mode"] = base.get("prompt_mode", "clip").strip().lower()   # clip (any text), imagenet (class names) or none
    if c["prompt_mode"] not in ("clip", "imagenet", "none"):
        sys.exit(f"settings.ini: prompt_mode must be clip, imagenet or none, not '{c['prompt_mode']}'")
    c["prompt_weight"] = min(1.0, max(0.0, float(base.get("prompt_weight", 0.85))))  # 0 = ignore prompt, 1 = only prompt
    c["prompt_cuts"] = int(base.get("prompt_cuts", 8))                  # random crops the prompt network looks at
    c["fade_seconds"] = float(base.get("fade_seconds", 1.5))
    c["encoder_args"] = base.get("encoder_args", "-c:v libx264 -preset fast -crf 14 -pix_fmt yuv420p").split()
    return c


# ----------------------------------------------------------------------------- model
# Each network is run as a chain of stages; the five tapped stages go from textures (first) to whole objects (last).
MODELS = {
    # relu3_3, relu4_1, relu4_3, relu5_1, relu5_3
    "vgg16": dict(taps=[15, 18, 22, 25, 29]),
    # inception3b, inception4a, inception4c (the classic 2015 DeepDream layer), inception4d, inception4e
    "googlenet": dict(taps=["inception3b", "inception4a", "inception4c", "inception4d", "inception4e"]),
}


class DreamNet(torch.nn.Module):
    """Runs the stages in order and returns the weighted sum of the tapped activations' energy."""

    def __init__(self, stages, taps, pre=None):
        super().__init__()
        self.stages = torch.nn.ModuleList(stages)
        self.taps = taps            # stage index for each of the five layer weights
        self.pre = pre              # optional input conversion the network expects

    def forward(self, x, lw):
        if self.pre is not None:
            x = self.pre(x)
        need = max(i for k, i in enumerate(self.taps) if lw[k] > 1e-3)
        loss = 0.0
        for i, stage in enumerate(self.stages):
            x = stage(x)
            if i in self.taps:
                k = self.taps.index(i)
                if lw[k] > 1e-3:
                    loss = loss + float(lw[k]) * x.float().pow(2).mean()
            if i >= need:          # deeper stages don't contribute
                break
        return loss


def build_model(dev, name="vgg16"):
    import torchvision
    tm = torchvision.models
    random = bool(os.environ.get("DREAM_RANDOM_WEIGHTS"))   # only used for smoke tests
    if name == "vgg16":
        vgg = tm.vgg16(weights=None if random else tm.VGG16_Weights.IMAGENET1K_V1)
        taps = MODELS[name]["taps"]
        net = DreamNet(list(vgg.features[:max(taps) + 1]), taps)
    elif name == "googlenet":
        g = tm.googlenet(weights=None if random else tm.GoogLeNet_Weights.IMAGENET1K_V1)
        order = ["conv1", "maxpool1", "conv2", "conv3", "maxpool2", "inception3a", "inception3b", "maxpool3",
                 "inception4a", "inception4b", "inception4c", "inception4d", "inception4e"]
        taps = [order.index(n) for n in MODELS[name]["taps"]]
        # the ImageNet weights expect torchvision's own input conversion (transform_input)
        net = DreamNet([getattr(g, n) for n in order], taps, pre=g._transform_input if g.transform_input else None)
    else:
        raise ValueError(name)
    net = net.eval().to(dev)
    for p in net.parameters():
        p.requires_grad_(False)
    if dev.type == "cuda":
        net = net.to(memory_format=torch.channels_last)
    return net


MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)


OBJECT_W = np.array([0.0, 0.0, 0.1, 0.4, 0.5])  # weights for the deep layers that make whole objects


def layer_weights(t, period, object_bias=0.0):
    ph = t / period
    w = np.array([0.5 + 0.5 * math.cos(2 * math.pi * (ph - c)) for c in (0.0, 0.15, 0.3, 0.45, 0.6)])
    w = np.maximum(w, 0) ** 2
    w = w / w.sum()
    # object_bias 0 = pure textures->eyes->objects cycle, 1 = always the deep "objects" layers
    return (1 - object_bias) * w + object_bias * OBJECT_W


def grad_at_scale(model, x, scale, lw, dev, amp, trace=None):
    xs = x
    if scale != 1.0:
        xs = F.interpolate(x, scale_factor=scale, mode="bilinear", antialias=True, align_corners=False)
    xs = xs.detach().requires_grad_(True)
    inp = (xs - MEAN.to(dev)) / STD.to(dev)
    if dev.type == "cuda":
        inp = inp.contiguous(memory_format=torch.channels_last)
    with torch.autocast(device_type=dev.type, dtype=torch.float16, enabled=amp):
        loss = model(inp, lw)
    loss.backward()
    g = xs.grad
    if scale != 1.0:
        g = F.interpolate(g, size=x.shape[-2:], mode="bilinear", align_corners=False)
    g = g / (g.abs().mean() + 1e-8)
    if trace is not None:   # for the editor's "How it's made" view
        trace.append(dict(scale=scale, seen=xs.detach().clone(), grad=g.detach().clone(), loss=float(loss)))
    return g


# ----------------------------------------------------------------------------- image ops
def make_seed(h, w, dev, seed, init_image):
    if init_image:
        from PIL import Image
        im = Image.open(init_image)
        if im.mode.startswith("I"):   # 16/32-bit greyscale (some PNG/TIFF): convert() would clip it to white
            a = np.asarray(im, dtype=np.float32)
            im = Image.fromarray(np.clip(a / (65535.0 if a.max() > 255 else 255.0) * 255, 0, 255).astype(np.uint8), "L")
        im = im.convert("RGB")
        s = max(w / im.width, h / im.height)
        im = im.resize((math.ceil(im.width * s), math.ceil(im.height * s)), Image.LANCZOS)
        l, t = (im.width - w) // 2, (im.height - h) // 2
        im = im.crop((l, t, l + w, t + h))
        return torch.from_numpy(np.asarray(im).astype(np.float32) / 255.0).permute(2, 0, 1)[None].to(dev)
    g = torch.Generator(device="cpu").manual_seed(seed)
    out = torch.zeros(1, 3, h, w)
    for s in (2, 4, 8, 16, 32):
        n = torch.rand(1, 3, max(2, h // s), max(2, w // s), generator=g)
        out += F.interpolate(n, size=(h, w), mode="bicubic", align_corners=False) * s
    out = (out - out.min()) / (out.max() - out.min())
    return out.to(dev)


def warp(img, zoom, ang, dx, dy, mode="bilinear"):
    """zoom>1 zooms IN. dx, dy in normalised units.
    bicubic overshoots slightly; repeated every frame (esp. at 60 fps) that builds up into zig-zag streaks."""
    c, s = math.cos(ang) / zoom, math.sin(ang) / zoom
    h, w = img.shape[-2:]
    a = h / w
    theta = torch.tensor([[c, -s * a, dx], [s / a, c, dy]], dtype=img.dtype, device=img.device)[None]
    grid = F.affine_grid(theta, img.shape, align_corners=False)
    return F.grid_sample(img, grid, mode=mode, padding_mode="reflection", align_corners=False)


def hue_matrix(angle, dev):
    # rotation about the grey axis (1,1,1)
    c, s = math.cos(angle), math.sin(angle)
    k = 1.0 / 3.0
    sq = math.sqrt(k)
    m = [[c + (1 - c) * k, k * (1 - c) - sq * s, k * (1 - c) + sq * s],
         [k * (1 - c) + sq * s, c + k * (1 - c), k * (1 - c) - sq * s],
         [k * (1 - c) - sq * s, k * (1 - c) + sq * s, c + k * (1 - c)]]
    return torch.tensor(m, dtype=torch.float32, device=dev)


def sharpen(img, amount):
    if amount <= 0:
        return img
    k = torch.tensor([1, 2, 1], dtype=img.dtype, device=img.device)
    k = (k[:, None] * k[None, :]) / 16.0
    k = k.expand(3, 1, 3, 3)
    blur = F.conv2d(F.pad(img, (1, 1, 1, 1), mode="reflect"), k, groups=3)
    return img + amount * (img - blur)


def tone(img, mean, std):
    mu = img.mean((2, 3), keepdim=True)
    sd = img.std((2, 3), keepdim=True) + 1e-3
    return (mean + (img - mu) / sd * std).clamp(0, 1)


def display(img, sat, con):
    g = img.mean(1, keepdim=True)
    o = (g + (img - g) * sat).clamp(0, 1)
    return ((o - 0.5) * con + 0.5).clamp(0, 1)


class Dreamer:
    """Turns one frame into the next. Used by main() and by the editor's "How it's made" view (editor/inspect.py)."""

    def __init__(self, c, dev):
        self.c, self.dev = c, dev
        self.amp = dev.type == "cuda"
        fps = c["fps"]
        self.model = build_model(dev, c["model"])
        self.lr = c["strength"] / 255.0 * (30.0 / fps)       # step in 0..1 units, scaled for fps
        self.zoom = math.exp(c["zoom_rate"] / fps)
        self.hue = hue_matrix(c["hue_rate"] / fps, dev)
        self.noise = c["noise"] * math.sqrt(30.0 / fps)
        self.guide = None
        if c["prompt"] and c["prompt_weight"] > 0 and c["prompt_mode"] != "none":
            from prompts import PromptGuide
            self.guide = PromptGuide(c, dev, c["model"])

    def step(self, img, f, trace=None):
        """Frame f from the previous state. With trace={} every intermediate image is recorded in it."""
        c, fps = self.c, self.c["fps"]
        rec = (lambda k, v: trace.__setitem__(k, v.detach().clone())) if trace is not None else (lambda k, v: None)
        rec("previous", img)
        t = f / fps
        ang = c["rotate_rate"] * math.sin(t * 0.3) / fps * 6
        dx, dy = 0.01 * math.sin(t * 0.7) / fps * 6, 0.01 * math.cos(t * 0.5) / fps * 6
        img = warp(img, self.zoom, ang, dx, dy, c["resample"]); rec("warp", img)
        img = sharpen(img, c["sharpen"] / 2); rec("sharpen", img)
        img = img + self.noise * torch.randn_like(img); rec("noise", img)
        img = torch.einsum("ij,bjhw->bihw", self.hue, img).clamp(0, 1); rec("hue", img)
        img = tone(img, c["target_mean"], c["target_std"]); rec("tone", img)
        lw = layer_weights(t, c["layer_period"], c["object_bias"])
        scales = [] if trace is not None else None
        for i in range(c["steps"]):
            g = sum(grad_at_scale(self.model, img, s, lw, self.dev, self.amp, scales if i == 0 else None) for s in c["scales"])
            g = g / len(c["scales"])
            if self.guide is not None:     # mix in the push toward the prompt (both gradients have mean |g| = 1)
                w = c["prompt_weight"]
                g = (1 - w) * g + w * self.guide.grad(img, self.amp)
            if trace is not None and i == 0:
                trace["scales"] = scales; trace["grad"] = g.detach().clone()
            img = (img + self.lr * g).clamp(0, 1).detach()
        if trace is not None:
            trace["after"] = img.detach().clone(); trace["layer_weights"] = [float(x) for x in lw]
            trace["angle"] = ang; trace["t"] = t
        return img


# ----------------------------------------------------------------------------- main
def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg") or "ffmpeg"


def write_live(frame, path, f, n, fps):
    """Save a small JPEG of the current frame (+ a one-line JSON with its position) for the editor's live view."""
    try:
        from PIL import Image
        im = Image.fromarray(frame)
        if im.width > 960:
            im = im.resize((960, round(im.height * 960 / im.width)), Image.BILINEAR)
        im.save(path + ".tmp.jpg", quality=82)
        os.replace(path + ".tmp.jpg", path)
        with open(path + ".json.tmp", "w") as fh:
            fh.write(f'{{"frame": {f + 1}, "frames": {n}, "time": {f / fps:.2f}}}')
        os.replace(path + ".json.tmp", path + ".json")
    except OSError:
        pass    # the editor may be reading the file right now; skip this one


def open_writer(path, c):
    cmd = [ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{c['width']}x{c['height']}", "-r", str(c["fps"]), "-i", "-"] + c["encoder_args"] + [path]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()
    c = load_cfg(args.preview)
    with open(os.path.join(HERE, "settings.ini"), encoding="utf-8") as fh:
        settings_text = fh.read()   # snapshot now, so edits made during the render don't end up in the backup
    dev =torch.device("cuda" if torch.cuda.is_available() else "cpu")
    amp = dev.type == "cuda"
    if dev.type == "cpu":
        print("WARNING: no CUDA GPU found - this will be VERY slow. Lower width/height/fps in settings.ini.")
    else:
        print("GPU:", torch.cuda.get_device_name(0))
    W, H, FPS = c["width"], c["height"], c["fps"]
    H -= H % 2; W -= W % 2
    c["width"], c["height"] = W, H
    N = int(round(c["seconds"] * FPS))
    SEG = max(1, int(round(c["segment_seconds"] * FPS)))
    nseg = math.ceil(N / SEG)
    work = os.path.join(HERE, "work_preview" if args.preview else "work")
    os.makedirs(work, exist_ok=True)
    dreamer = Dreamer(c, dev)          # builds the network before seeding, as before
    print("Model:", c["model"])
    if dreamer.guide is not None:
        print(f"Prompt ({c['prompt_weight']:g}):", dreamer.guide.description)
    live = os.path.join(work, "live.jpg")    # latest frame, for the editor's live view
    last_live = 0.0
    torch.manual_seed(c["seed"])
    fade_n = max(1, int(c["fade_seconds"] * FPS))
    t0 = time.time()

    for seg in range(nseg):
        out_path = os.path.join(work, f"seg_{seg:03d}.mp4")
        st_path = os.path.join(work, f"state_{seg:03d}.pt")
        if os.path.exists(out_path) and os.path.exists(st_path):
            continue
        if seg == 0:
            img = make_seed(H, W, dev, c["seed"], c["init_image"])
        else:
            img = torch.load(os.path.join(work, f"state_{seg-1:03d}.pt"), map_location=dev).float()
        wr = open_writer(out_path + ".tmp.mp4", c)
        f_end = min(N, (seg + 1) * SEG)
        for f in range(seg * SEG, f_end):
            try:
                img = dreamer.step(img, f)
            except torch.cuda.OutOfMemoryError:
                print("\nOut of GPU memory. Lower width/height in settings.ini (e.g. 1280x720) or remove 1.0 from scales.")
                sys.exit(1)
            fade = min(1.0, (f + 1) / fade_n, (N - f) / fade_n)
            o = display(img, c["saturation"], c["contrast"]) * fade
            frame = o[0].permute(1, 2, 0).mul(255).byte().cpu().numpy()
            wr.stdin.write(frame.tobytes())
            if time.time() - last_live > 0.5:
                last_live = time.time()
                write_live(frame, live, f, N, FPS)
            if f % FPS == 0:
                done = f + 1
                el = time.time() - t0
                print(f"\r  frame {done}/{N}  ({done/N*100:4.1f}%)  elapsed {el/60:5.1f} min", end="", flush=True)
        wr.stdin.close(); wr.wait()
        torch.save(img.half().cpu(), st_path)
        os.replace(out_path + ".tmp.mp4", out_path)
        print(f"\n  segment {seg+1}/{nseg} done")

    # join segments
    lst = os.path.join(work, "list.txt")
    with open(lst, "w") as fh:
        for seg in range(nseg):
            fh.write(f"file 'seg_{seg:03d}.mp4'\n")
    out_dir = HERE if args.preview else os.path.join(HERE, "output")
    os.makedirs(out_dir, exist_ok=True)
    final = os.path.join(out_dir, c["output"])
    subprocess.check_call([ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                           "-i", lst, "-c", "copy", final])
    settings_backup = os.path.splitext(final)[0] + "_settings.ini"
    with open(settings_backup, "w", encoding="utf-8") as fh:
        fh.write(settings_text)
    print("\nDONE ->", final)
    print("Settings used saved as", settings_backup)


if __name__ == "__main__":
    main()
