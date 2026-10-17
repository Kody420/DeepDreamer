"""
Feed: new material for the dream to grow, the [feed] section of settings.ini (the editor's Feed tab).

Every frame the motion stack moves the picture, then each feed module adds something the network can build on:

  grain     random values drawn at the size the network looks at (or per pixel, the old "noise"), optionally
            held for a while so the dream can grab them, optionally carried along with the picture (lock = world)
  colour    large, slow patches of colour that leave brightness alone
  marble    domain-warped fractal noise: veins, folds and contours
  turing    a small reaction-diffusion simulation (spots that split, worms, mazes) running beside the dream
  seeds     sparse dots, rings and eyes dropped at a set rate, for the network to finish
  mirror    pulls the picture toward its own mirror image, so creatures face the camera more often
  reseed    now and then replaces a soft disc with fresh noise, the way the video starts
  pictures  now and then dissolves one of your pictures into a soft disc

Amounts are per frame at 30 fps and scaled for other frame rates, so 30 and 60 fps get the same feed.
Additive modules (grain, colour, marble, turing) add a field with standard deviation 1 times the amount; their
"where" mask keeps the same total amount and concentrates it. Values take motion curves like [warp].

The picture is y up, height -1..1, width -w/h..w/h, as in the motion stack.
Keep FEED_PARAMS and FEED_TEXT in step with editor/feed.js.
"""
import math, os
from types import SimpleNamespace as Ops   # dream.py hands in its helpers: sample, vn3, make_seed, curve, edge
import torch
import torch.nn.functional as F

FEED_PARAMS = {   # kind: [(param, min, max, default)], in the order the editor shows them
    "grain": [("amount", 0, .05, .006), ("life", 0, 10, 1.5), ("size", .005, .3, .04)],
    "colour": [("amount", 0, .05, .008), ("size", .05, 1, .3), ("life", .2, 20, 3)],
    "marble": [("amount", 0, .05, .006), ("scale", .3, 8, 1.6), ("speed", 0, 1.5, .15), ("fold", 0, 3, 1.5)],
    "turing": [("amount", 0, .05, .005), ("size", .01, .15, .04), ("speed", 0, 4, 1)],
    "seeds": [("rate", 0, 20, 3), ("size", .01, .25, .05), ("strength", 0, 1, .35), ("life", .1, 3, .6)],
    "mirror": [("amount", 0, 1, .15), ("angle", -180, 180, 90)],
    "reseed": [("every", .5, 60, 8), ("size", .05, 1.5, .3), ("amount", 0, 1, .7), ("fade", 0, 3, .5)],
    "pictures": [("every", .5, 60, 6), ("size", .05, 1.5, .4), ("amount", 0, 1, .3), ("fade", 0, 3, 1)],
}
FEED_TEXT = {   # text keys: allowed values, the first is the default; a single value = free text with that default
    "grain": {"grid": ("matched", "pixel", "size"), "lock": ("screen", "world")},
    "colour": {"lock": ("screen", "world")},
    "marble": {"lock": ("screen", "world")},
    "turing": {"pattern": ("spots", "worms", "maze"), "lock": ("screen", "world")},
    "seeds": {"shape": ("mixed", "dots", "rings", "eyes")},
    "pictures": {"folder": ("init_images",)},
}
ADDITIVE = ("grain", "colour", "marble", "turing")
TURING = {"spots": (.0367, .0649), "worms": (.078, .061), "maze": (.029, .057)}   # Gray-Scott feed and kill rates
PICTURE_EXT = (".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff")


def picture_files(folder, here):
    """The pictures a Pictures module cycles through, in name order."""
    if not os.path.isabs(folder):
        folder = os.path.join(here, folder)
    if not os.path.isdir(folder):
        return []
    return sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(PICTURE_EXT))


def _smooth(t):
    t = t.clamp(0, 1)
    return t * t * (3 - 2 * t)


def _unit(f):
    return f / (f.std() + 1e-6)


