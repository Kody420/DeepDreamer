"""
DeepDreamer - endless DeepDream "fall" video, rendered with a pretrained VGG16.

Usage (the .bat files do this for you):
    python dream.py            -> full render using settings.ini [render]
    python dream.py --preview  -> short low-res test using settings.ini [preview]

Rendering is chunked (segment_seconds). If it is interrupted, just run it again:
finished segments are kept and it resumes where it stopped.
"""
import os, re, sys, math, time, shutil, argparse, subprocess, configparser
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
    c["warp"] = parse_warp(cp["warp"]) if cp.has_section("warp") else None   # None = the classic zoom_rate/rotate_rate warp
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


# ----------------------------------------------------------------------------- warp stack
# The [warp] section of settings.ini: motion modules applied top to bottom. Each one only moves the sampling
# coordinates, so a frame is still resampled once however many there are. The maths matches the Motion tab's
# live preview (editor/warp.js); keep the two in step. Coordinates: y up, height -1..1, width -w/h..w/h.
# Rates are per second (divided by fps here), so 30 and 60 fps move the same.
WARP_PARAMS = {   # kind: [(param, min, max, default)], in the order the editor shows them
    "zoom": [("rate", -1.5, 1.5, .2), ("bend", -1, 2, 0)],
    "spin": [("rate", -1, 1, .1)],
    "drift": [("speed", 0, 1, .15), ("angle", -180, 180, 90)],
    "tilt": [("tx", -1, 1, 0), ("ty", -1, 1, .35), ("shear", -1, 1, 0)],
    "shake": [("amp", 0, .08, .015), ("rate", .2, 8, 1.5), ("roll", 0, .08, .01)],
    "swirl": [("rate", -3, 3, 1), ("size", .05, 2, .5), ("tail", 0, 1, .3)],
    "bulge": [("k", -3, 3, 1.2), ("size", .05, 1.5, .35), ("orbit", 0, 1.2, .5), ("speed", -3, 3, .6)],
    "mobius": [("k", -1.5, 1.5, .35), ("spin", -2, 2, .3), ("phase", -180, 180, 0)],
    "kaleido": [("n", 2, 16, 6), ("spin", -1, 1, .08), ("mix", 0, 1, 1)],
    "ripple": [("amp", 0, 2, .4), ("freq", .5, 20, 5), ("speed", -12, 12, 4), ("radial", 0, 1, 1), ("angle", -180, 180, 0)],
    "flow": [("amp", 0, 2, .4), ("scale", .3, 8, 1.6), ("speed", 0, 1.5, .2), ("detail", 0, 1, .35)],
    "melt": [("speed", -1, 1, .25), ("angle", -180, 180, -90), ("streaks", 1, 60, 12), ("vary", 0, 1, .7), ("wobble", 0, 2, .3)],
    "edge": [("amp", 0, 2, .6), ("angle", -180, 180, 90), ("reach", .5, 6, 2)],
}
WARP_CURVES = ("sine", "tri", "saw", "pulse", "noise", "ramp")
WARP_EDGES = ("reflect", "wrap", "smear")


def parse_warp(sec):
    """[warp] section -> dict(stack, edge, prism), or None when its stack is empty (then the classic warp is used).
    A value is a number, optionally followed by a motion curve:  swirl.rate = 1.2 ~ sine(period=12, depth=0.5)"""
    bad = lambda msg: sys.exit(f"settings.ini [warp]: {msg}")
    names = [n.strip().lower() for n in sec.get("stack", "").split(",") if n.strip()]
    if not names:
        return None
    edge = sec.get("edge", "reflect").strip().lower()
    if edge not in WARP_EDGES:
        bad(f"edge must be one of {', '.join(WARP_EDGES)}, not '{edge}'")
    stack = []
    for name in names:
        kind = name.rstrip("0123456789")          # zoom2 = a second zoom module
        if kind not in WARP_PARAMS:
            bad(f"unknown module '{name}' in stack (known: {', '.join(WARP_PARAMS)})")
        if sec.get(f"{name}.on", "yes").strip().lower() in ("no", "off", "false", "0"):
            continue
        params = []
        for k, lo, hi, d in WARP_PARAMS[kind]:
            raw = sec.get(f"{name}.{k}", str(d)).strip()
            m = re.fullmatch(r"(-?[\d.]+(?:e-?\d+)?)\s*(?:~\s*([a-z]+)\s*\(([^)]*)\))?", raw)
            if not m:
                bad(f"{name}.{k} = {raw} is not a number (optionally followed by ~ sine(period=..., depth=...))")
            curve = None
            if m.group(2):
                if m.group(2) not in WARP_CURVES:
                    bad(f"{name}.{k}: curve must be one of {', '.join(WARP_CURVES)}, not '{m.group(2)}'")
                curve = dict(shape=m.group(2), period=8.0, depth=0.5, phase=0.0)
                for part in filter(None, (s.strip() for s in m.group(3).split(","))):
                    a, _, b = part.partition("=")
                    if a.strip() not in ("period", "depth", "phase"):
                        bad(f"{name}.{k}: unknown curve setting '{a.strip()}'")
                    curve[a.strip()] = float(b)
                curve["period"] = max(curve["period"], 0.05)
            params.append((float(m.group(1)), lo, hi, curve))
        pivot = [float(v) for v in sec.get(f"{name}.pivot", "0, 0").split(",")]
        where = sec.get(f"{name}.where", "").split()   # e.g. "near 0.6 soft 0.4" / "away 0.5 soft 0.3"
        mode = {"near": 1, "away": 2}.get(where[0], 0) if where else 0
        radius = float(where[1]) if len(where) > 1 else .6
        soft = float(where[3]) if len(where) > 3 else .4
        stack.append(dict(kind=kind, params=params, pivot=pivot[:2] + [0.0] * (2 - len(pivot)), where=(mode, radius, soft)))
    return dict(stack=stack, edge=edge, prism=float(sec.get("prism", "0")))


