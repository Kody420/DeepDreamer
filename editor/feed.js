"use strict";
// The Feed tab: a stack of feed modules (the [feed] section of settings.ini) that add new material for the dream
// every frame, with a preview of what they do and how much of it the network actually receives. The preview runs
// the feed alone on a 2D canvas, on a stand-in picture, without motion and without a network; dream.py (feed.py)
// does the real thing. Keep MODS in step with FEED_PARAMS and FEED_TEXT in feed.py, and the maths with feed.py.
//
// index.html mounts it with   FeedLab.mount({ root, side, get, saved, set, render, motion, toast })
// (root: the stack, in the settings window; side: the preview, in the monitor on the right; motion() gives the
// Motion tab's module names) and calls sync() whenever cur.feed may have changed from outside, show() on tab switches.
window.FeedLab = (() => {
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fract = x => x - Math.floor(x);
const decimals = st => { const s = String(st); return s.includes(".") ? s.split(".")[1].length : 0; };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const DT = 1 / 30, PH = 144, MAXM = 8;
let A = 16 / 9, PW = 256;

// ----------------------------------------------------------------------------- catalog
// still: the render reads this setting once (it sizes a grid or schedules events), so it takes no curve.
// when: the setting only matters in some modes, and is hidden otherwise.
const P = (k, label, min, max, step, def, unit = "", o = {}) => ({ k, label, min, max, step, def, unit, ...o });
const LOCK = ["lock", "Attached to", [["screen", "Screen"], ["world", "World (moves with the picture)"]]];
const MODS = [
  { key: "grain", name: "Grain", fam: "Noise", blurb: "Random values the network can see: drawn at its painting sizes, held a while so the dream can grab them.",
    params: [P("amount", "Amount", 0, .05, .0005, .006), P("life", "Life", 0, 10, .05, 1.5, "s"), P("size", "Size", .005, .3, .001, .04, "", { when: m => m.text.grid === "size" })],
    text: [["grid", "Drawn at", [["matched", "Painting sizes"], ["pixel", "Every pixel (old noise)"], ["size", "Set size"]]], LOCK],
    init: { text: { lock: "world" }, mask: { mode: 1, radius: .45, soft: .6 } } },
  { key: "colour", name: "Colour patches", fam: "Noise", blurb: "Large, slow patches of colour that leave brightness alone. Borders to build separate things along.",
    params: [P("amount", "Amount", 0, .05, .0005, .008), P("size", "Patch size", .05, 1, .01, .3, "", { still: true }), P("life", "Life", .2, 20, .1, 3, "s")], text: [LOCK] },
  { key: "marble", name: "Marble", fam: "Noise", blurb: "Domain-warped fractal noise: veins, folds and contours, which the network reads as outlines.",
    params: [P("amount", "Amount", 0, .05, .0005, .006), P("scale", "Vein count", .3, 8, .05, 1.6), P("speed", "Change speed", 0, 1.5, .01, .15), P("fold", "Folding", 0, 3, .01, 1.5)], text: [LOCK] },
  { key: "turing", name: "Turing patterns", fam: "Noise", blurb: "A reaction–diffusion simulation runs beside the dream: spots that split, worms or mazes.",
    params: [P("amount", "Amount", 0, .05, .0005, .005), P("size", "Spot size", .01, .15, .001, .04, "", { still: true }), P("speed", "Speed", 0, 4, .01, 1)],
    text: [["pattern", "Pattern", [["spots", "Spots"], ["worms", "Worms"], ["maze", "Maze"]]], LOCK] },
  { key: "seeds", name: "Seeds", fam: "Things", blurb: "Dots, rings and dot-in-ring eyes dropped at a set rate, sized for the network to finish.",
    params: [P("rate", "Per second", 0, 20, .1, 3, "/s"), P("size", "Size", .01, .25, .001, .05), P("strength", "Strength", 0, 1, .01, .35), P("life", "Fade in/out", .1, 3, .05, .6, "s")],
    text: [["shape", "Shapes", [["mixed", "Mixed"], ["dots", "Dots"], ["rings", "Rings"], ["eyes", "Eyes"]]]] },
  { key: "mirror", name: "Mirror", fam: "Self", pivot: true, blurb: "Pulls the picture toward its own mirror image across a line through the pivot, so creatures face the camera.",
    params: [P("amount", "Pull", 0, 1, .01, .5, "/s"), P("angle", "Mirror line", -180, 180, 1, 90, "°", { wrap: true })] },
  { key: "reseed", name: "Reseed", fam: "Events", pivot: true, disc: true, blurb: "Every few seconds a soft disc at the pivot gets fresh noise, like the video's start. Each one starts a new chapter.",
    params: [P("every", "Every", .5, 60, .5, 8, "s", { still: true }), P("size", "Disc size", .05, 1.5, .01, .3), P("amount", "Amount", 0, 1, .01, .7), P("fade", "Fade in", 0, 3, .05, .5, "s")] },
  { key: "pictures", name: "Pictures", fam: "Events", pivot: true, disc: true, blurb: "Every few seconds one of your pictures dissolves into a soft disc at the pivot, for the dream to re-imagine.",
    params: [P("every", "Every", .5, 60, .5, 6, "s", { still: true }), P("size", "Disc size", .05, 1.5, .01, .4), P("amount", "Amount", 0, 1, .01, .3), P("fade", "Fade in", 0, 3, .05, 1, "s")],
    text: [["folder", "Folder", null, "init_images"]] },
];
MODS.forEach((m, i) => m.idx = i);
const BY = Object.fromEntries(MODS.map(m => [m.key, m]));
const FAMS = [["Noise", "fields the network can see"], ["Things", "shapes for it to finish"], ["Self", "made from the picture"], ["Events", "now and then"]];
const SHAPES = { none: "Off", sine: "Sine", tri: "Triangle", saw: "Saw", pulse: "Pulse", noise: "Wander", ramp: "Ramp over video" };
const WHERE = ["Everywhere", "Near pivot", "Away from pivot", "Where the dream is idle"];
const ADDITIVE = ["grain", "colour", "marble", "turing"];
const COLORS = ["#3fc6bd", "#f5d76e", "#f0a24a", "#a78bfa", "#ff6b6b", "#7dd3fc", "#86efac", "#f9a8d4"];
const RELAX = .012;   // the stand-in for the dream: each frame the preview picture eases this far back toward its start

// ----------------------------------------------------------------------------- state
let uid = 1, selId = 0, host = null, lastSig = null, lookIdx = -1;
const MODDEF = { shape: "none", period: 8, depth: .5, phase: 0 };
function M(key, vals = {}, mods = {}, text = {}, mask = null) {
  const d = BY[key], init = d.init || {};
  const m = { id: uid++, key, on: true, solo: false, open: true, vals: {}, mod: {}, ui: {}, pivot: [0, 0], text: {},
    mask: { mode: 0, radius: .6, soft: .4, ...(init.mask || {}), ...(mask || {}) } };
  d.params.forEach(p => { m.vals[p.k] = vals[p.k] ?? p.def; m.mod[p.k] = { ...MODDEF, ...(mods[p.k] || {}) }; });
  (d.text || []).forEach(([k, , opts, def]) => { m.text[k] = text[k] ?? init.text?.[k] ?? (opts ? opts[0][0] : def); });
  return m;
}
const S = { stack: [], view: 0, T: 20 };
const LOOKS = [
  ["Old noise", () => [M("grain", { amount: .001, life: 0 }, {}, { grid: "pixel", lock: "screen" }, { mode: 0 })]],
  ["Born at the centre", () => [M("grain", { amount: .006, life: 1.5 }, {}, { grid: "matched", lock: "world" }, { mode: 1, radius: .45, soft: .6 })]],
  ["Seeds", () => [M("seeds", { rate: 3, size: .06, strength: .35 })]],
  ["Colour weather", () => [M("colour", { amount: .008, size: .35, life: 4 }), M("grain", { amount: .004 }, {}, {}, { mode: 0 })]],
  ["Turing skin", () => [M("turing", { amount: .005, size: .05 })]],
  ["Marble veins", () => [M("marble", { amount: .006 }, {}, { lock: "world" })]],
  ["Turning mirror", () => [M("mirror", { amount: .5, angle: 90 }, { angle: { shape: "saw", period: 20, depth: 1 } }), M("grain", { amount: .004 })]],
  ["Chapters", () => [M("reseed", { every: 8, size: .35, amount: .8, fade: .6 }), M("grain", { amount: .004 })]],
  ["Restless", () => [M("grain", { amount: .006 }, { amount: { shape: "pulse", period: 6, depth: .15 } }, { lock: "world" }, { mode: 3 }),
    M("seeds", { rate: 2 }), M("colour", { amount: .006 })]],
];

function vnoise1(x) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f), h = n => fract(Math.sin(n * 127.1 + 11.3) * 43758.5453); return h(i) * (1 - u) + h(i + 1) * u; }
function wave(md, t) {
  const x = t / md.period + md.phase;
  switch (md.shape) {
    case "sine": return Math.sin(2 * Math.PI * x);
    case "tri": return 1 - 4 * Math.abs(fract(x + .25) - .5);
    case "saw": return 2 * fract(x) - 1;
    case "pulse": return Math.tanh(4 * Math.sin(2 * Math.PI * x)) / Math.tanh(4);
    case "noise": return 2 * vnoise1(x * 2 + md.phase * 17) - 1;
    case "ramp": { const u = clamp(t / S.T, 0, 1); return u * u * (3 - 2 * u); }
  }
  return 0;
}
// a setting's value at time t, as curve_value in dream.py; still settings ignore curves, as the render does,
// and angles (wrap) go round instead of stopping at the end of their range
function paramAt(m, p, t) {
  const md = m.mod[p.k]; let v = m.vals[p.k];
  if (md.shape !== "none" && !p.still) v += md.shape === "ramp" ? md.depth * (p.max - p.min) * wave(md, t) : md.depth * (p.max - p.min) / 2 * wave(md, t);
  if (p.wrap) { const r = p.max - p.min; return p.min + (((v - p.min) % r) + r) % r; }
  return clamp(v, p.min, p.max);
}
const active = () => { const on = S.stack.filter(m => m.on); const so = on.filter(m => m.solo); return so.length ? so : on; };
const usesPivot = m => BY[m.key].pivot || m.mask.mode === 1 || m.mask.mode === 2;
const shown = (m, p) => !p.when || p.when(m);