class Feed:
    def __init__(self, cfg, c, dev, ops):
        self.mods, self.c, self.dev, self.ops = cfg["stack"], c, dev, ops
        self.fps, self.dt = c["fps"], 1.0 / c["fps"]
        self.gen = torch.Generator(device=dev).manual_seed(c["seed"] * 7919 + 101)       # noise fields
        self.cgen = torch.Generator(device="cpu").manual_seed(c["seed"] * 7919 + 202)    # seeds, choices
        self.st = [dict() for _ in self.mods]       # each module's own state (held fields, seeds, simulations)
        self.needs_activity = any(m["where"][0] == 3 for m in self.mods)
        self.h = self.w = None

    # ---------------------------------------------------------------- helpers
    def _setup(self, h, w):
        self.h, self.w, self.a = h, w, w / h
        ys = 1 - (torch.arange(h, device=self.dev, dtype=torch.float32) + .5) / h * 2
        xs = ((torch.arange(w, device=self.dev, dtype=torch.float32) + .5) / w * 2 - 1) * self.a
        self.y, self.x = torch.meshgrid(ys, xs, indexing="ij")
        self.masks = {}

    def _randn(self, *shape):
        return torch.randn(*shape, generator=self.gen, device=self.dev)

    def _up(self, f, mode="bicubic"):
        return F.interpolate(f, size=(self.h, self.w), mode=mode, align_corners=False)

    def _grid(self, rows):
        """A low-resolution grid with the frame's aspect ratio."""
        rows = max(2, int(round(rows)))
        return rows, max(2, int(round(rows * self.a)))

    def _vals(self, m, t):
        return [self.ops.curve(p, t, self.c["seconds"]) for p in m["params"]]

    def _mask(self, m, activity, unit):
        """The module's where-mask (None = everywhere). unit=True rescales it to the same total amount."""
        mode, radius, soft = m["where"]
        if mode == 0:
            return None
        if mode == 3:   # idle: where the dream changed the picture least last frame
            if activity is None:
                return None
            a = activity / (activity.mean() + 1e-8)
            mk = self._up((1 - a / 1.5).clamp(0, 1), "bilinear")[0, 0]
        else:
            key = (m["name"], mode, radius, soft, tuple(m["pivot"]))
            mk = self.masks.get(key)
            if mk is None:
                r = torch.sqrt((self.x - m["pivot"][0]) ** 2 + (self.y - m["pivot"][1]) ** 2)
                lo, hi = radius * (1 - soft), radius * (1 + soft) + 1e-3
                inside = 1 - _smooth((r - lo) / (hi - lo))
                mk = self.masks[key] = inside if mode == 1 else 1 - inside
        if unit:
            mk = mk / (mk.pow(2).mean().sqrt() + 1e-6)
            mk = mk.clamp(max=3.0)
        return mk

    def _hold(self, st, field, carry, world):
        """World lock: keep the field and carry it with the picture, mixing a little fresh in each frame."""
        if not world:
            return field
        lam = math.exp(-self.dt / 0.6)
        w = st.get("w")
        w = field if w is None else lam * carry(w) + (1 - lam) * field
        st["w"] = w
        return _unit(w)

    # ---------------------------------------------------------------- sources
    def _grain_fresh(self, grid, size):
        h, w = self.h, self.w
        if grid == "pixel":
            return self._randn(1, 3, h, w)
        if grid == "size":
            sizes = [size]
        else:   # matched: one draw per painting size, at the resolution the network looks at it
            sizes = [1.0 / (h * s) for s in self.c["scales"]]
        n = sum(self._up(self._randn(1, 3, *self._grid(1.0 / s))) for s in sizes)
        return _unit(n)

    def _grain(self, m, st, v, carry):
        amount, life, size = v
        world = m["text"]["lock"] == "world"
        rho = math.exp(-self.dt / life) if life > self.dt / 2 else 0.0
        if world:
            rho = max(rho, math.exp(-self.dt / 0.3))   # world-locked grain has to live long enough to be carried
        fresh = self._grain_fresh(m["text"]["grid"], size)
        n = st.get("n")
        if n is None or rho == 0:
            n = fresh
        else:
            n = rho * (carry(n) if world else n) + math.sqrt(1 - rho * rho) * fresh
            if world:
                n = _unit(n)   # carrying blurs it a little each frame
        st["n"] = n
        return n, rho > 0

    def _colour(self, m, st, v, carry):
        amount, size, life = v
        rows, cols = self._grid(1.0 / m["params"][1][0])   # grid from the set size; a curve on size can't resize it
        g = st.get("g")
        if g is None or g.shape[-2:] != (rows, cols):
            g = self._randn(1, 2, rows, cols)
        rho = math.exp(-self.dt / life)
        g = rho * g + math.sqrt(1 - rho * rho) * self._randn(1, 2, rows, cols)
        st["g"] = g
        u = self._up(g)
        a1 = torch.tensor([.7071, -.7071, 0], device=self.dev).view(1, 3, 1, 1)    # both perpendicular to grey
        a2 = torch.tensor([.4082, .4082, -.8165], device=self.dev).view(1, 3, 1, 1)
        return self._hold(st, _unit(u[:, :1] * a1 + u[:, 1:] * a2), carry, m["text"]["lock"] == "world"), True

    def _marble(self, m, st, v, t, carry):
        amount, scale, speed, fold = v
        vn3 = self.ops.vn3
        rows, cols = self._grid(self.h / 4)
        y = torch.linspace(1, -1, rows, device=self.dev).view(-1, 1).expand(rows, cols) * scale
        x = torch.linspace(-self.a, self.a, cols, device=self.dev).view(1, -1).expand(rows, cols) * scale
        tt = t * speed

        def fbm(px, py, z):
            s, a = 0, .5
            for _ in range(4):
                s = s + a * vn3(px, py, z); px, py, z, a = px * 2.03, py * 2.03, z * 1.6, a * .5
            return s
        q1, q2 = fbm(x, y, tt) - .47, fbm(x + 5.2, y + 1.3, tt) - .47
        lum = fbm(x + fold * 4 * q1, y + fold * 4 * q2, tt * .7 + 3)
        f = torch.stack([lum, lum + .5 * q1, lum + .5 * q2])[None]
        f = f - f.mean((2, 3), keepdim=True)
        return self._hold(st, _unit(self._up(f, "bilinear")), carry, m["text"]["lock"] == "world"), True

    def _turing(self, m, st, v, carry):
        amount, size, speed = v
        if "U" not in st:
            rows, cols = self._grid(6.0 / m["params"][1][0])
            U, V = torch.ones(1, 1, rows, cols, device=self.dev), torch.zeros(1, 1, rows, cols, device=self.dev)
            self._sprinkle(U, V, max(4, rows * cols // 400))
            st.update(U=U, V=V, acc=0.0)
            for _ in range(400):
                self._gs(st, m["text"]["pattern"])
        st["acc"] += speed * 8 * 30 / self.fps          # updates per frame, the same per second at any fps
        while st["acc"] >= 1:
            self._gs(st, m["text"]["pattern"]); st["acc"] -= 1
        if float(st["V"].mean()) < .005:                 # died out: start a few new spots
            self._sprinkle(st["U"], st["V"], 6)
        return self._hold(st, _unit((self._up(st["V"]) - st["V"].mean()).expand(1, 3, -1, -1)), carry, m["text"]["lock"] == "world"), True

    def _sprinkle(self, U, V, n):
        rows, cols = U.shape[-2:]
        for _ in range(n):
            cy, cx = [int(v) for v in (torch.rand(2, generator=self.cgen) * torch.tensor([rows, cols])).tolist()]
            r = 2 + int(torch.randint(0, 3, (1,), generator=self.cgen))
            ys, xs = [i % rows for i in range(cy - r, cy + r + 1)], [i % cols for i in range(cx - r, cx + r + 1)]
            for yy in ys:
                U[0, 0, yy, xs] = .5; V[0, 0, yy, xs] = .25

    def _gs(self, st, pattern):
        """One Gray-Scott update (Karl Sims' form), wrapping at the edges."""
        f, k = TURING[pattern]
        lap_k = torch.tensor([[.05, .2, .05], [.2, -1, .2], [.05, .2, .05]], device=self.dev).view(1, 1, 3, 3)
        U, V = st["U"], st["V"]
        lap = lambda Z: F.conv2d(F.pad(Z, (1, 1, 1, 1), mode="circular"), lap_k)
        uvv = U * V * V
        st["U"] = (U + 1.0 * lap(U) - uvv + f * (1 - U)).clamp(0, 1)
        st["V"] = (V + .5 * lap(V) + uvv - (f + k) * V).clamp(0, 1)

    def _seeds(self, m, st, v, t, activity):
        rate, size, strength, life = v
        seeds = st.setdefault("seeds", [])
        n = int(torch.poisson(torch.tensor([rate * self.dt]), generator=self.cgen))
        shapes = {"dots": [0], "rings": [1], "eyes": [2], "mixed": [0, 1, 2]}[m["text"]["shape"]]
        mk = self._mask(m, activity, unit=False)
        for _ in range(n):
            for _try in range(20):   # rejection sampling against the where-mask
                u = torch.rand(3, generator=self.cgen).tolist()
                px, py = (u[0] * 2 - 1) * self.a * .95, (u[1] * 2 - 1) * .95
                if mk is None:
                    break
                iy = min(self.h - 1, int((1 - py) / 2 * self.h)); ix = min(self.w - 1, int((px / self.a + 1) / 2 * self.w))
                if u[2] < float(mk[iy, ix]):
                    break
            else:
                continue
            col = (torch.rand(3, generator=self.cgen) * .4 + .6) * torch.sign(torch.rand(3, generator=self.cgen) - .5)
            seeds.append(dict(x=px, y=py, r=size * (.6 + .8 * float(torch.rand(1, generator=self.cgen))), t0=t, life=life,
                              kind=shapes[int(torch.randint(0, len(shapes), (1,), generator=self.cgen))], col=col.tolist()))
        seeds[:] = [s for s in seeds if t - s["t0"] < s["life"]]
        if not seeds:
            return None
        rows, cols = self._grid(min(self.h, 360))
        y = torch.linspace(1, -1, rows, device=self.dev).view(-1, 1)
        x = torch.linspace(-self.a, self.a, cols, device=self.dev).view(1, -1)
        f = torch.zeros(1, 3, rows, cols, device=self.dev)
        for s in seeds:   # each seed adds `strength` in total over its life: a sine bump spread over life * fps frames
            env = math.sin(math.pi * (t - s["t0"]) / s["life"]) * math.pi / 2 / (s["life"] * self.fps)
            d = torch.sqrt((x - s["x"]) ** 2 + (y - s["y"]) ** 2) / s["r"]
            dot, ring = torch.exp(-2.5 * d * d), torch.exp(-((d - 1) / .3) ** 2)
            p = dot if s["kind"] == 0 else ring if s["kind"] == 1 else ring - 1.3 * torch.exp(-12 * d * d)
            f += strength * env * p * torch.tensor(s["col"], device=self.dev).view(1, 3, 1, 1)
        return self._up(f, "bilinear")

    def _mirror(self, m, img, v, activity):
        amount, angle = v
        an = math.radians(angle); ux, uy = math.cos(an), math.sin(an)
        dx, dy = self.x - m["pivot"][0], self.y - m["pivot"][1]
        dd = dx * ux + dy * uy                      # reflect across the line through the pivot at `angle`
        rx, ry = 2 * dd * ux - dx + m["pivot"][0], 2 * dd * uy - dy + m["pivot"][1]
        k = 1 - (1 - min(amount, .999)) ** self.dt  # `amount` of the way per second
        mk = self._mask(m, activity, unit=False)
        k = k if mk is None else k * mk
        return torch.lerp(img, self.ops.sample(img, rx, ry, self.ops.edge, "bilinear"), k)

    def _event(self, m, st, img, v, t):
        """Reseed and pictures: every `every` seconds, mix a new picture into a soft disc at the pivot."""
        every = max(.5, m["params"][0][0])          # the set value, so a curve can't skip or repeat events
        _, size, amount, fade = v
        n = int(t / every)
        if n < 1 or t - n * every >= max(fade, self.dt * .99):
            return img
        if st.get("n") != n or "src" not in st:   # (a resumed render reloads the picture)
            if m["kind"] == "reseed":
                src = self.ops.make_seed(self.h, self.w, self.dev, self.c["seed"] + 7777 + n, "")
            else:
                files = m["files"]
                src = self.ops.make_seed(self.h, self.w, self.dev, 0, files[(n - 1) % len(files)])
            st.update(n=n, src=src)
        r = torch.sqrt((self.x - m["pivot"][0]) ** 2 + (self.y - m["pivot"][1]) ** 2)
        disc = 1 - _smooth((r - size * .6) / (size * .8))
        k = 1 - (1 - min(amount, .999)) ** (self.dt / fade) if fade > self.dt else amount
        return torch.lerp(img, st["src"], k * disc)

    # ---------------------------------------------------------------- the frame
    def apply(self, img, t, carry, activity=None):
        """Add this frame's feed to the moved picture. carry(x) moves x the way the picture moved this frame."""
        if self.h != img.shape[-2] or self.w != img.shape[-1]:
            self._setup(*img.shape[-2:])
        for m, st in zip(self.mods, self.st):
            v = self._vals(m, t)
            kind = m["kind"]
            if kind in ADDITIVE:
                if kind == "grain":
                    f, held = self._grain(m, st, v, carry)
                elif kind == "colour":
                    f, held = self._colour(m, st, v, carry)
                elif kind == "marble":
                    f, held = self._marble(m, st, v, t, carry)
                else:
                    f, held = self._turing(m, st, v, carry)
                # a held field is added again every frame, so it scales with 1/fps; fresh noise adds up like a
                # random walk, so it scales with 1/sqrt(fps)
                k = 30 / self.fps if held else math.sqrt(30 / self.fps)
                mk = self._mask(m, activity, unit=True)
                img = img + v[0] * k * (f if mk is None else f * mk)
            elif kind == "seeds":
                f = self._seeds(m, st, v, t, activity)
                if f is not None:
                    img = img + f
            elif kind == "mirror":
                img = self._mirror(m, img, v, activity)
            else:
                img = self._event(m, st, img, v, t)
        return img

    def describe(self, h, w):
        """One line per module for the log, with how much of an additive module the network actually receives
        at its smallest painting size (the shrink before the network averages fine noise away)."""
        self._setup(h, w)
        out, s = [], min(self.c["scales"])
        for m in self.mods:
            v = [p[0] for p in m["params"]]
            label = m["name"] + "".join(f" {m['text'][k]}" for k in m["text"] if k != "folder")
            if m["where"][0]:
                label += " " + ("near", "away", "idle")[m["where"][0] - 1]
            if m["kind"] == "grain":
                f = self._grain_fresh(m["text"]["grid"], v[2])
                g = F.interpolate(f, scale_factor=s, mode="bilinear", antialias=True, align_corners=False)
                label += f" {v[0]:g} ({float(g.std() / f.std()) * 100:.0f}% reaches the network at scale {s:g})"
            elif m["kind"] in ADDITIVE:
                label += f" {v[0]:g}"
            elif m["kind"] == "pictures":
                label += f" ({len(m['files'])} pictures)"
            out.append(label)
        self.h = None   # set up again on the first frame
        return out

    # ---------------------------------------------------------------- resume
    def state_dict(self):
        def cpu(v):
            return v.half().cpu() if torch.is_tensor(v) and v.is_floating_point() and v.dim() > 1 else v
        return dict(gen=self.gen.get_state(), cgen=self.cgen.get_state(),
                    st=[{k: cpu(v) for k, v in s.items() if k != "src"} for s in self.st])

    def load_state_dict(self, d):
        self.gen.set_state(d["gen"]); self.cgen.set_state(d["cgen"])
        if len(d["st"]) == len(self.st):
            self.st = [{k: v.float().to(self.dev) if torch.is_tensor(v) and v.is_floating_point() and v.dim() > 1 else v
                        for k, v in s.items()} for s in d["st"]]
