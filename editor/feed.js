"use strict";
// The Feed tab: a stack of feed modules (the [feed] section of settings.ini) that add new material for the dream
// every frame, with a preview of what they add and how much of it the network actually receives. The preview runs
// the feed alone on a 2D canvas, without motion and without a network; dream.py (feed.py) does the real thing.
// Keep MODS in step with FEED_PARAMS and FEED_TEXT in feed.py.
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
const P = (k, label, min, max, step, def, unit = "") => ({ k, label, min, max, step, def, unit });
const LOCK = ["lock", "Attached to", [["screen", "Screen"], ["world", "World (moves with the picture)"]]];
const MODS = [
  { key: "grain", name: "Grain", fam: "Noise", blurb: "Random values the network can see: drawn at its painting sizes, held a while so the dream can grab them.",
    params: [P("amount", "Amount", 0, .05, .0005, .006), P("life", "Life", 0, 10, .05, 1.5, "s"), P("size", "Size", .005, .3, .001, .04)],
    text: [["grid", "Drawn at", [["matched", "Painting sizes"], ["pixel", "Every pixel (old noise)"], ["size", "Set size"]]], LOCK],
    init: { text: { lock: "world" }, mask: { mode: 1, radius: .45, soft: .6 } } },
  { key: "colour", name: "Colour patches", fam: "Noise", blurb: "Large, slow patches of colour that leave brightness alone. Borders to build separate things along.",
    params: [P("amount", "Amount", 0, .05, .0005, .008), P("size", "Patch size", .05, 1, .01, .3), P("life", "Life", .2, 20, .1, 3, "s")], text: [LOCK] },
  { key: "marble", name: "Marble", fam: "Noise", blurb: "Domain-warped fractal noise: veins, folds and contours, which the network reads as outlines.",
    params: [P("amount", "Amount", 0, .05, .0005, .006), P("scale", "Vein count", .3, 8, .05, 1.6), P("speed", "Change speed", 0, 1.5, .01, .15), P("fold", "Folding", 0, 3, .01, 1.5)], text: [LOCK] },
  { key: "turing", name: "Turing patterns", fam: "Noise", blurb: "A reaction–diffusion simulation runs beside the dream: spots that split, worms or mazes.",
    params: [P("amount", "Amount", 0, .05, .0005, .005), P("size", "Spot size", .01, .15, .001, .04), P("speed", "Speed", 0, 4, .01, 1)],
    text: [["pattern", "Pattern", [["spots", "Spots"], ["worms", "Worms"], ["maze", "Maze"]]], LOCK] },
  { key: "seeds", name: "Seeds", fam: "Things", blurb: "Dots, rings and dot-in-ring eyes dropped at a set rate, sized for the network to finish.",
    params: [P("rate", "Per second", 0, 20, .1, 3, "/s"), P("size", "Size", .01, .25, .001, .05), P("strength", "Strength", 0, 1, .01, .35), P("life", "Fade in/out", .1, 3, .05, .6, "s")],
    text: [["shape", "Shapes", [["mixed", "Mixed"], ["dots", "Dots"], ["rings", "Rings"], ["eyes", "Eyes"]]]] },
  { key: "mirror", name: "Mirror", fam: "Self", pivot: true, blurb: "Pulls the picture toward its own mirror image across a line through the pivot, so creatures face the camera.",
    params: [P("amount", "Pull", 0, 1, .01, .15, "/s"), P("angle", "Mirror line", -180, 180, 1, 90, "°")] },
  { key: "reseed", name: "Reseed", fam: "Events", pivot: true, disc: true, blurb: "Every few seconds a soft disc at the pivot gets fresh noise, like the video's start. Each one starts a new chapter.",
    params: [P("every", "Every", .5, 60, .5, 8, "s"), P("size", "Disc size", .05, 1.5, .01, .3), P("amount", "Amount", 0, 1, .01, .7), P("fade", "Fade in", 0, 3, .05, .5, "s")] },
  { key: "pictures", name: "Pictures", fam: "Events", pivot: true, disc: true, blurb: "Every few seconds one of your pictures dissolves into a soft disc at the pivot, for the dream to re-imagine.",
    params: [P("every", "Every", .5, 60, .5, 6, "s"), P("size", "Disc size", .05, 1.5, .01, .4), P("amount", "Amount", 0, 1, .01, .3), P("fade", "Fade in", 0, 3, .05, 1, "s")],
    text: [["folder", "Folder", null, "init_images"]] },
];
MODS.forEach((m, i) => m.idx = i);
const BY = Object.fromEntries(MODS.map(m => [m.key, m]));
const FAMS = [["Noise", "fields the network can see"], ["Things", "shapes for it to finish"], ["Self", "made from the picture"], ["Events", "now and then"]];
const SHAPES = { none: "Off", sine: "Sine", tri: "Triangle", saw: "Saw", pulse: "Pulse", noise: "Wander", ramp: "Ramp over video" };
const WHERE = ["Everywhere", "Near pivot", "Away from pivot", "Where the dream is idle"];
const ADDITIVE = ["grain", "colour", "marble", "turing"];
const COLORS = ["#3fc6bd", "#f5d76e", "#f0a24a", "#a78bfa", "#ff6b6b", "#7dd3fc", "#86efac", "#f9a8d4"];

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
function paramAt(m, p, t) {
  const md = m.mod[p.k]; let v = m.vals[p.k];
  if (md.shape !== "none") v += md.shape === "ramp" ? md.depth * (p.max - p.min) * wave(md, t) : md.depth * (p.max - p.min) / 2 * wave(md, t);
  return clamp(v, p.min, p.max);
}
const active = () => { const on = S.stack.filter(m => m.on); const so = on.filter(m => m.solo); return so.length ? so : on; };
const usesPivot = m => BY[m.key].pivot || m.mask.mode === 1 || m.mask.mode === 2;

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
      const curve = md.shape === "none" ? "" : md.shape === "ramp" ? ` ~ ramp(depth=${num(md.depth)})`
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
      if (r[2] && SHAPES[r[2]]) {
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

// ----------------------------------------------------------------------------- preview fields
// Everything is a planar Float32Array: channel c, row y, column x at c*PW*PH + y*PW + x.
const gauss = () => (Math.random() + Math.random() - 1) * 2.449;
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

const runs = new Map();   // module id -> preview state
function stateOf(m) { let r = runs.get(m.id); if (!r || r.key !== m.key) { r = { key: m.key }; runs.set(m.id, r); } return r; }

// One frame of a module at time t: { add, seen, reach } (add/seen are 3-channel fields of what goes into the
// picture this frame and what the network gets of it), or null when it adds nothing this frame.
function fieldOf(m, t) {
  const r = stateOf(m), v = Object.fromEntries(BY[m.key].params.map(p => [p.k, paramAt(m, p, t)])), N = PW * PH;
  const H = renderH(), sm = Math.min(...scalesOf()), [nr, nc] = dims(H * sm);
  const mask = maskOf(m);
  const finish = (f, amount, pixel = false) => {
    if (mask) for (let c = 0; c < 3; c++) for (let i = 0; i < N; i++) f[c * N + i] *= mask[i];
    for (let i = 0; i < f.length; i++) f[i] *= amount;
    const seen = pixel ? f.map(x => x * pixelReach(sm)) : shrink(f, nr, nc, 3);
    return { add: f, seen, reach: rms(f) > 1e-9 ? rms(seen) / rms(f) : 0 };
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
    const hh = PH >> 1, ww = PW >> 1, low = new Float32Array(3 * hh * ww), tt = t * v.speed;
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
    let n = 0, L = Math.exp(-v.rate * DT), p = Math.random(); while (p > L) { n++; p *= Math.random(); }   // Poisson
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
    for (const s of r.seeds) {
      const env = Math.sin(Math.PI * (t - s.t0) / s.life) * Math.PI / 2 / (s.life * 30);
      for (let y = 0; y < PH; y++) { const py = 1 - (y + .5) / PH * 2; if (Math.abs(py - s.y) > s.r * 2.2) continue;
        for (let x = 0; x < PW; x++) { const px = ((x + .5) / PW * 2 - 1) * A; if (Math.abs(px - s.x) > s.r * 2.2) continue;
          const d = Math.hypot(px - s.x, py - s.y) / s.r, dot = Math.exp(-2.5 * d * d), ring = Math.exp(-(((d - 1) / .3) ** 2));
          const pr = s.kind === 0 ? dot : s.kind === 1 ? ring : ring - 1.3 * Math.exp(-12 * d * d);
          for (let c = 0; c < 3; c++) f[c * N + y * PW + x] += v.strength * env * pr * s.col[c]; } }
    }
    const seen = shrink(f, nr, nc, 3);
    return { add: f, seen, reach: rms(f) > 1e-9 ? rms(seen) / rms(f) : 0 };
  }
  if (m.key === "reseed" || m.key === "pictures") {
    const every = Math.max(.5, m.vals.every), n = Math.floor(t / every);
    if (n < 1 || t - n * every >= Math.max(v.fade, DT)) return null;
    if (r.n !== n) { r.n = n; r.src = unit(upsample(grid(9, 16, 3), 9, 16, 3)); }
    const k = v.fade > DT ? 1 - (1 - Math.min(v.amount, .999)) ** (DT / v.fade) : v.amount, f = new Float32Array(3 * N);
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
      const d = Math.hypot(((x + .5) / PW * 2 - 1) * A - m.pivot[0], 1 - (y + .5) / PH * 2 - m.pivot[1]);
      const disc = 1 - smooth((d - v.size * .6) / (v.size * .8));
      for (let c = 0; c < 3; c++) f[c * N + y * PW + x] = k * disc * .25 * r.src[c * N + y * PW + x];
    }
    return { add: f, seen: shrink(f, nr, nc, 3), reach: 1, event: true };
  }
  return null;   // mirror: shown as its line on the preview
}
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
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
// known without the dream, so the preview shows it as everywhere.
function maskOf(m) {
  const { mode, radius, soft } = m.mask;
  if (mode !== 1 && mode !== 2) return null;
  const mk = new Float32Array(PW * PH), lo = radius * (1 - soft), hi = radius * (1 + soft) + 1e-3;
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const r = Math.hypot(((x + .5) / PW * 2 - 1) * A - m.pivot[0], 1 - (y + .5) / PH * 2 - m.pivot[1]), inside = 1 - smooth((r - lo) / (hi - lo));
    mk[y * PW + x] = mode === 1 ? inside : 1 - inside;
  }
  if (ADDITIVE.includes(m.key)) { const g = 1 / (rms(mk) + 1e-6); for (let i = 0; i < mk.length; i++) mk[i] = Math.min(3, mk[i] * g); }
  return mk;
}