// ----------------------------------------------------------------------------- [feed] section <-> stack
const num = (v, st = .0001) => String(+(+v).toFixed(Math.min(4, Math.max(decimals(st), 2))));
function toDict() {
  const d = {}, counts = {}, names = S.stack.map(m => { counts[m.key] = (counts[m.key] || 0) + 1; return counts[m.key] > 1 ? m.key + counts[m.key] : m.key; });
  d.stack = names.join(", ");   // always written, even empty: an empty [feed] means no feed (old files' noise stays off)
  S.stack.forEach((m, i) => {
    const n = names[i];
    if (!m.on) d[`${n}.on`] = "no";
    for (const [k] of BY[m.key].text || []) d[`${n}.${k}`] = m.text[k];
    for (const p of BY[m.key].params) {
      const md = m.mod[p.k];
      const curve = md.shape === "none" || p.still ? "" : md.shape === "ramp" ? ` ~ ramp(depth=${num(md.depth)})`
        : ` ~ ${md.shape}(period=${num(md.period)}, depth=${num(md.depth)}${md.phase ? `, phase=${num(md.phase)}` : ""})`;
      d[`${n}.${p.k}`] = num(m.vals[p.k], p.step) + curve;
    }
    if (m.pivot[0] || m.pivot[1]) d[`${n}.pivot`] = `${num(m.pivot[0])}, ${num(m.pivot[1])}`;
    if (m.mask.mode === 3) d[`${n}.where`] = "idle";
    else if (m.mask.mode) d[`${n}.where`] = `${m.mask.mode === 1 ? "near" : "away"} ${num(m.mask.radius)} soft ${num(m.mask.soft)}`;
  });
  return d;
}
function fromDict(d) {
  const stack = [], unknown = [];
  for (const name of String(d.stack || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)) {
    const key = name.replace(/\d+$/, "");
    if (!BY[key]) { unknown.push(name); continue; }
    const m = M(key, {}, {}, {}, { mode: 0 });
    m.on = !/^(no|off|false|0)$/i.test(String(d[`${name}.on`] || "yes").trim());
    for (const p of BY[key].params) {
      const raw = String(d[`${name}.${p.k}`] ?? "").trim(); if (!raw) continue;
      const r = raw.match(/^(-?[\d.]+(?:e-?\d+)?)\s*(?:~\s*([a-z]+)\s*\(([^)]*)\))?$/i);
      if (!r) continue;
      m.vals[p.k] = clamp(+r[1], p.min, p.max);
      if (r[2] && SHAPES[r[2]] && !p.still) {
        const md = { ...MODDEF, shape: r[2] };
        for (const part of r[3].split(",")) { const [a, b] = part.split("=").map(s => s.trim()); if (a in md && a !== "shape" && isFinite(+b)) md[a] = +b; }
        m.mod[p.k] = md;
      }
    }
    for (const [k, , opts, def] of BY[key].text || []) {
      const v = String(d[`${name}.${k}`] ?? "").trim();
      m.text[k] = opts ? (opts.some(o => o[0] === v.toLowerCase()) ? v.toLowerCase() : opts[0][0]) : (v || def);
    }
    const pv = String(d[`${name}.pivot`] || "").split(",").map(Number);
    if (pv.length === 2 && pv.every(isFinite)) m.pivot = pv;
    const w = String(d[`${name}.where`] || "").trim().split(/\s+/);
    if (w[0] === "idle") m.mask = { mode: 3, radius: .6, soft: .4 };
    else if (w[0] === "near" || w[0] === "away") m.mask = { mode: w[0] === "near" ? 1 : 2, radius: +w[1] || .6, soft: isFinite(+w[3]) ? +w[3] : .4 };
    stack.push(m);
  }
  return { stack, unknown };
}
function commit() { const d = toDict(); lastSig = JSON.stringify(d); host.set(d); }

// ----------------------------------------------------------------------------- preview maths
// Everything is a planar Float32Array: channel c, row y, column x at c*PW*PH + y*PW + x. Positions are in the
// render's units: y up, height -1..1, width -A..A.
const gauss = () => (Math.random() + Math.random() - 1) * 2.449;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const px2x = x => ((x + .5) / PW * 2 - 1) * A, px2y = y => 1 - (y + .5) / PH * 2;
function grid(rows, cols, ch) { const g = new Float32Array(ch * rows * cols); for (let i = 0; i < g.length; i++) g[i] = gauss(); return g; }
function upsample(src, rows, cols, ch, H = PH, W = PW) {   // bilinear, like F.interpolate(align_corners=False)
  if (rows === H && cols === W) return src.slice();
  const out = new Float32Array(ch * H * W), ky = rows / H, kx = cols / W;
  for (let y = 0; y < H; y++) {
    const sy = clamp((y + .5) * ky - .5, 0, rows - 1), y0 = Math.floor(sy), y1 = Math.min(rows - 1, y0 + 1), wy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = clamp((x + .5) * kx - .5, 0, cols - 1), x0 = Math.floor(sx), x1 = Math.min(cols - 1, x0 + 1), wx = sx - x0;
      for (let c = 0; c < ch; c++) {
        const b = c * rows * cols;
        out[c * H * W + y * W + x] = (src[b + y0 * cols + x0] * (1 - wx) + src[b + y0 * cols + x1] * wx) * (1 - wy) + (src[b + y1 * cols + x0] * (1 - wx) + src[b + y1 * cols + x1] * wx) * wy;
      }
    }
  }
  return out;
}
function shrink(src, rows, cols, ch) {   // box average down to rows x cols (the network's view), then back up
  if (rows >= PH) return src.slice();
  const low = new Float32Array(ch * rows * cols), cnt = new Float32Array(rows * cols);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const j = Math.min(rows - 1, Math.floor(y * rows / PH)) * cols + Math.min(cols - 1, Math.floor(x * cols / PW)); cnt[j]++;
    for (let c = 0; c < ch; c++) low[c * rows * cols + j] += src[c * PH * PW + y * PW + x];
  }
  for (let c = 0; c < ch; c++) for (let j = 0; j < rows * cols; j++) low[c * rows * cols + j] /= cnt[j] || 1;
  return upsample(low, rows, cols, ch);
}
// read the picture at render coordinates (mirroring at the edges, as edge = reflect) and write w * (that - pic)
// into f at pixel i: the change that pulls pixel i toward what is at (x, y)
function sampleInto(pic, x, y, f, i, w) {
  let u = (x / A + 1) / 2, v = (1 - y) / 2;
  u = 1 - Math.abs(1 - (((u % 2) + 2) % 2)); v = 1 - Math.abs(1 - (((v % 2) + 2) % 2));
  const sx = clamp(u * PW - .5, 0, PW - 1.001), sy = clamp(v * PH - .5, 0, PH - 1.001), x0 = sx | 0, y0 = sy | 0, wx = sx - x0, wy = sy - y0, N = PW * PH;
  for (let c = 0; c < 3; c++) { const b = c * N + y0 * PW + x0;
    f[c * N + i] = w * ((pic[b] * (1 - wx) + pic[b + 1] * wx) * (1 - wy) + (pic[b + PW] * (1 - wx) + pic[b + PW + 1] * wx) * wy - pic[c * N + i]); }
}
function unit(f) { let m = 0; for (const v of f) m += v; m /= f.length; let s = 0; for (let i = 0; i < f.length; i++) { f[i] -= m; s += f[i] * f[i]; } s = Math.sqrt(s / f.length) + 1e-6; for (let i = 0; i < f.length; i++) f[i] /= s; return f; }
function rms(f) { let s = 0; for (const v of f) s += v * v; return Math.sqrt(s / Math.max(1, f.length)); }
const dims = rows => { rows = Math.max(2, Math.round(rows)); return [rows, Math.max(2, Math.round(rows * A))]; };
function hash3(i, j, k) { let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h & 0xffff) / 65535; }
function vn3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z); let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t, h = (a, b, c) => hash3(xi + a, yi + b, zi + c);
  return L(L(L(h(0, 0, 0), h(1, 0, 0), fx), L(h(0, 1, 0), h(1, 1, 0), fx), fy), L(L(h(0, 0, 1), h(1, 0, 1), fx), L(h(0, 1, 1), h(1, 1, 1), fx), fy), fz);
}
function fbm(x, y, z) { let s = 0, a = .5; for (let o = 0; o < 4; o++) { s += a * vn3(x, y, z); x *= 2.03; y *= 2.03; z *= 1.6; a *= .5; } return s; }
const renderH = () => +host?.render()?.height || 1080;
const scalesOf = () => { const a = String(host?.render()?.scales || "0.12,0.2,0.3").split(",").map(Number).filter(v => v > 0); return a.length ? a : [.12, .2, .3]; };
// how much of per-pixel noise survives the network's antialiased shrink by scale s (roughly 2/3 of s)
const pixelReach = s => Math.min(1, 2 / 3 * s);