def _frac(x):
    return x - math.floor(x)


def _vnoise1(x):   # smooth random wander for the "noise" motion curve
    i = math.floor(x); f = x - i; u = f * f * (3 - 2 * f)
    h = lambda n: _frac(math.sin(n * 127.1 + 11.3) * 43758.5453)
    return h(i) * (1 - u) + h(i + 1) * u


def curve_value(p, t, total):
    """A parameter's value at time t: base plus its motion curve, clamped to the parameter's range."""
    v, lo, hi, cv = p
    if cv:
        x = t / cv["period"] + cv["phase"]
        s = cv["shape"]
        if s == "ramp":
            u = min(1.0, max(0.0, t / total)) if total > 0 else 1.0
            v += cv["depth"] * (hi - lo) * u * u * (3 - 2 * u)
        else:
            w = {"sine": lambda: math.sin(2 * math.pi * x), "tri": lambda: 1 - 4 * abs(_frac(x + .25) - .5),
                 "saw": lambda: 2 * _frac(x) - 1, "pulse": lambda: math.tanh(4 * math.sin(2 * math.pi * x)) / math.tanh(4),
                 "noise": lambda: 2 * _vnoise1(x * 2 + cv["phase"] * 17) - 1}[s]()
            v += cv["depth"] * (hi - lo) / 2 * w
    return min(hi, max(lo, v))


def _tfrac(x):
    return x - torch.floor(x)


def _h13(x, y, z):   # the preview shader's hash, so the noise-driven motions match it
    x, y, z = _tfrac(x * .1031), _tfrac(y * .1031), _tfrac(z * .1031)
    d = x * (z + 31.32) + y * (y + 31.32) + z * (x + 31.32)
    return _tfrac((x + d + y + d) * (z + d))


def _vn3(x, y, z):
    dev = next((v.device for v in (x, y, z) if torch.is_tensor(v)), "cpu")
    x, y, z = torch.broadcast_tensors(*(v if torch.is_tensor(v) else torch.tensor(float(v), device=dev) for v in (x, y, z)))
    ix, iy, iz = torch.floor(x), torch.floor(y), torch.floor(z)
    fx, fy, fz = x - ix, y - iy, z - iz
    fx, fy, fz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)
    h = lambda a, b, c: _h13(ix + a, iy + b, iz + c)
    lerp = torch.lerp
    return lerp(lerp(lerp(h(0, 0, 0), h(1, 0, 0), fx), lerp(h(0, 1, 0), h(1, 1, 0), fx), fy),
                lerp(lerp(h(0, 0, 1), h(1, 0, 1), fx), lerp(h(0, 1, 1), h(1, 1, 1), fx), fy), fz)


def _vn1(x):
    return float(_vn3(torch.tensor(float(x)), torch.tensor(.37), torch.tensor(.71)))


def _rot(x, y, a):
    c, s = math.cos(a), math.sin(a)
    return c * x - s * y, s * x + c * y