// ----------------------------------------------------------------------------- DOM
let root, side, $q, $$, cv, ctx, img, visible = false, playing = !matchMedia("(prefers-reduced-motion: reduce)").matches, frame = 0;
const fmtv = (v, st) => (+v).toFixed(Math.min(4, decimals(st)));
function buildDom() {
  root.innerHTML = `<div class="wl">
    <div class="wl-head"><h3>Feed stack</h3><span class="sub">new material for the dream, added every frame after the motion · modules run top to bottom</span></div>
    <div class="wl-head"><span class="sub">Looks:</span><div class="chips" data-r="looks"></div></div>
    <div class="wl-stack" data-r="stack"></div>
    <details class="wl-add" open data-r="addbox"><summary>Add a feed <span>what each one adds, on a grey picture</span></summary><div data-r="catalog"></div></details>
  </div>`;
  side.innerHTML = `<div class="wl-mon">
      <div class="tabs wl-views" role="tablist" aria-label="Preview view">
        <button role="tab" data-view="0" aria-selected="true" title="What the feed adds to the picture this frame">Added</button>
        <button role="tab" data-view="1" aria-selected="false" title="The same after the shrink to your smallest painting size, which is what the network looks at">Seen by the network</button>
        <button role="tab" data-view="2" aria-selected="false" title="Where each module adds its material">Where</button>
      </div>
      <div class="viewer">
        <div class="screen wl-screen" data-r="screen"><canvas data-r="cv" aria-label="Feed preview"></canvas><svg data-r="ov" aria-hidden="true"></svg>
          <span class="badge">Feed only · no motion, no dream</span></div>
        <div class="vbar wl-vo" data-r="vo"></div>
      </div>
      <div class="wl-tr">
        <button class="btn" type="button" data-r="play">Pause</button>
        <button class="btn" type="button" data-r="restart" title="Start again from the first frame">Restart</button>
        <span class="clock" data-r="clock">0.0 s</span>
      </div>
    </div>
    <div class="readout"><h2>Feed check</h2><dl class="facts" data-r="facts"></dl><div class="warnings" data-r="warnings"></div></div>`;
  $q = r => root.querySelector(`[data-r="${r}"]`) || side.querySelector(`[data-r="${r}"]`);
  $$ = sel => [...root.querySelectorAll(sel), ...side.querySelectorAll(sel)];
  cv = $q("cv"); ctx = cv.getContext("2d");
}
function paramRow(m, p) {
  const md = m.mod[p.k], id = `fl${m.id}-${p.k}`, on = md.shape !== "none", open = !!m.ui[p.k];
  return `<div class="wl-p" data-id="${m.id}" data-k="${p.k}">
    <label for="${id}" title="${esc(p.label)}${p.unit ? " (" + p.unit + ")" : ""}">${esc(p.label)}<code>${p.k}</code></label>
    <input type="range" id="${id}" data-f="val" min="${p.min}" max="${p.max}" step="${p.step}" value="${m.vals[p.k]}">
    <input type="number" data-f="val" aria-label="${esc(p.label)} value" min="${p.min}" max="${p.max}" step="${p.step}" value="${fmtv(m.vals[p.k], p.step)}">
    <button class="wl-wv${on ? " on" : ""}" type="button" data-act="wave" aria-expanded="${open}" title="Make this setting change over the video">∿</button>
  </div>
  <div class="wl-curve" data-id="${m.id}" data-k="${p.k}" ${open ? "" : "hidden"}>
    <label>Curve <select data-f="shape">${Object.entries(SHAPES).map(([s, l]) => `<option value="${s}" ${s === md.shape ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label ${md.shape === "ramp" ? "hidden" : ""}>Period <input type="number" data-f="period" min="0.5" max="120" step="0.5" value="${md.period}"> s</label>
    <label>Depth <input type="range" data-f="depth" min="-1" max="1" step="0.01" value="${md.depth}"></label>
    <label ${md.shape === "ramp" ? "hidden" : ""}>Phase <input type="range" data-f="phase" min="0" max="1" step="0.01" value="${md.phase}"></label>
    <canvas width="260" height="44" aria-hidden="true"></canvas>
  </div>`;
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
    const d = BY[m.key], modes = d.disc ? [] : m.key === "seeds" ? [0, 1, 2, 3] : [0, 1, 2, 3];
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
        ${d.params.map(p => paramRow(m, p)).join("")}
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
  if (act === "solo") { m.solo = !m.solo; renderStack(); return; }   // preview only, not saved
  if (act === "up" && i > 0) { S.stack.splice(i, 1); S.stack.splice(i - 1, 0, m); }
  else if (act === "down" && i < S.stack.length - 1) { S.stack.splice(i, 1); S.stack.splice(i + 1, 0, m); }
  else if (act === "on") m.on = !m.on;
  else if (act === "del") { S.stack.splice(i, 1); runs.delete(m.id); if (selId === m.id) selId = S.stack[0]?.id || 0; }
  else if (act === "center") m.pivot = [0, 0];
  else if (act === "mask") { m.mask.mode = +b.dataset.mode; selId = m.id; }
  else if (act === "text") { m.text[b.dataset.k] = b.dataset.v; runs.delete(m.id); }
  else return;
  lookIdx = -1; renderLooks(); renderStack(); commit();
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
    const cr = row.nextElementSibling; if (!cr.hidden) drawSpark(cr);
  } else if (f === "radius" || f === "soft") { m.mask[f] = +el.value; drawOverlay(); }
  else {
    const row = el.closest(".wl-curve"), md = m.mod[row.dataset.k];
    if (f !== "shape" && (el.value === "" || !isFinite(+el.value))) return;
    md[f] = f === "shape" ? el.value : f === "period" ? Math.max(.5, +el.value) : +el.value;
    if (f === "shape") { row.previousElementSibling.querySelector(".wl-wv").classList.toggle("on", md.shape !== "none");
      row.querySelectorAll("label").forEach((l, k) => { if (k === 1 || k === 3) l.hidden = md.shape === "ramp"; }); }
    drawSpark(row);
  }
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
function applyLook(i) { lookIdx = i; S.stack = LOOKS[i][1](); runs.clear(); selId = S.stack[0]?.id || 0; renderLooks(); renderStack(); commit(); restart(); }
function afterStructure() { renderCatalog(); drawOverlay(); }

// small pictures of each module, drawn once from the preview's own maths
const glyphs = {};
function glyphFor(key) {
  const m = M(key, key === "seeds" ? { rate: 20, size: .12 } : {}), oldA = A, oldW = PW; A = 16 / 9; PW = 256;
  let f = null; for (let k = 0; k < 40 && !f; k++) { const r = fieldOf(m, 1.0 + k * DT * (key === "reseed" || key === "pictures" ? 0 : 1)); f = r && r.add; }
  if (key === "reseed" || key === "pictures") { m.vals.every = 1; const r = fieldOf(m, 1.01); f = r && r.add; }
  runs.delete(m.id); A = oldA; PW = oldW;
  const c = document.createElement("canvas"); c.width = 256; c.height = 144; const x = c.getContext("2d"), im = x.createImageData(256, 144), N = 256 * 144;
  const g = f ? .22 / (rms(f) + 1e-9) : 0;
  for (let i = 0; i < N; i++) for (let ch = 0; ch < 3; ch++) im.data[i * 4 + ch] = clamp(40 + 255 * g * (f ? f[ch * N + i] : 0), 0, 255);
  for (let i = 0; i < N; i++) im.data[i * 4 + 3] = 255;
  x.putImageData(im, 0, 0);
  if (key === "mirror") { x.strokeStyle = "#3fc6bd"; x.lineWidth = 6; x.setLineDash([14, 10]); x.beginPath(); x.moveTo(128, 0); x.lineTo(128, 144); x.stroke();
    x.fillStyle = "#e7e9ee"; x.font = "bold 64px sans-serif"; x.textAlign = "center"; x.fillText("◐", 128, 96); }
  return c;
}
function paintGlyph(c, key) {
  if (!glyphs[key]) glyphs[key] = glyphFor(key);
  const r = c.getBoundingClientRect(), w = Math.max(1, Math.round((r.width || 56) * 2)), h = Math.max(1, Math.round((r.height || 32) * 2));
  c.width = w; c.height = h; c.getContext("2d").drawImage(glyphs[key], 0, 0, w, h);
}

// ----------------------------------------------------------------------------- overlay: pivot, ring, mirror line, disc
function drawOverlay() {
  const ov = $q("ov"); ov.setAttribute("viewBox", `${-A} -1 ${2 * A} 2`);
  const m = findMod(selId);
  if (!m) { ov.innerHTML = ""; return; }
  const [x, y] = m.pivot; let s = "";
  if (m.mask.mode === 1 || m.mask.mode === 2) s += `<circle cx="${x}" cy="${y}" r="${m.mask.radius}" fill="none" stroke="#f5d76e" stroke-width="0.008" stroke-dasharray="0.03 0.02"/>`;
  if (BY[m.key].disc) s += `<circle cx="${x}" cy="${y}" r="${m.vals.size}" fill="none" stroke="#e7e9ee" stroke-opacity=".6" stroke-width="0.008" stroke-dasharray="0.02 0.02"/>`;
  if (m.key === "mirror") { const an = m.vals.angle * Math.PI / 180, L = 3; s += `<line x1="${x - Math.cos(an) * L}" y1="${y - Math.sin(an) * L}" x2="${x + Math.cos(an) * L}" y2="${y + Math.sin(an) * L}" stroke="#3fc6bd" stroke-width="0.012" stroke-dasharray="0.05 0.03"/>`; }
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

// ----------------------------------------------------------------------------- preview loop and readout
let last = 0, gain = 0, stats = [];
function sizeCanvas() {
  const r = host.render() || {}, a = (+r.width || 1920) / (+r.height || 1080);
  if (Math.abs(a - A) > 1e-3 || !img) { A = a; PW = Math.round(PH * A); runs.clear(); cv.width = PW; cv.height = PH; img = ctx.createImageData(PW, PH);
    $q("screen").style.aspectRatio = `${PW} / ${PH}`; side.style.setProperty("--wl-aspect", A); drawOverlay(); }
}
function restart() { frame = 0; runs.clear(); gain = 0; }
function step() {
  const t = frame * DT, N = PW * PH, add = new Float32Array(3 * N), seen = new Float32Array(3 * N), mods = active();
  stats = [];
  for (const m of mods) {
    const r = fieldOf(m, t);
    if (r) { for (let i = 0; i < add.length; i++) { add[i] += r.add[i]; seen[i] += r.seen[i]; } }
    stats.push({ m, r });
  }
  // keep the display gain steady: aim the additive part at a visible contrast, follow slowly
  const target = .22 / (rms(add) + 1e-9);
  gain = gain ? gain * .9 + Math.min(target, 4000) * .1 : Math.min(target, 4000);
  draw(S.view === 0 ? add : S.view === 1 ? seen : null, mods);
  frame++;
}
function draw(f, mods) {
  const N = PW * PH, d = img.data;
  if (f) for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(128 + 255 * gain * f[c * N + i], 0, 255);
  else {   // where: each module's mask in its own colour
    d.fill(0);
    mods.forEach((m, k) => {
      const mk = maskOf(m), col = COLORS[k % COLORS.length].match(/\w\w/g).map(h => parseInt(h, 16)), mx = mk ? maskMax(mk) : 1;
      for (let i = 0; i < N; i++) { const w = (mk ? mk[i] / mx : 1) * (m.mask.mode === 3 ? .35 : .55) / Math.max(1, mods.length * .7); for (let c = 0; c < 3; c++) d[i * 4 + c] = Math.min(255, d[i * 4 + c] + col[c] * w); }
    });
  }
  for (let i = 0; i < N; i++) d[i * 4 + 3] = 255;
  ctx.putImageData(img, 0, 0);
  $q("clock").textContent = `${(frame * DT).toFixed(1)} s`;
}
function renderViewOpt() {
  const vo = $q("vo"), H = renderH(), sm = Math.min(...scalesOf());
  if (S.view === 0) vo.innerHTML = `<span>What the feed adds this frame, on grey, shown ×<span data-r="gainl"></span> so it is visible. In a render it lands on the moved picture.</span>`;
  else if (S.view === 1) vo.innerHTML = `<span>The same after the shrink to scale ${sm} (${Math.round(H * sm)} lines of ${H}), at the same brightness as Added. Whatever is flat here never reaches the network.</span>`;
  else vo.innerHTML = `<span>Where each module adds its material. ${S.stack.some(m => m.mask.mode === 3) ? "“Idle” follows the dream, so here it shows as faint everywhere." : ""}</span>`;
}
function stepCost() {   // one dream step per frame at the editor's settings, in picture units, as dream.py
  const r = host.render() || {}, fps = +r.fps || 30;
  return (+r.strength || 1) / 255 * 30 / fps * Math.max(1, +r.steps || 1);
}
function bar(v, max, cls = "") { return `<span class="wl-bar ${cls}"><div style="width:${clamp(v / max, 0, 1) * 100}%"></div></span>`; }
function renderReadout() {
  const facts = [], W = [], add = (lvl, html) => W.push(`<div class="w ${lvl}">${html}</div>`);
  const sm = Math.min(...scalesOf()), dstep = stepCost(), motion = host.motion?.() || [];
  if (!S.stack.length) facts.push(`<dt>Feed</dt><dd>none: new material comes only from the motion and the dream</dd>`);
  for (const { m, r } of stats) {
    const d = BY[m.key], name = d.name;
    if (ADDITIVE.includes(m.key)) {
      const reach = m.key === "grain" && m.text.grid === "pixel" ? pixelReach(sm) : r ? r.reach : 0, cls = reach < .3 ? "bad" : reach < .6 ? "warn" : "";
      const per = m.vals.amount * (m.mask.mode ? 1 : 1) / dstep;
      facts.push(`<dt>${esc(name)}</dt><dd><b>${Math.round(reach * 100)}%</b>${bar(reach, 1, cls)}<span class="status">reaches the network · ${per < .1 ? per.toFixed(2) : per.toFixed(1)}× a dream step per frame</span></dd>`);
      if (m.key === "grain" && m.text.grid === "pixel") add("warn", `<b>${esc(name)}: one value per pixel.</b> The network looks at a ${Math.round(sm * 100)}% size copy, so about ${Math.round(pixelReach(sm) * 100)}% of it gets through. Draw it at the painting sizes instead.`);
      const held = m.key !== "grain" || m.vals.life > .3 || m.text.lock === "world";
      if (held && m.vals.amount / dstep > .8) add("warn", `<b>${esc(name)} is strong for a held pattern.</b> It is added again every frame, so it can burn into blotches. Try below ${(dstep * .6).toFixed(3)}.`);
    } else if (m.key === "seeds") facts.push(`<dt>${esc(name)}</dt><dd><b>${m.vals.rate.toFixed(1)}/s</b><span class="status">${Math.round(m.vals.rate * m.vals.life * 10) / 10} on screen at a time, ${Math.round(m.vals.size * renderH())} px across</span></dd>`);
    else if (m.key === "mirror") facts.push(`<dt>${esc(name)}</dt><dd><b>${Math.round(m.vals.amount * 100)}%</b><span class="status">of the way to the mirror image each second</span></dd>`);
    else facts.push(`<dt>${esc(name)}</dt><dd><b>every ${m.vals.every} s</b><span class="status">${Math.round(m.vals.amount * 100)}% into a disc ${m.vals.size.toFixed(2)} wide${m.key === "pictures" ? `, from ${esc(m.text.folder)}\\` : ""}</span></dd>`);
    if (m.text?.lock === "world" && !motion.length) add("", `<b>${esc(name)} is attached to the world,</b> but the Motion tab's stack is empty, so there is nothing to carry it.`);
  }
  if (S.stack.some(m => m.mask.mode === 1 || m.mask.mode === 2) && motion.length && !motion.every(n => /zoom/i.test(n)))
    add("", "Near / away masks are placed by the pivot. With motion other than a centred zoom, new things live longest where the motion pulls the picture apart; the Motion tab's Stress view shows where.");
  if (S.stack.some(m => m.solo)) add("", "<b>Solo is on.</b> The preview shows only the soloed modules; the render uses every module that is on.");
  if (!W.length) add("", "No known problems with this feed.");
  $q("facts").innerHTML = facts.join(""); $q("warnings").innerHTML = W.join("");
  const gl = $q("gainl"); if (gl) gl.textContent = Math.round(gain);
}
function loop(ts) {
  requestAnimationFrame(loop);
  if (!visible) return;
  if (ts - last < 1000 / 30 - 2) return;
  last = ts; sizeCanvas();
  if (playing || frame === 0) { step(); if (frame % 8 === 1) renderReadout(); }
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
    if (e.target.closest('[data-r="play"]')) { playing = !playing; $q("play").textContent = playing ? "Pause" : "Play"; }
    if (e.target.closest('[data-r="restart"]')) restart();
  });
  cv.addEventListener("pointerdown", e => { const m = findMod(selId); if (!m || !usesPivot(m)) return; dragging = true; cv.setPointerCapture(e.pointerId); movePivot(e); });
  cv.addEventListener("pointermove", e => { if (dragging) movePivot(e); });
  cv.addEventListener("pointerup", () => { dragging = false; renderStack(); });
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
function show(on) { visible = on; if (on) { sizeCanvas(); renderViewOpt(); renderReadout(); } }
// for the editor's "What to expect": the modules that are on
function summary() { return { names: S.stack.filter(m => m.on).map(m => BY[m.key].name) }; }
function mount(opts) {
  host = opts; root = opts.root; side = opts.side;
  buildDom(); wire(); renderViewOpt();
  $q("play").textContent = playing ? "Pause" : "Play";
  sync(); renderLooks(); renderStack();
  requestAnimationFrame(loop);
}
return { mount, sync, show, summary, _debug: () => ({ S, toDict, fromDict, fieldOf, stats: () => stats }) };
})();