// The stand-in picture the Result view starts from: soft colour clouds with a few off-centre shapes, so that
// mirroring, discs and colour changes all show. Pictures dissolves in a ring target instead of a real picture.
function standIn(kind = "base") {
  const N = PW * PH, f = new Float32Array(3 * N);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const px = px2x(x), py = px2y(y), i = y * PW + x;
    let col;
    if (kind === "target") { const r = Math.hypot(px, py); col = [0, .33, .67].map(o => .5 + .42 * Math.cos(2 * Math.PI * (r * 4 + o))); }
    else {
      const n = fbm(px * 1.2 + 3, py * 1.2, .5), m = fbm(px * 3.1 + 7, py * 3.1, 1.7);
      col = [0, .33, .67].map(o => (.5 + .5 * Math.cos(2 * Math.PI * (n * 1.3 + m * .35 + o))) * (.35 + .75 * m));
      const b1 = Math.exp(-((px + .62 * A * .7) ** 2 + (py - .35) ** 2) / .03), b2 = Math.exp(-((px - .3) ** 2 + (py + .45) ** 2) / .012);
      col = [col[0] + .7 * b1, col[1] + .55 * b1 + .1 * b2, col[2] + .9 * b2];
    }
    for (let c = 0; c < 3; c++) f[c * N + i] = clamp(col[c], 0, 1);
  }
  return f;
}
function noiseSeed() {   // like make_seed in dream.py: noise at several sizes, stretched to 0..1
  const N = PW * PH, f = new Float32Array(3 * N);
  for (const s of [2, 4, 8, 16, 32]) { const [r, c] = dims(PH / s), u = upsample(grid(r, c, 3), r, c, 3); for (let i = 0; i < f.length; i++) f[i] += u[i] * s; }
  let lo = Infinity, hi = -Infinity; for (const v of f) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / (hi - lo);
  return f;
}

const runs = new Map();   // module id -> preview state
function stateOf(m) { let r = runs.get(m.id); if (!r || r.key !== m.key) { r = { key: m.key }; runs.set(m.id, r); } return r; }