def _sample(img, x, y, edge, mode):
    """Read img at coordinates (x, y) (y up), folding positions outside the frame as the edge setting says."""
    h, w = img.shape[-2:]
    u, v = x / (w / h) * .5 + .5, y * .5 + .5
    if edge == "reflect":
        u, v = 1 - torch.abs(1 - torch.remainder(u, 2)), 1 - torch.abs(1 - torch.remainder(v, 2))
    elif edge == "wrap":
        u, v = _tfrac(u), _tfrac(v)
    else:
        u, v = u.clamp(0, 1), v.clamp(0, 1)
    grid = torch.stack([u * 2 - 1, 1 - v * 2], -1)[None].to(img.dtype)
    return F.grid_sample(img, grid, mode=mode, padding_mode="border", align_corners=False)


def warp_stack(img, t, warp_cfg, dt, total, mode="bilinear"):
    """One frame of the [warp] stack: move the sampling grid through every module, then resample once."""
    h, w = img.shape[-2:]
    a = w / h
    dev = img.device
    ys = 1 - (torch.arange(h, device=dev, dtype=torch.float32) + .5) / h * 2
    xs = ((torch.arange(w, device=dev, dtype=torch.float32) + .5) / w * 2 - 1) * a
    y, x = torch.meshgrid(ys, xs, indexing="ij")
    edge, lum = warp_cfg["edge"], None
    k30 = 30 * dt    # per-frame clamps were tuned at 30 fps
    for m in warp_cfg["stack"]:
        v = [curve_value(p, t, total) for p in m["params"]]
        kind, (cx, cy) = m["kind"], m["pivot"][:2]
        dx, dy = x - cx, y - cy
        r2 = dx * dx + dy * dy
        r = torch.sqrt(r2)
        qx, qy = x, y
        if kind == "zoom":
            s = torch.exp(-v[0] * dt * (1 + v[1] * r2)); qx, qy = cx + dx * s, cy + dy * s
        elif kind == "spin":
            qx, qy = _rot(dx, dy, -v[0] * dt); qx, qy = cx + qx, cy + qy
        elif kind == "drift":
            an = math.radians(v[1]); qx, qy = x - math.cos(an) * v[0] * dt, y - math.sin(an) * v[0] * dt
        elif kind == "tilt":
            s = torch.clamp(1 + dt * 2 * (v[0] * dx + v[1] * dy), min=.2)
            qx, qy = cx + (dx + v[2] * dt * 2 * dy) / s, cy + dy / s
        elif kind == "shake":   # position jitter: the frame-to-frame difference of a smooth wander, so it never drifts off
            k, k0 = t * v[1], (t - dt) * v[1]
            jx, jy = (_vn1(k) - _vn1(k0)) * 2 * v[0], (_vn1(k + 17.3) - _vn1(k0 + 17.3)) * 2 * v[0]
            rr = (_vn1(k + 41) - _vn1(k0 + 41)) * 2 * v[2]
            qx, qy = _rot(x, y, -rr); qx, qy = qx + jx, qy + jy
        elif kind == "swirl":
            s2 = v[1] * v[1]
            turn = -v[0] * dt * torch.lerp(torch.exp(-r2 / s2), 1 / (1 + r2 / s2), v[2])
            c, s = torch.cos(turn), torch.sin(turn); qx, qy = cx + c * dx - s * dy, cy + s * dx + c * dy
        elif kind == "bulge":
            ox, oy = cx + v[2] * math.cos(v[3] * t), cy + v[2] * math.sin(v[3] * t)
            ex, ey = x - ox, y - oy
            s = torch.exp(-v[0] * dt * torch.exp(-(ex * ex + ey * ey) / (v[1] * v[1]))); qx, qy = ox + ex * s, oy + ey * s
        elif kind == "mobius":   # infinitesimal Moebius flow toward a turning pole
            ph = math.radians(v[2]) + v[1] * t; gx, gy = v[0] * math.cos(ph), v[0] * math.sin(ph)
            zx, zy = dx * dx - dy * dy, 2 * dx * dy
            vx, vy = (gx * zx - gy * zy) * dt, (gx * zy + gy * zx) * dt
            L = torch.sqrt(vx * vx + vy * vy); f = torch.clamp(.08 * k30 / (L + 1e-12), max=1)
            qx, qy = x - vx * f, y - vy * f
        elif kind == "kaleido":
            n = max(math.floor(v[0] + .5), 1); sp = v[1] * t; seg = 2 * math.pi / n
            an = torch.abs(torch.remainder(torch.atan2(dy, dx) - sp, seg) - seg / 2) + sp
            qx, qy = torch.lerp(x, cx + r * torch.cos(an), v[2]), torch.lerp(y, cy + r * torch.sin(an), v[2])
        elif kind == "ripple":
            an = math.radians(v[4]); lx, ly = math.cos(an), math.sin(an)
            big = r > 1e-4
            rx, ry = torch.where(big, dx / r.clamp(min=1e-4), torch.full_like(r, lx)), torch.where(big, dy / r.clamp(min=1e-4), torch.full_like(r, ly))
            vx, vy = torch.lerp(torch.full_like(r, lx), rx, v[3]), torch.lerp(torch.full_like(r, ly), ry, v[3])
            L = torch.sqrt(vx * vx + vy * vy).clamp(min=1e-4); vx, vy = vx / L, vy / L
            s = torch.lerp(dx * lx + dy * ly, r, v[3])
            push = v[0] * dt * torch.sin(math.pi * v[1] * s - v[2] * t)
            qx, qy = x + vx * push, y + vy * push
        elif kind == "flow":   # curl of a noise field: swirling currents that neither compress nor spread
            sc, e = v[1], .04 / v[1]
            psi = lambda px, py: _vn3(px * sc, py * sc, t * v[2]) + v[3] * .5 * _vn3(px * sc * 2.3 + 7.1, py * sc * 2.3 + 7.1, t * v[2] * 1.7 + 3.3)
            gx, gy = psi(x + e, y) - psi(x - e, y), psi(x, y + e) - psi(x, y - e)
            qx, qy = x + gy / (2 * e) / sc * v[0] * dt, y - gx / (2 * e) / sc * v[0] * dt
        elif kind == "melt":
            an = math.radians(v[1]); ux, uy = math.cos(an), math.sin(an)
            u = (x * -uy + y * ux) * v[2] * .5
            s = 1 + v[3] * 1.8 * (_vn3(u, (x * ux + y * uy) * .8, t * v[4]) - .5)
            qx, qy = x - ux * v[0] * dt * s, y - uy * v[0] * dt * s
        elif kind == "edge":   # pixels slide along (or across) the picture's own brightness contours
            if lum is None:
                lum = (img * torch.tensor([.3, .59, .11], device=dev, dtype=img.dtype).view(1, 3, 1, 1)).sum(1, keepdim=True)
            e = v[2] * 2 / 288      # edge width in pixels of a 288-line frame, the preview's size
            L = lambda px, py: _sample(lum, px, py, edge, "bilinear")[0, 0].float()
            gx, gy = (L(x + e, y) - L(x - e, y)) / (2 * e), (L(x, y + e) - L(x, y - e)) / (2 * e)
            vx, vy = _rot(gx, gy, math.radians(v[1]))
            vx, vy = vx * v[0] * dt * .08, vy * v[0] * dt * .08
            n = torch.sqrt(vx * vx + vy * vy); f = torch.clamp(.03 * k30 / (n + 1e-12), max=1)
            qx, qy = x + vx * f, y + vy * f
        wmode, radius, soft = m["where"]
        if wmode:   # limit the module to a ring around its pivot (near) or to everything outside it (away)
            lo, hi = radius * (1 - soft), radius * (1 + soft) + 1e-3
            tt = ((r - lo) / (hi - lo)).clamp(0, 1)
            inside = 1 - tt * tt * (3 - 2 * tt)
            wt = inside if wmode == 1 else 1 - inside
            qx, qy = torch.lerp(x, qx, wt), torch.lerp(y, qy, wt)
        x, y = qx, qy
    prism = warp_cfg["prism"] * k30
    if prism <= 0:
        return _sample(img, x, y, edge, mode)
    r_ = _sample(img[:, 0:1], x * (1 + prism), y * (1 + prism), edge, mode)   # red and blue zoom slightly apart
    b_ = _sample(img[:, 2:3], x * (1 - prism), y * (1 - prism), edge, mode)
    return torch.cat([r_, _sample(img[:, 1:2], x, y, edge, mode), b_], 1)


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
        if c["warp"] is not None:      # the motion stack from [warp]
            ang = 0.0
            img = warp_stack(img, t, c["warp"], 1.0 / fps, c["seconds"], c["resample"])
        else:                          # classic: zoom_rate plus the rotate_rate wobble
            ang = c["rotate_rate"] * math.sin(t * 0.3) / fps * 6
            dx, dy = 0.01 * math.sin(t * 0.7) / fps * 6, 0.01 * math.cos(t * 0.5) / fps * 6
            img = warp(img, self.zoom, ang, dx, dy, c["resample"])
        rec("warp", img)
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
    if c["warp"] is not None:
        print("Motion:", " + ".join(m["kind"] for m in c["warp"]["stack"]) or "none (empty stack)")
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