// One frame of a module at time t, applied to the picture pic: returns { add, seen, reach } where add is what the
// module changes in the picture this frame and seen what the network gets of that, or null when it does nothing.
function fieldOf(m, t, pic, needSeen = true) {
  const r = stateOf(m), v = Object.fromEntries(BY[m.key].params.map(p => [p.k, paramAt(m, p, t)])), N = PW * PH;
  const H = renderH(), sm = Math.min(...scalesOf()), [nr, nc] = dims(H * sm);
  const mask = maskOf(m);
  const done = (f, pixel = false) => {   // what the network gets of it is only worked out when something shows it
    if (!needSeen) return { add: f, seen: null, reach: 0 };
    const seen = pixel ? f.map(x => x * pixelReach(sm)) : shrink(f, nr, nc, 3);
    return { add: f, seen, reach: rms(f) > 1e-9 ? rms(seen) / rms(f) : 0 };
  };
  const finish = (f, amount, pixel = false) => {
    if (mask) for (let c = 0; c < 3; c++) for (let i = 0; i < N; i++) f[c * N + i] *= mask[i];
    for (let i = 0; i < f.length; i++) f[i] *= amount;
    return done(f, pixel);
  };
  if (m.key === "grain") {
    const g = m.text.grid, world = m.text.lock === "world";
    let fresh;
    if (g === "pixel") fresh = grid(PH, PW, 3);
    else {
      const sizes = g === "size" ? [v.size] : scalesOf().map(s => 1 / (H * s));
      fresh = new Float32Array(3 * N);
      for (const s of sizes) { const [rr, cc] = dims(Math.min(PH, 1 / s)); const u = upsample(grid(rr, cc, 3), rr, cc, 3); for (let i = 0; i < u.length; i++) fresh[i] += u[i]; }
      unit(fresh);
    }
    let rho = v.life > DT / 2 ? Math.exp(-DT / v.life) : 0;
    if (world) rho = Math.max(rho, Math.exp(-DT / .3));
    if (!r.n || rho === 0) r.n = fresh; else { const q = Math.sqrt(1 - rho * rho); for (let i = 0; i < r.n.length; i++) r.n[i] = rho * r.n[i] + q * fresh[i]; }
    return finish(r.n.slice(), v.amount, g === "pixel");
  }
  if (m.key === "colour") {
    const [rr, cc] = dims(1 / m.vals.size);
    if (!r.g || r.g.length !== 2 * rr * cc) r.g = grid(rr, cc, 2);
    const rho = Math.exp(-DT / v.life), q = Math.sqrt(1 - rho * rho); for (let i = 0; i < r.g.length; i++) r.g[i] = rho * r.g[i] + q * gauss();
    const u = upsample(r.g, rr, cc, 2), f = new Float32Array(3 * N), a1 = [.7071, -.7071, 0], a2 = [.4082, .4082, -.8165];
    for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) f[c * N + i] = u[i] * a1[c] + u[N + i] * a2[c];
    return finish(unit(f), v.amount);
  }
  if (m.key === "marble") {
    r.phase = (r.phase || 0) + v.speed * DT;   // integrated, so a curve on the speed changes speed without jumping
    const hh = PH >> 1, ww = PW >> 1, low = new Float32Array(3 * hh * ww), tt = r.phase;
    for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) {
      const px = ((x + .5) / ww * 2 - 1) * A * v.scale, py = (1 - (y + .5) / hh * 2) * v.scale;
      const q1 = fbm(px, py, tt) - .47, q2 = fbm(px + 5.2, py + 1.3, tt) - .47, l = fbm(px + v.fold * 4 * q1, py + v.fold * 4 * q2, tt * .7 + 3);
      const i = y * ww + x; low[i] = l; low[hh * ww + i] = l + .5 * q1; low[2 * hh * ww + i] = l + .5 * q2;
    }
    return finish(unit(upsample(low, hh, ww, 3)), v.amount);
  }
  if (m.key === "turing") {
    const [rr, cc] = dims(Math.min(120, 6 / m.vals.size));
    if (!r.U || r.U.length !== rr * cc || r.pattern !== m.text.pattern) {
      r.U = new Float32Array(rr * cc).fill(1); r.V = new Float32Array(rr * cc); r.rr = rr; r.cc = cc; r.pattern = m.text.pattern; r.acc = 0;
      sprinkle(r, Math.max(4, rr * cc / 400)); for (let i = 0; i < 300; i++) gs(r);
    }
    r.acc += v.speed * 8; while (r.acc >= 1) { gs(r); r.acc--; }
    let mv = 0; for (const x of r.V) mv += x; if (mv / r.V.length < .005) sprinkle(r, 6);
    const u = upsample(r.V, rr, cc, 1), f = new Float32Array(3 * N); f.set(u, 0); f.set(u, N); f.set(u, 2 * N);
    return finish(unit(f), v.amount);
  }
  if (m.key === "seeds") {
    r.seeds = r.seeds || [];
    let n = 0; const L = Math.exp(-v.rate * DT); let p = Math.random(); while (p > L) { n++; p *= Math.random(); }   // Poisson
    const shapes = { dots: [0], rings: [1], eyes: [2], mixed: [0, 1, 2] }[m.text.shape];
    for (let k = 0; k < n; k++) for (let tr = 0; tr < 20; tr++) {
      const x = (Math.random() * 2 - 1) * A * .95, y = (Math.random() * 2 - 1) * .95;
      if (mask && Math.random() >= mask[clamp(Math.floor((1 - y) / 2 * PH), 0, PH - 1) * PW + clamp(Math.floor((x / A + 1) / 2 * PW), 0, PW - 1)] / maskMax(mask)) continue;
      r.seeds.push({ x, y, r: v.size * (.6 + .8 * Math.random()), t0: t, life: v.life, kind: shapes[Math.floor(Math.random() * shapes.length)], col: [0, 1, 2].map(() => (Math.random() * .4 + .6) * (Math.random() < .5 ? -1 : 1)) });
      break;
    }
    r.seeds = r.seeds.filter(s => t - s.t0 < s.life && t >= s.t0);
    if (!r.seeds.length) return null;
    const f = new Float32Array(3 * N);
    for (const s of r.seeds) {   // `strength` in total over the seed's life, as feed.py
      const env = Math.sin(Math.PI * (t - s.t0) / s.life) * Math.PI / 2 / (s.life * 30);
      for (let y = 0; y < PH; y++) { const py = px2y(y); if (Math.abs(py - s.y) > s.r * 2.2) continue;
        for (let x = 0; x < PW; x++) { const px = px2x(x); if (Math.abs(px - s.x) > s.r * 2.2) continue;
          const d = Math.hypot(px - s.x, py - s.y) / s.r, dot = Math.exp(-2.5 * d * d), ring = Math.exp(-(((d - 1) / .3) ** 2));
          const pr = s.kind === 0 ? dot : s.kind === 1 ? ring : ring - 1.3 * Math.exp(-12 * d * d);
          for (let c = 0; c < 3; c++) f[c * N + y * PW + x] += v.strength * env * pr * s.col[c]; } }
    }
    return done(f);
  }
  if (m.key === "mirror") {   // reflect across the line through the pivot at `angle`; `amount` of the way per second
    const an = v.angle * Math.PI / 180, ux = Math.cos(an), uy = Math.sin(an), [cx, cy] = m.pivot;
    const k = 1 - (1 - Math.min(v.amount, .999)) ** DT, f = new Float32Array(3 * N);
    if (k <= 0) return null;
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
      const i = y * PW + x, dx = px2x(x) - cx, dy = px2y(y) - cy, dd = dx * ux + dy * uy, w = k * (mask ? mask[i] : 1);
      sampleInto(pic, 2 * dd * ux - dx + cx, 2 * dd * uy - dy + cy, f, i, w);
    }
    return done(f);
  }
  if (m.key === "reseed" || m.key === "pictures") {   // every `every` s (the set value), mix a new picture into a disc
    const every = Math.max(.5, m.vals.every), n = Math.floor(t / every);
    if (n < 1 || t - n * every >= Math.max(v.fade, DT)) return null;
    if (r.n !== n) { r.n = n; r.src = m.key === "reseed" ? noiseSeed() : standIn("target"); }
    const k = v.fade > DT ? 1 - (1 - Math.min(v.amount, .999)) ** (DT / v.fade) : v.amount, f = new Float32Array(3 * N);
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
      const i = y * PW + x, disc = 1 - smooth((Math.hypot(px2x(x) - m.pivot[0], px2y(y) - m.pivot[1]) - v.size * .6) / (v.size * .8));
      for (let c = 0; c < 3; c++) f[c * N + i] = k * disc * (r.src[c * N + i] - pic[c * N + i]);
    }
    return done(f);
  }
  return null;
}
const maskMax = mk => { let m = 0; for (const v of mk) m = Math.max(m, v); return m || 1; };
function sprinkle(r, n) {
  for (let s = 0; s < n; s++) { const cy = Math.floor(Math.random() * r.rr), cx = Math.floor(Math.random() * r.cc), q = 2 + Math.floor(Math.random() * 3);
    for (let y = -q; y <= q; y++) for (let x = -q; x <= q; x++) { const i = ((cy + y + r.rr) % r.rr) * r.cc + ((cx + x + r.cc) % r.cc); r.U[i] = .5; r.V[i] = .25; } }
}
function gs(r) {   // one Gray-Scott update (Karl Sims' form), as feed.py
  const [F, K] = { spots: [.0367, .0649], worms: [.078, .061], maze: [.029, .057] }[r.pattern], { rr, cc, U, V } = r;
  const U2 = new Float32Array(U.length), V2 = new Float32Array(V.length);
  for (let y = 0; y < rr; y++) { const ym = ((y - 1 + rr) % rr) * cc, yp = ((y + 1) % rr) * cc, yc = y * cc;
    for (let x = 0; x < cc; x++) { const xm = (x - 1 + cc) % cc, xp = (x + 1) % cc, i = yc + x;
      const lu = .2 * (U[yc + xm] + U[yc + xp] + U[ym + x] + U[yp + x]) + .05 * (U[ym + xm] + U[ym + xp] + U[yp + xm] + U[yp + xp]) - U[i];
      const lv = .2 * (V[yc + xm] + V[yc + xp] + V[ym + x] + V[yp + x]) + .05 * (V[ym + xm] + V[ym + xp] + V[yp + xm] + V[yp + xp]) - V[i];
      const uvv = U[i] * V[i] * V[i];
      U2[i] = clamp(U[i] + lu - uvv + F * (1 - U[i]), 0, 1); V2[i] = clamp(V[i] + .5 * lv + uvv - (F + K) * V[i], 0, 1); } }
  r.U = U2; r.V = V2;
}
// The where-mask, as feed.py: additive modules keep the same total amount (unit RMS, at most x3); idle can't be
// known without the dream, so the preview treats it as everywhere.
const maskCache = new Map();
function maskOf(m) {
  const { mode, radius, soft } = m.mask;
  if (mode !== 1 && mode !== 2) return null;
  const key = [m.key, mode, radius, soft, m.pivot[0], m.pivot[1], PW].join(), hit = maskCache.get(key);
  if (hit) return hit;
  if (maskCache.size > 32) maskCache.clear();
  const mk = new Float32Array(PW * PH), lo = radius * (1 - soft), hi = radius * (1 + soft) + 1e-3;
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const inside = 1 - smooth((Math.hypot(px2x(x) - m.pivot[0], px2y(y) - m.pivot[1]) - lo) / (hi - lo));
    mk[y * PW + x] = mode === 1 ? inside : 1 - inside;
  }
  if (ADDITIVE.includes(m.key)) { const g = 1 / (rms(mk) + 1e-6); for (let i = 0; i < mk.length; i++) mk[i] = Math.min(3, mk[i] * g); }
  maskCache.set(key, mk);
  return mk;
}

// ----------------------------------------------------------------------------- DOM
let root, side, $q, $$, cv, ctx, img;
const fmtv = (v, st) => (+v).toFixed(Math.min(4, decimals(st)));
function buildDom() {
  root.innerHTML = `<div class="wl">
    <div class="wl-head"><h3>Feed stack</h3><span class="sub">new material for the dream, added every frame after the motion · modules run top to bottom</span></div>
    <div class="wl-head"><span class="sub">Looks:</span><div class="chips" data-r="looks"></div></div>
    <div class="wl-stack" data-r="stack"></div>
    <details class="wl-add" open data-r="addbox"><summary>Add a feed <span>what each one does, on a stand-in picture</span></summary><div data-r="catalog"></div></details>
  </div>`;
  side.innerHTML = `<div class="wl-mon">
      <div class="tabs wl-views" role="tablist" aria-label="Preview view">
        <button role="tab" data-view="0" aria-selected="true" title="A stand-in picture with the feed working on it, frame after frame">Result</button>
        <button role="tab" data-view="1" aria-selected="false" title="What the feed changes in the picture this frame">Added</button>
        <button role="tab" data-view="2" aria-selected="false" title="The same after the shrink to your smallest painting size, which is what the network looks at">Seen by the network</button>
        <button role="tab" data-view="3" aria-selected="false" title="Where each module works">Where</button>
      </div>
      <div class="viewer">
        <div class="screen wl-screen" data-r="screen"><canvas data-r="cv" aria-label="Feed preview"></canvas><svg data-r="ov" aria-hidden="true"></svg>
          <span class="badge">Feed only · stand-in picture, no motion, no dream</span><span class="busy" data-r="busy" hidden></span></div>
        <div class="vbar wl-vo" data-r="vo"></div>
      </div>
      <div class="wl-tr">
        <button class="btn" type="button" data-r="play">Pause</button>
        <button class="btn" type="button" data-r="restart" title="Start again from the first frame">Restart</button>
        <input type="range" data-r="scrub" min="0" max="20" step="0.0333" value="0" aria-label="Time in the video">
        <span class="clock" data-r="clock">0.0 / 20 s</span>
      </div>
      <div class="jobline wl-jl"><label><select data-r="speed" aria-label="Playback speed"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option></select> speed</label></div>
    </div>
    <div class="wl-lanes"><p data-r="lanes-empty">No feed curves yet. Press <b>∿</b> next to a setting to make it change over the video.</p><canvas data-r="lanes" hidden></canvas></div>
    <div class="readout"><h2>Feed check</h2><dl class="facts" data-r="facts"></dl><div class="warnings" data-r="warnings"></div></div>`;
  $q = r => root.querySelector(`[data-r="${r}"]`) || side.querySelector(`[data-r="${r}"]`);
  $$ = sel => [...root.querySelectorAll(sel), ...side.querySelectorAll(sel)];
  cv = $q("cv"); ctx = cv.getContext("2d");
}
function paramRow(m, p) {
  const md = m.mod[p.k], id = `fl${m.id}-${p.k}`, on = md.shape !== "none", open = !!m.ui[p.k];
  const wv = p.still ? `<span class="wl-wv" title="Set once for the whole video, so it can't follow a curve" style="opacity:.35;display:grid;place-items:center">–</span>`
    : `<button class="wl-wv${on ? " on" : ""}" type="button" data-act="wave" aria-expanded="${open}" title="Make this setting change over the video">∿</button>`;
  return `<div class="wl-p" data-id="${m.id}" data-k="${p.k}">
    <label for="${id}" title="${esc(p.label)}${p.unit ? " (" + p.unit + ")" : ""}">${esc(p.label)}<code>${p.k}</code></label>
    <input type="range" id="${id}" data-f="val" min="${p.min}" max="${p.max}" step="${p.step}" value="${m.vals[p.k]}">
    <input type="number" data-f="val" aria-label="${esc(p.label)} value" min="${p.min}" max="${p.max}" step="${p.step}" value="${fmtv(m.vals[p.k], p.step)}">
    ${wv}
  </div>
  ${p.still ? "" : `<div class="wl-curve" data-id="${m.id}" data-k="${p.k}" ${open ? "" : "hidden"}>
    <label>Curve <select data-f="shape">${Object.entries(SHAPES).map(([s, l]) => `<option value="${s}" ${s === md.shape ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label ${md.shape === "ramp" ? "hidden" : ""}>Period <input type="number" data-f="period" min="0.5" max="120" step="0.5" value="${md.period}"> s</label>
    <label title="${md.shape === "ramp" ? "How far it travels by the end, as a share of the slider's range" : "How far it swings, as a share of the slider's range"}">Depth <input type="range" data-f="depth" min="-1" max="1" step="0.01" value="${md.depth}"></label>
    <label ${md.shape === "ramp" ? "hidden" : ""}>Phase <input type="range" data-f="phase" min="0" max="1" step="0.01" value="${md.phase}"></label>
    <canvas width="260" height="44" aria-hidden="true"></canvas>
  </div>`}`;
}
function textRow(m, [k, label, opts]) {
  if (!opts) return `<div class="wl-where"><label>${esc(label)} <input type="text" data-tf="${k}" value="${esc(m.text[k])}" spellcheck="false" style="width:220px"></label>
    <span>a folder of pictures, relative to the DeepDreamer folder</span></div>`;
  return `<div class="wl-where"><span>${esc(label)}</span><div class="chips">${opts.map(([v, l]) => `<button class="chip" type="button" data-act="text" data-k="${k}" data-v="${v}" aria-pressed="${m.text[k] === v}">${esc(l)}</button>`).join("")}</div></div>`;
}
function renderStack() {
  const el = $q("stack");
  if (!S.stack.length) { el.innerHTML = `<div class="wl-empty">No feed: the dream works only with what the motion brings. Add a feed below or pick a look.</div>`; afterStructure(); return; }
  el.innerHTML = S.stack.map((m, i) => {
    const d = BY[m.key], modes = d.disc ? [] : [0, 1, 2, 3];
    return `<div class="wl-mod${m.id === selId ? " sel" : ""}${m.on ? "" : " off"}" data-id="${m.id}">
      <div class="wl-mh" data-act="select">
        <div class="order"><button type="button" data-act="up" ${i ? "" : "disabled"} aria-label="Move up">▲</button><button type="button" data-act="down" ${i < S.stack.length - 1 ? "" : "disabled"} aria-label="Move down">▼</button></div>
        <canvas data-glyph="${m.key}" aria-hidden="true"></canvas>
        <div class="mname"><b>${d.name}</b><code>${m.key}</code></div><span class="sp"></span>
        <button class="wl-tog solo" type="button" data-act="solo" aria-pressed="${m.solo}" title="Preview only this module (the render always uses every module that is on)">Solo</button>
        <button class="wl-tog" type="button" data-act="on" aria-pressed="${m.on}" title="Include this module">${m.on ? "On" : "Off"}</button>
        <button class="wl-tog x" type="button" data-act="del" aria-label="Remove ${d.name}">✕</button>
        <button class="wl-tog" type="button" data-act="fold" aria-expanded="${m.open}" aria-label="${m.open ? "Collapse" : "Expand"}">${m.open ? "–" : "+"}</button>
      </div>
      <div class="wl-mb" ${m.open ? "" : "hidden"}>
        ${d.params.filter(p => shown(m, p)).map(p => paramRow(m, p)).join("")}
        ${(d.text || []).map(t => textRow(m, t)).join("")}
        <div class="wl-where" data-id="${m.id}">
          ${usesPivot(m) ? `<span>Pivot <span class="pv">${m.pivot[0].toFixed(2)}, ${m.pivot[1].toFixed(2)}</span></span><button class="btn small" type="button" data-act="center">Centre</button>` : ""}
          ${modes.length ? `<span>Where</span><div class="chips">${modes.map(k => `<button class="chip" type="button" data-act="mask" data-mode="${k}" aria-pressed="${m.mask.mode === k}">${WHERE[k]}</button>`).join("")}</div>
          ${m.mask.mode === 1 || m.mask.mode === 2 ? `<label>Radius <input type="range" data-f="radius" min="0.05" max="1.8" step="0.01" value="${m.mask.radius}"></label>
          <label>Soft <input type="range" data-f="soft" min="0" max="1" step="0.01" value="${m.mask.soft}"></label>` : ""}` : `<span>drag the pivot on the preview to place the disc</span>`}
        </div>
      </div>
    </div>`;
  }).join("");
  el.querySelectorAll("canvas[data-glyph]").forEach(c => paintGlyph(c, c.dataset.glyph));
  el.querySelectorAll(".wl-curve").forEach(r => { if (!r.hidden) drawSpark(r); });
  afterStructure();
}
const findMod = id => S.stack.find(m => m.id === +id);
function drawSpark(row) {
  const m = findMod(row.dataset.id), p = BY[m.key].params.find(q => q.k === row.dataset.k), c = row.querySelector("canvas"), x = c.getContext("2d");
  const W = c.width, H = c.height; x.clearRect(0, 0, W, H);
  x.strokeStyle = "#272c38"; x.lineWidth = 1; const by = H - 4 - (m.vals[p.k] - p.min) / (p.max - p.min) * (H - 8);
  x.setLineDash([4, 4]); x.beginPath(); x.moveTo(0, by); x.lineTo(W, by); x.stroke(); x.setLineDash([]);
  x.strokeStyle = "#3fc6bd"; x.lineWidth = 2; x.beginPath();
  for (let i = 0; i <= W; i += 2) { const t = i / W * S.T, v = paramAt(m, p, t), y = H - 4 - (v - p.min) / (p.max - p.min) * (H - 8); i ? x.lineTo(i, y) : x.moveTo(i, y); }
  x.stroke();
}
function onStackClick(e) {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const card = b.closest(".wl-mod"), m = card && findMod(card.dataset.id); if (!m) return;
  const i = S.stack.indexOf(m), act = b.dataset.act;
  if (act === "select") { if (e.target.closest("button")) return; selId = m.id; $q("stack").querySelectorAll(".wl-mod").forEach(c => c.classList.toggle("sel", +c.dataset.id === selId)); drawOverlay(); return; }
  e.stopPropagation();
  if (act === "wave") { const k = b.closest(".wl-p").dataset.k; m.ui[k] = !m.ui[k]; const row = card.querySelector(`.wl-curve[data-k="${k}"]`); row.hidden = !m.ui[k]; b.setAttribute("aria-expanded", m.ui[k]); if (m.ui[k]) drawSpark(row); return; }
  if (act === "fold") { m.open = !m.open; renderStack(); return; }
  if (act === "solo") { m.solo = !m.solo; renderStack(); drawLanesNow = true; return; }   // preview only, not saved
  if (act === "up" && i > 0) { S.stack.splice(i, 1); S.stack.splice(i - 1, 0, m); }
  else if (act === "down" && i < S.stack.length - 1) { S.stack.splice(i, 1); S.stack.splice(i + 1, 0, m); }
  else if (act === "on") m.on = !m.on;
  else if (act === "del") { S.stack.splice(i, 1); runs.delete(m.id); if (selId === m.id) selId = S.stack[0]?.id || 0; }
  else if (act === "center") m.pivot = [0, 0];
  else if (act === "mask") { m.mask.mode = +b.dataset.mode; selId = m.id; }
  else if (act === "text") { m.text[b.dataset.k] = b.dataset.v; runs.delete(m.id); }
  else return;
  lookIdx = -1; renderLooks(); renderStack(); commit(); drawLanesNow = true;
}
function onStackInput(e) {
  const el = e.target;
  if (el.dataset.tf) { const m = findMod(el.closest(".wl-mod").dataset.id); if (m) { m.text[el.dataset.tf] = el.value.trim() || "init_images"; commit(); } return; }
  const f = el.dataset.f; if (!f) return;
  const holder = el.closest("[data-id]"), m = findMod(holder.dataset.id); if (!m) return;
  if (f === "val") {
    const row = el.closest(".wl-p"), p = BY[m.key].params.find(q => q.k === row.dataset.k), v = clamp(+el.value, p.min, p.max);
    if (el.value === "" || !isFinite(v)) return; m.vals[p.k] = v;
    row.querySelectorAll("[data-f=val]").forEach(x => { if (x !== el) x.value = x.type === "number" ? fmtv(v, p.step) : v; });
    const cr = row.nextElementSibling; if (cr && cr.classList.contains("wl-curve") && !cr.hidden) drawSpark(cr);
  } else if (f === "radius" || f === "soft") m.mask[f] = +el.value;
  else {
    const row = el.closest(".wl-curve"), md = m.mod[row.dataset.k];
    if (f !== "shape" && (el.value === "" || !isFinite(+el.value))) return;
    md[f] = f === "shape" ? el.value : f === "period" ? Math.max(.5, +el.value) : +el.value;
    if (f === "shape") { row.previousElementSibling.querySelector(".wl-wv").classList.toggle("on", md.shape !== "none");
      row.querySelectorAll("label").forEach((l, k) => { if (k === 1 || k === 3) l.hidden = md.shape === "ramp"; }); }
    drawSpark(row);
  }
  drawOverlay(); drawLanesNow = true;   // the mirror line, disc and ring follow every edit
  lookIdx = -1; renderLooks(); commit();
}
function renderCatalog() {
  const full = S.stack.length >= MAXM;
  $q("catalog").innerHTML = FAMS.map(([fam, sub]) => `<div class="wl-fam">${fam}${sub ? ` · <span style="text-transform:none;letter-spacing:0;font-weight:400">${sub}</span>` : ""}</div>
    <div class="wl-cat">${MODS.filter(d => d.fam === fam).map(d => `<button class="wl-c" type="button" data-add="${d.key}" ${full ? "disabled" : ""} title="${full ? "The stack holds 8 modules at most" : "Add " + d.name}">
      <canvas data-glyph="${d.key}" aria-hidden="true"></canvas><b>${d.name}</b><p>${d.blurb}</p></button>`).join("")}</div>`).join("");
  $q("catalog").querySelectorAll("canvas[data-glyph]").forEach(c => paintGlyph(c, c.dataset.glyph));
}
function renderLooks() { $q("looks").innerHTML = LOOKS.map(([n], i) => `<button class="chip" type="button" data-look="${i}" aria-pressed="${i === lookIdx}">${n}</button>`).join(""); }
function applyLook(i) { lookIdx = i; S.stack = LOOKS[i][1](); runs.clear(); selId = S.stack[0]?.id || 0; renderLooks(); renderStack(); commit(); seek(0); }
function afterStructure() { renderCatalog(); drawOverlay(); drawLanesNow = true; }

// small pictures of each module: a second of it working on the stand-in picture, from the preview's own maths
const glyphs = {};
function glyphFor(key) {
  const oldA = A, oldW = PW; A = 16 / 9; PW = 256;
  const m = M(key, key === "seeds" ? { rate: 20, size: .12 } : key === "mirror" ? { amount: .999 } : key === "reseed" || key === "pictures" ? { every: 1, amount: 1, fade: 0 } : {});
  const N = PW * PH, base = standIn(), pic = base.slice();
  let shownF = null;
  for (let k = 0; k < 31; k++) {
    const r = fieldOf(m, 1 + k * DT, pic, false);
    if (r) { for (let i = 0; i < pic.length; i++) pic[i] += r.add[i]; if (ADDITIVE.includes(key) || key === "seeds") shownF = r.add; }
  }
  runs.delete(m.id); A = oldA; PW = oldW;
  const c = document.createElement("canvas"); c.width = 256; c.height = 144; const x = c.getContext("2d"), im = x.createImageData(256, 144);
  const g = shownF ? .22 / (rms(shownF) + 1e-9) : 0;   // noise modules show their field; the others the picture they leave
  for (let i = 0; i < N; i++) for (let ch = 0; ch < 3; ch++) im.data[i * 4 + ch] = clamp(shownF ? 40 + 255 * g * shownF[ch * N + i] : pic[ch * N + i] * 255, 0, 255);
  for (let i = 0; i < N; i++) im.data[i * 4 + 3] = 255;
  x.putImageData(im, 0, 0);
  if (key === "mirror") { x.strokeStyle = "#3fc6bd"; x.lineWidth = 5; x.setLineDash([14, 10]); x.beginPath(); x.moveTo(128, 0); x.lineTo(128, 144); x.stroke(); }
  return c;
}
function paintGlyph(c, key) {
  if (!glyphs[key]) glyphs[key] = glyphFor(key);
  const r = c.getBoundingClientRect(), w = Math.max(1, Math.round((r.width || 56) * 2)), h = Math.max(1, Math.round((r.height || 32) * 2));
  c.width = w; c.height = h; c.getContext("2d").drawImage(glyphs[key], 0, 0, w, h);
}

// ----------------------------------------------------------------------------- overlay: pivot, ring, mirror line, disc
// drawn at the current preview time, so curves on the line's angle or the disc's size move it
const valAt = (m, k) => paramAt(m, BY[m.key].params.find(p => p.k === k), frame * DT);
function overlayMoves(m) { return !!m && ((m.key === "mirror" && m.mod.angle.shape !== "none") || (BY[m.key].disc && m.mod.size.shape !== "none")); }
function drawOverlay() {
  const ov = $q("ov"); ov.setAttribute("viewBox", `${-A} -1 ${2 * A} 2`);
  const m = findMod(selId);
  if (!m) { ov.innerHTML = ""; return; }
  const [x, y] = m.pivot; let s = "";
  if (m.mask.mode === 1 || m.mask.mode === 2) s += `<circle cx="${x}" cy="${y}" r="${m.mask.radius}" fill="none" stroke="#f5d76e" stroke-width="0.008" stroke-dasharray="0.03 0.02"/>`;
  if (BY[m.key].disc) s += `<circle cx="${x}" cy="${y}" r="${valAt(m, "size")}" fill="none" stroke="#e7e9ee" stroke-opacity=".6" stroke-width="0.008" stroke-dasharray="0.02 0.02"/>`;
  if (m.key === "mirror") { const an = valAt(m, "angle") * Math.PI / 180, L = 3; s += `<line x1="${x - Math.cos(an) * L}" y1="${y - Math.sin(an) * L}" x2="${x + Math.cos(an) * L}" y2="${y + Math.sin(an) * L}" stroke="#3fc6bd" stroke-width="0.012" stroke-dasharray="0.05 0.03"/>`; }
  if (usesPivot(m)) s += `<g stroke="#0d0f13" stroke-width="0.016"><circle cx="${x}" cy="${y}" r="0.035" fill="#3fc6bd"/></g>`;
  ov.innerHTML = `<g transform="scale(1,-1)">${s}</g>`;
}
let dragging = false;
function pointerToP(e) { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) / r.width * 2 - 1) * A, -((e.clientY - r.top) / r.height * 2 - 1)]; }
function movePivot(e) {
  const m = findMod(selId); if (!m || !usesPivot(m)) return;
  const [x, y] = pointerToP(e); m.pivot = [+clamp(x, -A, A).toFixed(3), +clamp(y, -1, 1).toFixed(3)];
  const pv = $q("stack").querySelector(`.wl-mod[data-id="${m.id}"] .pv`); if (pv) pv.textContent = `${m.pivot[0].toFixed(2)}, ${m.pivot[1].toFixed(2)}`;
  drawOverlay(); commit();
}

// ----------------------------------------------------------------------------- timeline: transport and curve lanes (as the Motion tab)
let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches, speed = 1, acc = 0, frame = 0, pendingTo = -1, drawLanesNow = true;
let base = null, pic = null, gain = 0, stats = [], lastAdd = null, lastSeen = null;
function reset() { frame = 0; runs.clear(); gain = 0; base = base || standIn(); pic = base.slice(); }
// The picture carries history, so a jump re-runs the frames before it. The preview eases back to its start within a
// few seconds, so it starts 6 s before the target; events and curves only depend on the time.
const WARM = 180;
function seek(f) { reset(); pendingTo = Math.max(0, Math.round(f)); frame = Math.max(0, pendingTo - WARM); }
function setPlaying(p) { playing = p; $q("play").textContent = p ? "Pause" : "Play"; }
function lanes() { const out = []; for (const m of S.stack) for (const p of BY[m.key].params) if (m.mod[p.k].shape !== "none" && !p.still && shown(m, p)) out.push([m, p]); return out; }
function drawLanes() {
  const L = lanes(), lc = $q("lanes"); $q("lanes-empty").hidden = !!L.length; lc.hidden = !L.length; if (!L.length) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(lc.clientWidth * dpr) || 400, lh = 20, h = Math.round((L.length * lh + 4) * dpr);
  if (lc.width !== w || lc.height !== h) { lc.width = w; lc.height = h; lc.style.height = (L.length * lh + 4) + "px"; }
  const x = lc.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); const W = w / dpr, lx = 120;
  x.clearRect(0, 0, W, h); x.font = "11.5px 'Source Sans 3', 'Segoe UI', sans-serif"; x.textBaseline = "middle";
  const act = active();
  L.forEach(([m, p], i) => {
    const y0 = 2 + i * lh, on = act.includes(m);
    x.fillStyle = on ? "#e7e9ee" : "#9399a8"; x.fillText(`${BY[m.key].name} · ${p.label}`, 2, y0 + lh / 2, lx - 8);
    x.fillStyle = "#1b1f29"; x.fillRect(lx, y0 + 2, W - lx, lh - 4);
    x.strokeStyle = on ? "#3fc6bd" : "#4a5060"; x.lineWidth = 1.5; x.beginPath();
    for (let px = 0; px <= W - lx; px += 2) { const t = px / (W - lx) * S.T, v = paramAt(m, p, t), yy = y0 + lh - 4 - (v - p.min) / (p.max - p.min) * (lh - 8); px ? x.lineTo(lx + px, yy) : x.moveTo(lx + px, yy); }
    x.stroke();
  });
  const ph = lx + clamp(frame * DT / S.T, 0, 1) * (W - lx); x.strokeStyle = "#f5d76e"; x.lineWidth = 1.5; x.beginPath(); x.moveTo(ph, 0); x.lineTo(ph, h / dpr); x.stroke();
}

// ----------------------------------------------------------------------------- preview frames and readout
function sizeCanvas() {
  const r = host.render() || {}, a = clamp((+r.width || 1920) / (+r.height || 1080), .5, 3), T = clamp(+r.seconds || 20, 1, 3600);
  if (T !== S.T) { S.T = T; $q("scrub").max = T; drawLanesNow = true; $$(".wl-curve").forEach(row => { if (!row.hidden) drawSpark(row); }); }
  if (Math.abs(a - A) > 1e-3 || !img) {
    A = a; PW = Math.round(PH * A); cv.width = PW; cv.height = PH; img = ctx.createImageData(PW, PH);
    $q("screen").style.aspectRatio = `${PW} / ${PH}`; side.style.setProperty("--wl-aspect", A); base = null; seek(frame); drawOverlay();
  }
}
// one frame: the picture eases back toward the stand-in (the dream would repaint it), then each module works on it
function step(needSeen = true) {
  const t = frame * DT, N = PW * PH, add = new Float32Array(3 * N), seen = needSeen ? new Float32Array(3 * N) : null, mods = active();
  for (let i = 0; i < pic.length; i++) pic[i] += (base[i] - pic[i]) * RELAX;
  const st = [];
  for (const m of mods) {
    const r = fieldOf(m, t, pic, needSeen);
    if (r) for (let i = 0; i < add.length; i++) { add[i] += r.add[i]; if (seen) seen[i] += r.seen[i]; pic[i] = clamp(pic[i] + r.add[i], 0, 1); }
    st.push({ m, r });
  }
  lastAdd = add; if (seen) { lastSeen = seen; stats = st; }
  const target = .22 / (rms(add) + 1e-9);   // a steady display gain for the Added views
  gain = gain ? gain * .9 + Math.min(target, 4000) * .1 : Math.min(target, 4000);
  frame++;
}
function draw() {
  const N = PW * PH, d = img.data, mods = active();
  if (S.view === 0 && pic) for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) d[i * 4 + c] = pic[c * N + i] * 255;
  else if ((S.view === 1 || S.view === 2) && lastAdd && (S.view === 1 || lastSeen)) { const f = S.view === 1 ? lastAdd : lastSeen; for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(128 + 255 * gain * f[c * N + i], 0, 255); }
  else {   // where: each module's area in its own colour
    d.fill(0);
    mods.forEach((m, k) => {
      const mk = maskOf(m), col = COLORS[k % COLORS.length].match(/\w\w/g).map(h => parseInt(h, 16)), mx = mk ? maskMax(mk) : 1;
      for (let i = 0; i < N; i++) { const w = (mk ? mk[i] / mx : 1) * (m.mask.mode === 3 ? .35 : .55) / Math.max(1, mods.length * .7); for (let c = 0; c < 3; c++) d[i * 4 + c] = Math.min(255, d[i * 4 + c] + col[c] * w); }
    });
  }
  for (let i = 0; i < N; i++) d[i * 4 + 3] = 255;
  ctx.putImageData(img, 0, 0);
}
function renderViewOpt() {
  const vo = $q("vo"), H = renderH(), sm = Math.min(...scalesOf());
  if (S.view === 0) vo.innerHTML = `<span>A stand-in picture with the feed working on it, frame after frame. It eases back toward the start, the way the dream would repaint it. Judge what the feed does, not the content.</span>`;
  else if (S.view === 1) vo.innerHTML = `<span>What the feed changes in the picture this frame, on grey, shown ×<span data-r="gainl"></span> so it is visible.</span>`;
  else if (S.view === 2) vo.innerHTML = `<span>The same after the shrink to scale ${sm} (${Math.round(H * sm)} lines of ${H}), at the same brightness as Added. Whatever is flat here never reaches the network.</span>`;
  else vo.innerHTML = `<span>Where each module works. ${S.stack.some(m => m.mask.mode === 3) ? "“Idle” follows the dream, so here it shows as faint everywhere." : ""}</span>`;
}
function stepCost() {   // one frame of dreaming at the editor's settings, in picture units, as dream.py
  const r = host.render() || {}, fps = +r.fps || 30;
  return (+r.strength || 1) / 255 * 30 / fps * Math.max(1, +r.steps || 1);
}
function bar(v, max, cls = "") { return `<span class="wl-bar ${cls}"><div style="width:${clamp(v / max, 0, 1) * 100}%"></div></span>`; }
function renderReadout() {
  const facts = [], W = [], add = (lvl, html) => W.push(`<div class="w ${lvl}">${html}</div>`);
  const sm = Math.min(...scalesOf()), dstep = stepCost(), motion = host.motion?.() || [], t = frame * DT;
  if (!S.stack.length) facts.push(`<dt>Feed</dt><dd>none: new material comes only from the motion and the dream</dd>`);
  for (const { m, r } of stats) {
    const name = BY[m.key].name, v = k => valAt(m, k);
    if (ADDITIVE.includes(m.key)) {
      const reach = m.key === "grain" && m.text.grid === "pixel" ? pixelReach(sm) : r ? r.reach : 0, cls = reach < .3 ? "bad" : reach < .6 ? "warn" : "";
      const per = v("amount") / dstep;
      facts.push(`<dt>${esc(name)}</dt><dd><b>${Math.round(reach * 100)}%</b>${bar(reach, 1, cls)}<span class="status">reaches the network · ${per < .1 ? per.toFixed(2) : per.toFixed(1)}× a dream step per frame</span></dd>`);
      if (m.key === "grain" && m.text.grid === "pixel") add("warn", `<b>${esc(name)}: one value per pixel.</b> The network looks at a ${Math.round(sm * 100)}% size copy, so about ${Math.round(pixelReach(sm) * 100)}% of it gets through. Draw it at the painting sizes instead.`);
      const held = m.key !== "grain" || m.vals.life > .3 || m.text.lock === "world";
      if (held && m.vals.amount / dstep > .8) add("warn", `<b>${esc(name)} is strong for a held pattern.</b> It is added again every frame, so it can burn into blotches. Try below ${(dstep * .6).toFixed(3)}.`);
    } else if (m.key === "seeds") facts.push(`<dt>${esc(name)}</dt><dd><b>${v("rate").toFixed(1)}/s</b><span class="status">${Math.round(v("rate") * v("life") * 10) / 10} on screen at a time, ${Math.round(v("size") * renderH())} px across</span></dd>`);
    else if (m.key === "mirror") {
      facts.push(`<dt>${esc(name)}</dt><dd><b>${Math.round(v("amount") * 100)}%</b><span class="status">of the way to the mirror image each second · line at ${Math.round(v("angle"))}°</span></dd>`);
      if (v("amount") < .2) add("", `<b>${esc(name)} is gentle:</b> the dream repaints faster than it pulls, so the symmetry stays faint. 0.4–0.8 shows clearly.`);
    } else {
      const next = (Math.floor(t / Math.max(.5, m.vals.every)) + 1) * Math.max(.5, m.vals.every);
      facts.push(`<dt>${esc(name)}</dt><dd><b>every ${m.vals.every} s</b><span class="status">${Math.round(v("amount") * 100)}% into a disc ${v("size").toFixed(2)} wide${m.key === "pictures" ? `, from ${esc(m.text.folder)}\\` : ""} · next at ${next.toFixed(1)} s</span></dd>`);
      if (m.vals.every >= S.T) add("warn", `<b>${esc(name)} never fires:</b> it waits ${m.vals.every} s and the video is ${S.T} s long.`);
      if (m.key === "pictures") add("", `<b>${esc(name)}:</b> the preview dissolves in rings; the render uses the pictures in ${esc(m.text.folder)}\\.`);
    }
    if (m.text?.lock === "world" && !motion.length) add("", `<b>${esc(name)} is attached to the world,</b> but the Motion tab's stack is empty, so there is nothing to carry it.`);
    if (m.text?.lock === "world" && motion.length) add("", `<b>${esc(name)} moves with the picture</b> in the render; the preview has no motion, so here it stays put.`);
  }
  if (S.stack.some(m => m.mask.mode === 1 || m.mask.mode === 2) && motion.length && !motion.every(n => /zoom/i.test(n)))
    add("", "Near / away masks are placed by the pivot. With motion other than a centred zoom, new things live longest where the motion pulls the picture apart; the Motion tab's Stress view shows where.");
  if (S.stack.some(m => m.solo)) add("", "<b>Solo is on.</b> The preview shows only the soloed modules; the render uses every module that is on.");
  if (!W.length) add("", "No known problems with this feed.");
  $q("facts").innerHTML = facts.join(""); $q("warnings").innerHTML = W.join("");
}

// ----------------------------------------------------------------------------- main loop (paused while the Feed tab is hidden)
let visible = false, last = performance.now(), n = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(.1, (now - last) / 1000); last = now;
  if (!visible || document.hidden) return;
  sizeCanvas();
  if (pendingTo >= 0) {   // catching up after a seek: as many frames as fit in ~30 ms
    const t0 = performance.now(); while (frame < pendingTo && performance.now() - t0 < 30) step(frame === pendingTo - 1);
    const busy = $q("busy");
    if (frame >= pendingTo) { pendingTo = -1; busy.hidden = true; } else { busy.hidden = false; busy.textContent = `Re-running from frame 0… ${Math.round(frame / pendingTo * 100)}%`; }
  } else if (playing) {
    acc += dt * speed; let k = 0;
    while (acc >= DT && k < 4) { step(S.view === 2 || n % 8 === 0); acc -= DT; k++; if (frame * DT >= S.T) reset(); }
    if (k === 4) acc = 0;
  }
  if (!pic) reset();
  draw();
  if (n % 8 === 0) { renderReadout(); const g = $q("gainl"); if (g) g.textContent = Math.round(gain); }
  $q("clock").textContent = `${(frame * DT).toFixed(1)} / ${S.T} s`;
  const sc = $q("scrub"); if (document.activeElement !== sc) sc.value = frame * DT;
  if (drawLanesNow || playing || pendingTo >= 0) { drawLanes(); drawLanesNow = false; }
  if (overlayMoves(findMod(selId)) && n % 2 === 0) drawOverlay();
  n++;
}

function wire() {
  root.addEventListener("click", e => {
    const add = e.target.closest("[data-add]");
    if (add) { if (S.stack.length >= MAXM) return; const m = M(add.dataset.add); S.stack.push(m); selId = m.id; lookIdx = -1; renderLooks(); renderStack(); commit(); return; }
    const lk = e.target.closest("[data-look]"); if (lk) { applyLook(+lk.dataset.look); return; }
    onStackClick(e);
  });
  root.addEventListener("input", onStackInput);
  root.addEventListener("change", e => { if (e.target.dataset.tf) onStackInput(e); });
  side.addEventListener("click", e => {
    const b = e.target.closest("[data-view]");
    if (b) { S.view = +b.dataset.view; side.querySelectorAll(".wl-views [data-view]").forEach(x => x.setAttribute("aria-selected", x === b)); renderViewOpt(); return; }
    if (e.target.closest('[data-r="play"]')) setPlaying(!playing);
    if (e.target.closest('[data-r="restart"]')) seek(0);
  });
  $q("speed").onchange = e => speed = +e.target.value;
  $q("scrub").addEventListener("input", e => { setPlaying(false); seek(+e.target.value * 30); });
  const screen = $q("screen");
  screen.addEventListener("pointerdown", e => {
    const m = findMod(selId); if (!m) { host.toast("Select a module in the stack first"); return; }
    if (!usesPivot(m)) { host.toast(`${BY[m.key].name} has no pivot. Limit it to near or away under "Where" to place one.`); return; }
    dragging = true; screen.setPointerCapture(e.pointerId); movePivot(e);
  });
  screen.addEventListener("pointermove", e => { if (dragging) movePivot(e); });
  screen.addEventListener("pointerup", () => { if (dragging) { dragging = false; renderStack(); } });
  screen.addEventListener("pointercancel", () => dragging = false);
}

// ----------------------------------------------------------------------------- public
function sync() {
  if (!root) return;
  const d = host.get() || {}, sig = JSON.stringify(d);
  if (sig === lastSig) return;
  lastSig = sig;
  const old = S.stack, p = fromDict(d);
  S.stack = p.stack;
  if (p.unknown.length) host.toast(`Unknown feed modules ignored: ${p.unknown.join(", ")}`);
  S.stack.forEach((m, i) => { const o = old[i]; if (o && o.key === m.key) { m.open = o.open; m.ui = o.ui; m.solo = o.solo; if (o.id === selId) selId = m.id; } });
  if (!S.stack.some(m => m.id === selId)) selId = S.stack[0]?.id || 0;
  lookIdx = -1; runs.clear();
  renderLooks(); renderStack();
}
function show(on) { visible = on; if (on) { sizeCanvas(); renderViewOpt(); renderReadout(); drawLanesNow = true; } }
// for the editor's "What to expect": the modules that are on
function summary() { return { names: S.stack.filter(m => m.on).map(m => BY[m.key].name) }; }
function mount(opts) {
  host = opts; root = opts.root; side = opts.side;
  buildDom(); wire(); renderViewOpt(); setPlaying(playing);
  sync(); renderLooks(); renderStack();
  requestAnimationFrame(loop);
}
return { mount, sync, show, summary, _debug: () => ({ S, toDict, fromDict, fieldOf, stats: () => stats, step, seek, get frame() { return frame; }, get pic() { return pic; }, base: () => base }) };
})();
