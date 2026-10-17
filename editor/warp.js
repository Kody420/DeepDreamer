"use strict";
// The Motion tab: a stack of motion modules (the [warp] section of settings.ini) with a live preview of what they
// do to a picture. The preview runs only the warp, in WebGL, on a stand-in picture; dream.py (warp_stack) applies
// the same maths in the real render. Keep MODS in step with WARP_PARAMS there.
//
// index.html mounts it with   WarpLab.mount({ root, side, extra, get, set, render, toast, player, live, imageUrl })
// (root: the stack, in the settings window; side: the preview, in the monitor on the right)
// and calls sync() whenever cur.warp may have changed from outside (load, revert, gallery), show() on tab switches.
window.WarpLab = (() => {
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fract = x => x - Math.floor(x);
const decimals = st => { const s = String(st); return s.includes(".") ? s.split(".")[1].length : 0; };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const DT = 1 / 30, SH = 288, GH = 180, MAXM = 8;
let A = 16 / 9, SW = 512, GW = 320;   // aspect follows the render size

// ----------------------------------------------------------------------------- catalog
const P = (k, label, min, max, step, def, unit = "") => ({ k, label, min, max, step, def, unit });
const MODS = [
  { key: "zoom", name: "Zoom", fam: "Camera", pivot: true, blurb: "Fall into the picture. Tunnel bend makes the rim fall faster than the middle.",
    params: [P("rate", "Speed", -1.5, 1.5, .01, .2, "/s"), P("bend", "Tunnel bend", -1, 2, .01, 0)] },
  { key: "spin", name: "Spin", fam: "Camera", pivot: true, blurb: "Roll the whole frame around the pivot. On a sine curve it wobbles back and forth.",
    params: [P("rate", "Turn", -1, 1, .005, .1, "rad/s")] },
  { key: "drift", name: "Drift", fam: "Camera", blurb: "Slide the picture sideways, like a camera pan.",
    params: [P("speed", "Speed", 0, 1, .01, .15, "/s"), P("angle", "Direction", -180, 180, 1, 90, "°")] },
  { key: "tilt", name: "Tilt", fam: "Camera", pivot: true, blurb: "Lean the picture plane: one side recedes, the other rushes past. Shear skews it.",
    params: [P("tx", "Lean sideways", -1, 1, .01, 0), P("ty", "Lean forward", -1, 1, .01, .35), P("shear", "Shear", -1, 1, .01, 0)] },
  { key: "shake", name: "Handheld", fam: "Camera", blurb: "Smooth jitter and roll, like a held camera. It shakes but never wanders off.",
    params: [P("amp", "Shake", 0, .08, .001, .015), P("rate", "Speed", .2, 8, .1, 1.5, "Hz"), P("roll", "Roll", 0, .08, .001, .01, "rad")] },
  { key: "swirl", name: "Swirl", fam: "Bend", pivot: true, blurb: "Turn the middle faster than the edges, winding the picture into spiral arms.",
    params: [P("rate", "Turn", -3, 3, .01, 1, "rad/s"), P("size", "Size", .05, 2, .01, .5), P("tail", "Long tail", 0, 1, .01, .3)] },
  { key: "bulge", name: "Bulge", fam: "Bend", pivot: true, blurb: "Inflate one spot, or pinch it with negative strength. The spot can orbit the pivot.",
    params: [P("k", "Strength", -3, 3, .01, 1.2, "/s"), P("size", "Size", .05, 1.5, .01, .35), P("orbit", "Orbit radius", 0, 1.2, .01, .5), P("speed", "Orbit speed", -3, 3, .01, .6, "rad/s")] },
  { key: "mobius", name: "Möbius", fam: "Bend", pivot: true, blurb: "A conformal bend. Shapes slide along circles toward a turning pole and keep their local shape.",
    params: [P("k", "Strength", -1.5, 1.5, .01, .35, "/s"), P("spin", "Pole turn", -2, 2, .01, .3, "rad/s"), P("phase", "Pole angle", -180, 180, 1, 0, "°")] },
  { key: "kaleido", name: "Kaleidoscope", fam: "Symmetry", pivot: true, blurb: "Fold the frame into mirrored wedges every frame. Turning the mirrors makes the pattern bloom.",
    params: [P("n", "Wedges", 2, 16, 1, 6), P("spin", "Mirror turn", -1, 1, .005, .08, "rad/s"), P("mix", "Amount", 0, 1, .01, 1)] },
  { key: "ripple", name: "Ripple", fam: "Flow", pivot: true, blurb: "Travelling waves push pixels back and forth, like water or heat haze.",
    params: [P("amp", "Push", 0, 2, .01, .4, "/s"), P("freq", "Waves", .5, 20, .1, 5), P("speed", "Wave speed", -12, 12, .1, 4, "rad/s"), P("radial", "Lines ↔ rings", 0, 1, .01, 1), P("angle", "Line direction", -180, 180, 1, 0, "°")] },
  { key: "flow", name: "Liquid", fam: "Flow", blurb: "Smooth swirling currents from curl noise. Shapes drift and fold like ink in water.",
    params: [P("amp", "Current", 0, 2, .01, .4, "/s"), P("scale", "Eddy count", .3, 8, .05, 1.6), P("speed", "Change speed", 0, 1.5, .01, .2), P("detail", "Small eddies", 0, 1, .01, .35)] },
  { key: "melt", name: "Melt", fam: "Flow", blurb: "Columns slide at different speeds, so the picture drips or rises in streaks.",
    params: [P("speed", "Speed", -1, 1, .01, .25, "/s"), P("angle", "Direction", -180, 180, 1, -90, "°"), P("streaks", "Streaks", 1, 60, 1, 12), P("vary", "Unevenness", 0, 1, .01, .7), P("wobble", "Change speed", 0, 2, .01, .3)] },
  { key: "edge", name: "Contour flow", fam: "Self-driven", blurb: "The picture moves itself: pixels slide along or across its own edges, so it reacts to what the dream draws.",
    params: [P("amp", "Strength", 0, 2, .01, .6), P("angle", "Across ↔ along", -180, 180, 1, 90, "°"), P("reach", "Edge width", .5, 6, .1, 2)] },
  { key: "video", name: "Video motion", fam: "From a clip", blurb: "Moves the dream the way a chosen clip moves: its optical flow, or the codec's own motion vectors for a glitchier look.",
    params: [P("amp", "Strength", 0, 3, .01, 1), P("speed", "Clip speed", .1, 4, .01, 1, "×"), P("smooth", "Smooth", 0, 1, .01, .3), P("offset", "Start in clip", 0, 1, .01, 0)] },
];
MODS.forEach((m, i) => m.idx = i);
const BY = Object.fromEntries(MODS.map(m => [m.key, m]));
const FAMS = [["Camera", "moves the whole frame"], ["Bend", "warps parts of it"], ["Symmetry", ""], ["Flow", "moving fields"], ["Self-driven", "follows the picture"], ["From a clip", "moves like a video you choose"]];
const EDGES = ["reflect", "wrap", "smear"];
const SHAPES = { none: "Off", sine: "Sine", tri: "Triangle", saw: "Saw", pulse: "Pulse", noise: "Wander", ramp: "Ramp over video" };

// ----------------------------------------------------------------------------- state
let uid = 1, selId = 0, host = null, lastSig = null, lookIdx = -1;
const MODDEF = { shape: "none", period: 8, depth: .5, phase: 0 };
function M(key, vals = {}, mods = {}) {
  const d = BY[key], m = { id: uid++, key, on: true, solo: false, open: true, vals: {}, mod: {}, ui: {}, pivot: [0, 0], mask: { mode: 0, radius: .6, soft: .4 } };
  d.params.forEach(p => { m.vals[p.k] = vals[p.k] ?? p.def; m.mod[p.k] = { ...MODDEF, ...(mods[p.k] || {}) }; });
  if (key === "video") Object.assign(m, { clip: "", source: "flow", loop: "loop", gaps: "hold" });   // the text settings of [warp]
  return m;
}
const S = { stack: [], prism: 0, edge: 0, fresh: .008, sharp: .12, T: 20, view: 0, gridWin: 1, gain: 0, autoGain: true, smode: 0 };

const LOOKS = [
  ["Zoom + wobble", () => [M("zoom", { rate: .2 }), M("spin", { rate: 0 }, { rate: { shape: "sine", period: 20.94, depth: .12 } })]],
  ["Whirlpool", () => [M("zoom", { rate: .25 }), M("swirl", { rate: 1.2, size: .45, tail: .4 }), M("spin", { rate: -.1 })]],
  ["Melting wall", () => [M("zoom", { rate: .08 }), M("melt", { speed: .2, streaks: 12, vary: .4 }), M("flow", { amp: .1 })]],
  ["Ink in water", () => [M("flow", { amp: .3, scale: 1.2, speed: .25, detail: .4 }), M("zoom", { rate: .05 })]],
  ["Kaleido tunnel", () => [M("zoom", { rate: .25, bend: .15 }), M("kaleido", { n: 6, spin: .06 }), M("spin", { rate: .15 })]],
  ["Breathing", () => [M("zoom", { rate: 0 }, { rate: { shape: "sine", period: 6, depth: .27 } }), M("bulge", { k: .15, orbit: 0, size: .6 }, { k: { shape: "sine", period: 6, depth: .04, phase: .25 } })]],
  ["Underwater", () => [M("ripple", { amp: .1, freq: 3, speed: 3, radial: .2, angle: 90 }), M("flow", { amp: .12 }), M("zoom", { rate: .06 })], { prism: .003 }],
  ["Orbiting drain", () => [M("zoom", { rate: .1 }), M("bulge", { k: -1.2, size: .4, orbit: .55, speed: .5 }), M("swirl", { rate: .5, size: .6 })]],
  ["Möbius drift", () => [M("mobius", { k: .18, spin: .25 }), M("zoom", { rate: .1 })]],
  ["Contour lava", () => [M("edge", { amp: .15, angle: 90 }), M("flow", { amp: .1 }), M("zoom", { rate: .05 })]],
  ["Handheld dive", () => [M("zoom", { rate: .25 }), M("shake", { amp: .015 }), M("tilt", { ty: 0 }, { ty: { shape: "sine", period: 12, depth: .2 } })]],
  ["Slow build", () => [M("zoom", { rate: .2 }), M("swirl", { rate: 0 }, { rate: { shape: "ramp", depth: .15 } }), M("melt", { speed: 0 }, { speed: { shape: "ramp", depth: .1 } })]],
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

// ----------------------------------------------------------------------------- [warp] section <-> stack
const num = (v, st = .0001) => String(+(+v).toFixed(Math.min(4, Math.max(decimals(st), 2))));
function toDict() {
  const d = {}, counts = {}, names = S.stack.map(m => { counts[m.key] = (counts[m.key] || 0) + 1; return counts[m.key] > 1 ? m.key + counts[m.key] : m.key; });
  d.stack = names.join(", "); d.edge = EDGES[S.edge]; d.prism = num(S.prism);
  S.stack.forEach((m, i) => {
    const n = names[i];
    if (!m.on) d[`${n}.on`] = "no";
    if (m.key === "video") {
      d[`${n}.clip`] = m.clip; d[`${n}.source`] = m.source; d[`${n}.loop`] = m.loop;
      if (m.source === "codec") d[`${n}.gaps`] = m.gaps;
    }
    for (const p of BY[m.key].params) {
      const md = m.mod[p.k];
      const curve = md.shape === "none" ? "" : md.shape === "ramp" ? ` ~ ramp(depth=${num(md.depth)})`
        : ` ~ ${md.shape}(period=${num(md.period)}, depth=${num(md.depth)}${md.phase ? `, phase=${num(md.phase)}` : ""})`;
      d[`${n}.${p.k}`] = num(m.vals[p.k], p.step) + curve;
    }
    if (m.pivot[0] || m.pivot[1]) d[`${n}.pivot`] = `${num(m.pivot[0])}, ${num(m.pivot[1])}`;
    if (m.mask.mode) d[`${n}.where`] = `${m.mask.mode === 1 ? "near" : "away"} ${num(m.mask.radius)} soft ${num(m.mask.soft)}`;
  });
  return d;
}
function fromDict(d) {
  const stack = [], unknown = [];
  for (const name of String(d.stack || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)) {
    const key = name.replace(/\d+$/, "");
    if (!BY[key]) { unknown.push(name); continue; }
    const m = M(key);
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
    const pv = String(d[`${name}.pivot`] || "").split(",").map(Number);
    if (pv.length === 2 && pv.every(isFinite)) m.pivot = pv;
    const w = String(d[`${name}.where`] || "").trim().split(/\s+/);
    if (key === "video") {
      m.clip = String(d[`${name}.clip`] || "").trim();
      const pickv = (k, list, def) => { const v = String(d[`${name}.${k}`] || "").trim().toLowerCase(); return list.includes(v) ? v : def; };
      m.source = pickv("source", ["flow", "codec"], "flow"); m.loop = pickv("loop", ["loop", "pingpong", "hold"], "loop"); m.gaps = pickv("gaps", ["zero", "hold"], "hold");
    }
    if (w[0] === "near" || w[0] === "away") m.mask = { mode: w[0] === "near" ? 1 : 2, radius: +w[1] || .6, soft: isFinite(+w[3]) ? +w[3] : .4 };
    stack.push(m);
  }
  return { stack, edge: Math.max(0, EDGES.indexOf(String(d.edge || "reflect").trim())), prism: +d.prism || 0, unknown };
}
// every edit ends here: the stack is written into cur.warp, which the editor counts as unsaved changes
function commit() {
  const d = toDict(); lastSig = JSON.stringify(d);
  host.set(d); markChanged(); drawLanesNow = true;
}

// ----------------------------------------------------------------------------- GLSL (same maths as warp_stack in dream.py)
const VS_FULL = `#version 300 es
out vec2 v_uv; void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); v_uv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
const COMMON = `
precision highp float; precision highp int;
const float DT = 1.0/30.0;
uniform float u_t; uniform float u_aspect; uniform vec2 u_simres; uniform int u_edge;
uniform int u_n; uniform int u_type[8]; uniform vec4 u_a[8]; uniform vec4 u_b[8]; uniform vec4 u_c[8];
uniform sampler2D u_img;
uniform sampler2D u_vf; uniform vec4 u_vdim;   // video motion: field strip (w, h, frames, clip aspect)
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,s,-s,c); }
float h13(vec3 p){ p=fract(p*0.1031); p+=dot(p,p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vn3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(h13(i),h13(i+vec3(1,0,0)),f.x), mix(h13(i+vec3(0,1,0)),h13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h13(i+vec3(0,0,1)),h13(i+vec3(1,0,1)),f.x), mix(h13(i+vec3(0,1,1)),h13(i+vec3(1,1,1)),f.x),f.y), f.z); }
float vn1(float x){ return vn3(vec3(x, 0.37, 0.71)); }
vec2 toUV(vec2 p){ return p/vec2(u_aspect,1.0)*0.5+0.5; }
vec2 fold(vec2 uv){ if(u_edge==0) return 1.0-abs(1.0-mod(uv,2.0)); if(u_edge==1) return fract(uv); return clamp(uv,0.0,1.0); }
float luma(vec2 p){ return dot(textureLod(u_img, fold(toUV(p)), 0.0).rgb, vec3(.3,.59,.11)); }
vec2 vfield(float k, vec2 uv, float lod){ float r=clamp(1.0-uv.y, 0.5/u_vdim.y, 1.0-0.5/u_vdim.y);
  return textureLod(u_vf, vec2(clamp(uv.x,0.0,1.0), (k+r)/u_vdim.z), lod).xy; }
float psi(vec2 p, vec4 a){ return vn3(vec3(p*a.y, u_t*a.z)) + a.w*0.5*vn3(vec3(p*a.y*2.3+7.1, u_t*a.z*1.7+3.3)); }
vec2 stack(vec2 p){
  for(int i=0;i<8;i++){
    if(i>=u_n) break;
    int ty=u_type[i]; vec4 a=u_a[i], b=u_b[i], c=u_c[i];
    vec2 pv=b.xy, d=p-pv, q=p; float r2=dot(d,d), r=sqrt(r2);
    if(ty==0){ q = pv + d*exp(-a.x*DT*(1.0+a.y*r2)); }
    else if(ty==1){ q = pv + rot(-a.x*DT)*d; }
    else if(ty==2){ float an=radians(a.y); q = p - vec2(cos(an),sin(an))*a.x*DT; }
    else if(ty==3){ float s=1.0+DT*2.0*(a.x*d.x+a.y*d.y); q = pv + vec2(d.x+a.z*DT*2.0*d.y, d.y)/max(s,0.2); }
    else if(ty==4){ float k=u_t*a.y, k0=(u_t-DT)*a.y;
      vec2 j=vec2(vn1(k)-vn1(k0), vn1(k+17.3)-vn1(k0+17.3))*2.0*a.x;
      float rr=(vn1(k+41.0)-vn1(k0+41.0))*2.0*a.z;
      q = rot(-rr)*p + j; }
    else if(ty==5){ float s2=a.y*a.y; float w=mix(exp(-r2/s2), 1.0/(1.0+r2/s2), a.z); q = pv + rot(-a.x*DT*w)*d; }
    else if(ty==6){ vec2 cc=pv+a.z*vec2(cos(a.w*u_t),sin(a.w*u_t)); vec2 e=p-cc; float w=exp(-dot(e,e)/(a.y*a.y)); q = cc + e*exp(-a.x*DT*w); }
    else if(ty==7){ float ph=radians(a.z)+a.y*u_t; vec2 g=a.x*vec2(cos(ph),sin(ph)); vec2 z2=vec2(d.x*d.x-d.y*d.y, 2.0*d.x*d.y);
      vec2 v=vec2(g.x*z2.x-g.y*z2.y, g.x*z2.y+g.y*z2.x)*DT; float L=length(v); if(L>0.08) v*=0.08/L; q = p - v; }
    else if(ty==8){ float n=max(floor(a.x+0.5),1.0), sp=a.y*u_t, seg=6.2831853/n;
      float an=atan(d.y,d.x)-sp; an=mod(an,seg); an=abs(an-seg*0.5); an+=sp;
      q = mix(p, pv + r*vec2(cos(an),sin(an)), a.z); }
    else if(ty==9){ float an=radians(b.z); vec2 dl=vec2(cos(an),sin(an)); vec2 dr = r>1e-4 ? d/r : dl;
      vec2 dv=mix(dl,dr,a.w); dv/=max(length(dv),1e-4); float s=mix(dot(d,dl), r, a.w);
      q = p + dv*a.x*DT*sin(3.14159265*a.y*s - a.z*u_t); }
    else if(ty==10){ float e=0.04/a.y;
      float px=psi(p+vec2(e,0.0),a)-psi(p-vec2(e,0.0),a), py=psi(p+vec2(0.0,e),a)-psi(p-vec2(0.0,e),a);
      vec2 v=vec2(py,-px)/(2.0*e)/a.y; q = p + v*a.x*DT; }
    else if(ty==11){ float an=radians(a.y); vec2 dir=vec2(cos(an),sin(an)), pe=vec2(-dir.y,dir.x);
      float u=dot(p,pe)*a.z*0.5; float s=1.0+a.w*1.8*(vn3(vec3(u, dot(p,dir)*0.8, u_t*b.z))-0.5);
      q = p - dir*a.x*DT*s; }
    else if(ty==12){ float e=a.z*2.0/288.0;
      vec2 g=vec2(luma(p+vec2(e,0.0))-luma(p-vec2(e,0.0)), luma(p+vec2(0.0,e))-luma(p-vec2(0.0,e)))/(2.0*e);
      vec2 v=rot(radians(a.y))*g*a.x*DT*0.08; float L=length(v); if(L>0.03) v*=0.03/L; q = p + v; }
    else if(ty==13){ float s=max(1.0, u_aspect/u_vdim.w); vec2 pc=p/s; vec2 uv=vec2(pc.x/u_vdim.w*0.5+0.5, pc.y*0.5+0.5);
      float k0=floor(b.z); vec2 v=mix(vfield(k0,uv,a.y), vfield(b.w,uv,a.y), b.z-k0);
      q = p + v*a.x*s*c.w; }
    float w=1.0;
    if(c.x>0.5){ float lo=c.y*(1.0-c.z), hi=c.y*(1.0+c.z)+1e-3; float inside=1.0-smoothstep(lo,hi,r); w = c.x<1.5 ? inside : 1.0-inside; }
    p = mix(p,q,w);
  }
  return p;
}
vec4 jac(vec2 p){ float e=0.01; vec2 q=stack(p); vec2 jx=(stack(p+vec2(e,0.0))-q)/e, jy=(stack(p+vec2(0.0,e))-q)/e;
  float det=jx.x*jy.y-jx.y*jy.x; float E=dot(jx,jx)+dot(jy,jy); float ad=abs(det);
  float s1=0.5*(sqrt(max(E+2.0*ad,0.0))+sqrt(max(E-2.0*ad,0.0))); float s2=ad/max(s1,1e-6);
  return vec4(det, s1/max(s2,1e-6), length(q-p), (abs(q.x)>u_aspect||abs(q.y)>1.0)?1.0:0.0); }
`;
// The stand-in for the dream: some sharpening and a trickle of fresh colour, so the preview doesn't blur to mush.
const FS_SIM = `#version 300 es
${COMMON}
uniform float u_prism, u_sharp, u_fresh;
in vec2 v_uv; out vec4 o;
vec3 Sm(vec2 p){ return texture(u_img, fold(toUV(p))).rgb; }
vec3 dreamish(vec2 p){ float n=vn3(vec3(p*3.0, u_t*0.35)); float m=vn3(vec3(p*9.0+5.0, u_t*0.6));
  vec3 col=0.5+0.5*cos(6.2831*(n*1.3+m*0.35+vec3(0.0,0.33,0.67))); return col*(0.45+0.7*m); }
void main(){
  vec2 p=(v_uv*2.0-1.0)*vec2(u_aspect,1.0);
  vec2 q=stack(p);
  vec3 col=vec3(Sm(q*(1.0+u_prism)).r, Sm(q).g, Sm(q*(1.0-u_prism)).b);
  float px=2.0/u_simres.y;
  vec3 bl=0.25*(Sm(q+vec2(px,0.0))+Sm(q-vec2(px,0.0))+Sm(q+vec2(0.0,px))+Sm(q-vec2(0.0,px)));
  col += u_sharp*(col-bl);
  col = mix(col, dreamish(p), u_fresh);
  o=vec4(clamp(col,0.0,1.0),1.0);
}`;
// Where each pixel's content was N frames ago: the stack applied frame by frame to a coordinate map.
// z marks content that crossed the frame edge at some step, so it is edge fill rather than moved picture.
const FS_COORD = `#version 300 es
${COMMON}
uniform sampler2D u_S; uniform int u_first;
in vec2 v_uv; out vec4 o;
void main(){ vec2 p=(v_uv*2.0-1.0)*vec2(u_aspect,1.0); vec2 q=stack(p); vec2 uv=fold(toUV(q));
  vec2 lim=vec2(u_aspect,1.0)*(1.0-1.0/vec2(textureSize(u_S,0)));   // past the outermost texel centre: slow motion enters less than a texel a frame
  float outF=(abs(q.x)>lim.x||abs(q.y)>lim.y)?1.0:0.0; vec4 prev=texture(u_S, uv);
  o = u_first==1 ? vec4((uv*2.0-1.0)*vec2(u_aspect,1.0), outF, 1.0) : vec4(prev.xy, max(prev.z,outF), 1.0); }`;
const FS_STATS = `#version 300 es
${COMMON}
in vec2 v_uv; out vec4 o;
void main(){ vec2 p=(v_uv*2.0-1.0)*vec2(u_aspect,1.0); o=jac(p); }`;
// Stretch over one second of motion, from the accumulated coordinate map (u_S): x = area change, y = how much
// longer than wide a small circle becomes. Oscillating motions (Ripple) cancel out here, as they do on screen.
const WJAC = `
vec2 wjac(vec2 uv){ vec2 px=1.0/vec2(textureSize(u_S,0));
  vec2 sx=texture(u_S,uv+vec2(px.x,0.0)).xy-texture(u_S,uv-vec2(px.x,0.0)).xy, sy=texture(u_S,uv+vec2(0.0,px.y)).xy-texture(u_S,uv-vec2(0.0,px.y)).xy;
  vec2 jx=sx/(4.0*px.x*u_aspect), jy=sy/(4.0*px.y);
  float det=jx.x*jy.y-jx.y*jy.x, E=dot(jx,jx)+dot(jy,jy), ad=abs(det);
  float s1=0.5*(sqrt(max(E+2.0*ad,0.0))+sqrt(max(E-2.0*ad,0.0))), s2=ad/max(s1,1e-6);
  return vec2(det, s1/max(s2,1e-6)); }
#define TEAR(j) ((j).y>30.0 || abs((j).x)<0.01 || abs((j).x)>100.0)
// Edge fill, widened by a few texels: resampling the map blurs the mirror line at the frame edge, which would
// otherwise read as a thin tear along the boundary of the fill.
float fillNear(vec2 uv){ vec2 px=2.0/vec2(textureSize(u_S,0)); float z=0.0;
  for(int y=-2;y<=2;y++) for(int x=-2;x<=2;x++) z=max(z, texture(u_S, uv+vec2(float(x),float(y))*px).z);
  return z; }
`;
const FS_WSTATS = `#version 300 es
precision highp float; uniform sampler2D u_S; uniform float u_aspect; in vec2 v_uv; out vec4 o;
${WJAC}
void main(){ vec2 j=wjac(v_uv); o=vec4(j, TEAR(j)?1.0:0.0, fillNear(v_uv)); }`;
const FS_SHOW = `#version 300 es
${COMMON}
uniform sampler2D u_S; uniform int u_view; uniform int u_smode;
${WJAC}
in vec2 v_uv; out vec4 o;
vec3 heat(float x){ vec3 neg=vec3(0.94,0.64,0.29), pos=vec3(0.25,0.78,0.74), mid=vec3(0.13,0.14,0.18);
  return x<0.0 ? mix(mid,neg,-x) : mix(mid,pos,x); }
void main(){
  vec2 uv=v_uv; vec2 p=(uv*2.0-1.0)*vec2(u_aspect,1.0);
  vec3 img=texture(u_img,uv).rgb;
  if(u_view==0){ o=vec4(img,1.0); return; }
  if(u_view==1){ vec2 s=texture(u_S,uv).xy; vec2 g=s*4.0;
    vec2 f=abs(fract(g+0.5)-0.5); vec2 w=fwidth(g); vec2 l=1.0-smoothstep(w*0.5,w*1.5,f);
    float line=max(l.x,l.y); float chk=mod(floor(g.x)+floor(g.y),2.0);
    vec3 col=img*0.25+vec3(0.05)*chk;
    col=mix(col, vec3(0.25,0.78,0.74), line*0.9);
    vec2 wa=fwidth(s); vec2 la=1.0-smoothstep(wa*0.8,wa*2.2,abs(s)); col=mix(col, vec3(0.96,0.84,0.43), max(la.x,la.y));
    o=vec4(col,1.0); return; }
  if(u_view==2){ o=vec4(img*0.32,1.0); return; }
  vec2 j=wjac(uv); vec3 col; float lum=dot(img,vec3(.3,.59,.11));
  if(u_smode==0){ col=heat(clamp(-log(max(abs(j.x),1e-4))/1.4,-1.0,1.0)); }
  else { col=mix(vec3(0.13,0.14,0.18), vec3(0.96,0.84,0.43), clamp(log(j.y),0.0,1.0)); }
  if(TEAR(j)) col=vec3(1.0,0.42,0.42);
  col*=0.72+0.45*lum;
  if(fillNear(uv)>0.5) col=mix(vec3(0.16,0.17,0.21), vec3(0.32,0.34,0.4), step(0.5, fract((gl_FragCoord.x+gl_FragCoord.y)/14.0)));
  o=vec4(col,1.0);
}`;
const VS_ARROW = `#version 300 es
${COMMON}
uniform float u_gain; uniform vec2 u_grid; out float v_m;
void main(){
  int id=gl_VertexID; int inst=id/6, k=id-inst*6; int gx=int(u_grid.x); int ix=inst-(inst/gx)*gx, iy=inst/gx;
  vec2 uv=(vec2(float(ix),float(iy))+0.5)/u_grid; vec2 p=(uv*2.0-1.0)*vec2(u_aspect,1.0);
  vec2 m=(p-stack(p))*u_gain; float L=length(m); float maxL=1.7*u_aspect/u_grid.x;
  if(L>maxL){ m*=maxL/L; L=maxL; }
  vec2 dir = L>1e-6 ? m/L : vec2(1.0,0.0); vec2 tip=p+m; float hs=min(L*0.45, 0.035);
  vec2 pos=p;
  if(k==1||k==2||k==4) pos=tip; else if(k==3) pos=tip-rot(0.5)*dir*hs; else if(k==5) pos=tip-rot(-0.5)*dir*hs;
  v_m=clamp(L/maxL,0.0,1.0);
  gl_Position=vec4(pos/vec2(u_aspect,1.0),0.0,1.0);
}`;
const FS_ARROW = `#version 300 es
precision highp float; in float v_m; out vec4 o;
void main(){ o=vec4(mix(vec3(0.55,0.6,0.68), vec3(0.25,0.85,0.8), v_m),1.0); }`;
const FS_BLIT = `#version 300 es
precision highp float; uniform sampler2D u_img; in vec2 v_uv; out vec4 o; void main(){ o=texture(u_img,v_uv); }`;

// ----------------------------------------------------------------------------- WebGL
let gl = null, cv = null, floatOK = false;
const progs = {};
function compile(vs, fs) {
  const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const cache = {}; const u = n => n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(p, n));
  gl.useProgram(p); gl.uniform1i(u("u_img"), 0); gl.uniform1i(u("u_S"), 1); gl.uniform1i(u("u_vf"), 2);
  return { p, u };
}
function tex(w, h, ifmt, fmt, type, filter = gl.LINEAR) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function target(w, h, ifmt, fmt, type, filter) {
  const t = tex(w, h, ifmt, fmt, type, filter), f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { t, f, w, h, ok };
}
function free(...tg) { for (const x of tg) if (x) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); } }
let simA, simB, coordA, coordB, statsT, seedTex, c32 = false;
function initGL() {
  floatOK = !!gl.getExtension("EXT_color_buffer_float");
  c32 = floatOK && !!gl.getExtension("OES_texture_float_linear");   // 32-bit coordinate maps keep the stretch readout precise
  progs.sim = compile(VS_FULL, FS_SIM); progs.coord = compile(VS_FULL, FS_COORD); progs.stats = compile(VS_FULL, FS_STATS);
  progs.wstats = compile(VS_FULL, FS_WSTATS); progs.show = compile(VS_FULL, FS_SHOW); progs.arrow = compile(VS_ARROW, FS_ARROW); progs.blit = compile(VS_FULL, FS_BLIT);
  gl.bindVertexArray(gl.createVertexArray());
  seedTex = tex(1024, 576, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  if (floatOK) { statsT = target(64, 36, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST); if (!statsT.ok) floatOK = false; }
  makeTargets();
}
function makeTargets() {   // the sizes follow the render's aspect ratio
  free(simA, simB, coordA, coordB);
  SW = Math.max(64, Math.round(SH * A / 2) * 2); GW = Math.max(32, Math.round(GH * A / 2) * 2);
  const F16 = [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];
  if (floatOK) { simA = target(SW, SH, ...F16); simB = target(SW, SH, ...F16); if (!simA.ok || !simB.ok) floatOK = false; }
  if (!floatOK) { simA = target(SW, SH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE); simB = target(SW, SH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE); }
  if (floatOK) {
    const C = c32 ? [gl.RGBA32F, gl.RGBA, gl.FLOAT] : F16;
    coordA = target(GW, GH, ...C); coordB = target(GW, GH, ...C);
    if (!coordA.ok) floatOK = false;
  }
}
const TY = new Int32Array(8), UA = new Float32Array(32), UB = new Float32Array(32), UC = new Float32Array(32);
function setStack(pr, t, list = active()) {
  let vf = null;
  TY.fill(0); UA.fill(0); UB.fill(0); UC.fill(0);
  list.slice(0, MAXM).forEach((m, i) => {
    const d = BY[m.key], v = d.params.map(p => paramAt(m, p, t));
    TY[i] = d.idx; UA.set([v[0] || 0, v[1] || 0, v[2] || 0, v[3] || 0], i * 4);
    UB.set([m.pivot[0], m.pivot[1], v[4] || 0, v[5] || 0], i * 4); UC.set([m.mask.mode, m.mask.radius, m.mask.soft, 0], i * 4);
    if (m.key === "video") {   // a.x = motion per preview frame (30 fps), a.y = blur level, b.z/b.w = clip frames, c.w = sign
      const F = readyField(m);
      if (!F) { UA.set([0, 0, 0, 0], i * 4); return; }
      const [k0, k1, f, sg] = clipFrames(v[3] * F.n + t * F.fps * v[1], F.n, m.loop);
      UA.set([v[0] * F.fps * v[1] / 30, Math.log2(1 + 3 * v[2]), 0, 0], i * 4);
      UB.set([m.pivot[0], m.pivot[1], k0 + f, k1], i * 4); UC.set([m.mask.mode, m.mask.radius, m.mask.soft, sg], i * 4);
      vf = F;
    }
  });
  if (vf) bindTex(2, vf.tex);
  const u = pr.u;
  gl.uniform1i(u("u_n"), Math.min(list.length, MAXM)); gl.uniform1iv(u("u_type"), TY);
  gl.uniform4fv(u("u_a"), UA); gl.uniform4fv(u("u_b"), UB); gl.uniform4fv(u("u_c"), UC);
  gl.uniform1f(u("u_t"), t); gl.uniform1f(u("u_aspect"), A); gl.uniform2f(u("u_simres"), SW, SH); gl.uniform1i(u("u_edge"), S.edge);
  gl.uniform4f(u("u_vdim"), vf ? vf.w : 1, vf ? vf.h : 1, vf ? vf.n : 1, vf ? vf.aspect : A);
}
function bindTex(unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); }
function drawTo(tg) { gl.bindFramebuffer(gl.FRAMEBUFFER, tg ? tg.f : null); if (tg) gl.viewport(0, 0, tg.w, tg.h); gl.drawArrays(gl.TRIANGLES, 0, 3); }

// ----------------------------------------------------------------------------- simulation
let frame = 0, cur, nxt;
function reset() {
  cur = simA; nxt = simB; frame = 0;
  gl.useProgram(progs.blit.p); bindTex(0, seedTex); drawTo(cur);
}
function step() {
  frame++;
  const pr = progs.sim; gl.useProgram(pr.p); setStack(pr, frame * DT);
  gl.uniform1f(pr.u("u_prism"), S.prism); gl.uniform1f(pr.u("u_sharp"), S.sharp); gl.uniform1f(pr.u("u_fresh"), S.fresh);
  bindTex(0, cur.t); drawTo(nxt); [cur, nxt] = [nxt, cur];
}
let gridTex = null;
function coordMap(list, tEnd, N) {
  const pr = progs.coord; gl.useProgram(pr.p);
  let src = coordA, dst = coordB;
  for (let n = 1; n <= N; n++) {
    setStack(pr, tEnd - (N - n) * DT, list); gl.uniform1i(pr.u("u_first"), n === 1 ? 1 : 0);
    bindTex(0, cur ? cur.t : seedTex); bindTex(1, src.t); drawTo(dst); [src, dst] = [dst, src];
  }
  return src.t;
}
function computeGrid() { gridTex = coordMap(active(), frame * DT, Math.max(1, Math.round((S.view === 1 ? S.gridWin : 1) * 30))); }
const statBuf = new Float32Array(64 * 36 * 4), wBuf = new Float32Array(64 * 36 * 4);
function readStats(list, t) {
  // The kaleidoscope is left out: its fold jumps pixels across wedges, which isn't movement or stretch.
  list = list.filter(m => m.key !== "kaleido");
  const pr = progs.stats; gl.useProgram(pr.p); setStack(pr, t, list); bindTex(0, cur ? cur.t : seedTex); drawTo(statsT);
  gl.readPixels(0, 0, 64, 36, gl.RGBA, gl.FLOAT, statBuf);
  const map = coordMap(list, t, 30), wp = progs.wstats; gl.useProgram(wp.p); gl.uniform1f(wp.u("u_aspect"), A); bindTex(1, map); drawTo(statsT);
  gl.readPixels(0, 0, 64, 36, gl.RGBA, gl.FLOAT, wBuf); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const n = 64 * 36, grow = [], shear = [], disp = []; let tears = 0, outside = 0, dsum = 0;
  for (let i = 0; i < n; i++) {
    const det = wBuf[i * 4], an = wBuf[i * 4 + 1], dp = statBuf[i * 4 + 2];
    disp.push(dp); dsum += dp;
    if (wBuf[i * 4 + 3] > .5) { outside++; continue; }   // edge fill: judged by the edge mode, not as motion
    if (wBuf[i * 4 + 2] > .5 || !isFinite(det) || !isFinite(an)) { tears++; continue; }
    grow.push(-Math.log(Math.abs(det))); shear.push(Math.log(an));
  }
  const pct = (a, q) => { if (!a.length) return 0; a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
  return { grow: pct(grow, .95), shrink: -pct(grow, .05), shear: pct(shear, .95), tears: tears / n, outside: outside / n,
    motion: dsum / n * 30 / 2, disp95: pct(disp, .95) };
}

// ----------------------------------------------------------------------------- drawing
let lastStats = null;
function sizeCanvas() {
  const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(160, Math.min(1600, Math.round(r.width * dpr))), h = Math.round(w / A);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}
function draw() {
  sizeCanvas();
  if ((S.view === 1 || S.view === 3) && floatOK) computeGrid();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cv.width, cv.height);
  const pr = progs.show; gl.useProgram(pr.p); setStack(pr, frame * DT);
  gl.uniform1i(pr.u("u_view"), (S.view === 1 || S.view === 3) && !floatOK ? 0 : S.view); gl.uniform1i(pr.u("u_smode"), S.smode);
  bindTex(0, cur.t); bindTex(1, gridTex || seedTex); gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (S.view === 2) {
    const g = S.autoGain && lastStats ? clamp(.09 / Math.max(lastStats.disp95, 1e-6), 1, 3000) : S.gain || 60;
    if (S.autoGain) S.gain = g;
    const gx = clamp(Math.round(cv.clientWidth / 15), 12, 40);
    drawArrows(active(), frame * DT, g, gx, Math.max(4, Math.round(gx / A)));
  }
}
function drawArrows(list, t, gain, gx, gy) {
  const pr = progs.arrow; gl.useProgram(pr.p); setStack(pr, t, list);
  gl.uniform1f(pr.u("u_gain"), gain); gl.uniform2f(pr.u("u_grid"), gx, gy); bindTex(0, cur ? cur.t : seedTex);
  gl.drawArrays(gl.LINES, 0, gx * gy * 6);
}
// Glyphs: each motion's one-frame flow at its default settings, drawn once into small 2D canvases.
const glyphs = {};
function renderGlyphs() {
  for (const d of MODS) if (d.key !== "video") glyphs[d.key] = glyphFor(M(d.key));
  glyphs.video = placeholderGlyph();
}
function glyphFor(m) {   // drawn in a corner of the preview canvas, then copied out before the next frame
  const w = 160, h = 90, keepA = A; A = 16 / 9;
  if (cv.width < w || cv.height < h) { cv.width = 320; cv.height = 180; }
  const st = floatOK ? readStats([m], 1.3) : null;
  const gain = st ? clamp(.32 / Math.max(st.disp95, 1e-6), 1, 5000) : 40;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
  gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, w, h); gl.clearColor(.106, .122, .161, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.SCISSOR_TEST);
  drawArrows([m], 1.3, gain, 12, 7);
  gl.viewport(1, 0, w, h); drawArrows([m], 1.3, gain, 12, 7);   // drawn twice, 1 px apart: WebGL lines are only 1 px wide
  gl.viewport(0, 1, w, h); drawArrows([m], 1.3, gain, 12, 7);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(cv, 0, cv.height - h, w, h, 0, 0, w, h);
  A = keepA;
  return c;
}
function paintGlyph(canvas, key) { const g = glyphs[key]; if (!g) return; canvas.width = g.width; canvas.height = g.height; canvas.getContext("2d").drawImage(g, 0, 0); }

// ----------------------------------------------------------------------------- source pictures
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const PICS = {
  garden(c, W, H) {
    const r = rng(7), g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#22113f"); g.addColorStop(1, "#0b4150"); c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.lineWidth = 3;
    for (let i = 0; i < 16; i++) { c.strokeStyle = `hsla(${r() * 360},80%,65%,.5)`; c.beginPath(); const y0 = r() * H, f = .005 + r() * .02, a = 20 + r() * 50;
      for (let x = 0; x <= W; x += 8) c.lineTo(x, y0 + Math.sin(x * f + i) * a); c.stroke(); }
    for (let i = 0; i < 80; i++) { const x = r() * W, y = r() * H, R = 10 + r() * 55, h0 = r() * 360;
      for (let k = 6; k >= 1; k--) { c.fillStyle = `hsl(${(h0 + k * 40) % 360},85%,${k % 2 ? 62 : 35}%)`; c.beginPath(); c.arc(x, y, R * k / 6, 0, 7); c.fill(); }
      c.fillStyle = "#050507"; c.beginPath(); c.arc(x, y, R * .14, 0, 7); c.fill(); c.fillStyle = "#fff"; c.beginPath(); c.arc(x + R * .05, y - R * .05, R * .05, 0, 7); c.fill(); }
    c.font = "700 190px 'Bricolage Grotesque', 'Segoe UI', sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
    c.lineWidth = 14; c.strokeStyle = "#0d0f13"; c.strokeText("DREAM", W / 2, H / 2); c.fillStyle = "#f5f1e8"; c.fillText("DREAM", W / 2, H / 2);
  },
  face(c, W, H) {
    for (let y = 0; y < H; y += 48) for (let x = 0; x < W; x += 48) { c.fillStyle = ((x + y) / 48) % 2 ? "#1f6f8b" : "#e8d9b0"; c.fillRect(x, y, 48, 48); }
    const cx = W / 2, cy = H / 2 + 10;
    c.fillStyle = "#3a1f14"; c.beginPath(); c.ellipse(cx, cy - 40, 205, 225, 0, 0, 7); c.fill();
    c.fillStyle = "#f0b48a"; c.beginPath(); c.ellipse(cx, cy, 175, 215, 0, 0, 7); c.fill();
    for (const s of [-1, 1]) { c.fillStyle = "#fff"; c.beginPath(); c.ellipse(cx + s * 70, cy - 40, 42, 26, 0, 0, 7); c.fill();
      c.fillStyle = "#2c7a3d"; c.beginPath(); c.arc(cx + s * 70, cy - 40, 20, 0, 7); c.fill(); c.fillStyle = "#000"; c.beginPath(); c.arc(cx + s * 70, cy - 40, 9, 0, 7); c.fill();
      c.strokeStyle = "#3a1f14"; c.lineWidth = 9; c.beginPath(); c.moveTo(cx + s * 30, cy - 92); c.lineTo(cx + s * 112, cy - 100); c.stroke(); }
    c.strokeStyle = "#b5734f"; c.lineWidth = 7; c.beginPath(); c.moveTo(cx, cy - 20); c.lineTo(cx - 18, cy + 40); c.lineTo(cx + 8, cy + 46); c.stroke();
    c.strokeStyle = "#a3283a"; c.lineWidth = 12; c.beginPath(); c.arc(cx, cy + 60, 70, .25, Math.PI - .25); c.stroke();
  },
  star(c, W, H) {
    c.fillStyle = "#101318"; c.fillRect(0, 0, W, H); const cx = W / 2, cy = H / 2, n = 36;
    for (let i = 0; i < n; i++) { c.fillStyle = i % 2 ? "#f3efe6" : `hsl(${i * 10},70%,45%)`; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, 900, i / n * 6.2832, (i + 1) / n * 6.2832); c.fill(); }
    c.strokeStyle = "#101318"; c.lineWidth = 5; for (let rr = 40; rr < 900; rr += 48) { c.beginPath(); c.arc(cx, cy, rr, 0, 7); c.stroke(); }
    c.fillStyle = "#101318"; c.beginPath(); c.arc(cx, cy, 14, 0, 7); c.fill();
  },
};
const picCanvas = document.createElement("canvas"); picCanvas.width = 1024; picCanvas.height = 576;
let picName = "garden";
function uploadPic() {
  gl.bindTexture(gl.TEXTURE_2D, seedTex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, picCanvas); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}
function drawCover(src, w, h) {   // fill the picture canvas at the render's aspect, cropping like dream.py does
  picCanvas.height = Math.round(1024 / A);
  const c = picCanvas.getContext("2d"), s = Math.max(1024 / w, picCanvas.height / h);
  c.fillStyle = "#000"; c.fillRect(0, 0, 1024, picCanvas.height);
  c.drawImage(src, (1024 - w * s) / 2, (picCanvas.height - h * s) / 2, w * s, h * s);
}
function setPic(name, quiet) {
  if (name === "monitor") {   // the frame on the monitor: the live render frame, else the video player
    const live = host.live, v = host.player;
    if (live && !live.hidden && live.naturalWidth) drawCover(live, live.naturalWidth, live.naturalHeight);
    else if (v && v.readyState >= 2 && v.videoWidth) drawCover(v, v.videoWidth, v.videoHeight);
    else { if (!quiet) host.toast("Nothing on the monitor yet. Run a preview, then try again."); return false; }
  } else if (name === "clip") {   // the video module's clip, at its start point, to see its motion on its own footage
    const m = S.stack.find(x => x.key === "video" && x.clip);
    if (!m) { if (!quiet) host.toast("Choose a clip in a Video motion module first."); return false; }
    const v = document.createElement("video"); v.muted = true; v.preload = "auto";
    v.addEventListener("loadedmetadata", () => { v.currentTime = Math.max(.01, Math.min(v.duration - .05, m.vals.offset * v.duration)); }, { once: true });
    v.addEventListener("seeked", () => { drawCover(v, v.videoWidth, v.videoHeight); uploadPic(); seek(frame); }, { once: true });
    v.addEventListener("error", () => host.toast("The browser can't play this clip (H.265 or MOV often can't); its motion still works."), { once: true });
    v.src = host.clipUrl(m.clip);
  } else if (name === "start") {
    const p = String(host.render().init_image || "").trim();
    if (!p) { host.toast("No start image is set (Editor tab, Start)."); return false; }
    const img = new Image();
    img.onload = () => { drawCover(img, img.naturalWidth, img.naturalHeight); uploadPic(); seek(frame); };
    img.onerror = () => host.toast("The start image could not be loaded.");
    img.src = host.imageUrl(p);
  } else {
    picCanvas.height = Math.round(1024 / A);
    const off = document.createElement("canvas"); off.width = 1024; off.height = 576; PICS[name](off.getContext("2d"), 1024, 576);
    drawCover(off, 1024, 576);
  }
  picName = name;
  $$("[data-src]").forEach(c => c.setAttribute("aria-pressed", c.dataset.src === name));
  if (name !== "start" && name !== "clip") { uploadPic(); seek(frame); }
  return true;
}

// ----------------------------------------------------------------------------- DOM
// ----------------------------------------------------------------------------- video motion
// The Video motion module moves the picture the way a chosen clip moves. video_motion.py (run by the server as a
// job) stores one backward field per clip frame; the preview loads its 64 px copy into a texture strip (frames
// stacked top to bottom, x/y in red/green) that shader type 13 samples, blending the two nearest clip frames.
const fields = {};      // key -> { state: loading | ready | missing | error, n, h, w, fps, aspect, tex, msg }
let job = null, jobKey = null, lastJobEnd = null;
const fieldKey = m => `${m.clip}|${m.source}|${m.source === "codec" ? m.gaps : "hold"}`;
function clipFrames(fi, n, loop) {   // same as clip_frames in dream.py: frames to blend, weight, motion sign
  if (n < 2) return [0, 0, 0, 1];
  if (loop === "hold") { fi = clamp(fi, 0, n - 1); const k = Math.floor(fi); return [k, Math.min(k + 1, n - 1), fi - k, 1]; }
  if (loop === "pingpong") {
    const per = 2 * (n - 1); let x = ((fi % per) + per) % per, sg = 1;
    if (x > n - 1) { x = per - x; sg = -1; }
    const k = Math.floor(x); return [k, Math.min(k + 1, n - 1), x - k, sg];
  }
  const x = ((fi % n) + n) % n, k = Math.floor(x); return [k, (k + 1) % n, x - k, 1];
}
async function loadField(m) {
  if (!m.clip) return;
  const key = fieldKey(m), cur0 = fields[key];
  if (cur0 && (cur0.state === "ready" || cur0.state === "loading")) return;
  fields[key] = { state: "loading" }; videoStatus();
  try {
    const q = new URLSearchParams({ clip: m.clip, source: m.source, gaps: m.gaps });
    const r = await fetch(`/api/motion?${q}`, { headers: { "X-Token": host.token } });
    if (r.status === 404) {
      const j = await r.json().catch(() => ({}));
      fields[key] = { state: j.missing ? "missing" : "error", msg: j.missing ? "" : (j.error === "clip not found" ? "The clip file is gone." : j.error) };
    } else {
      if (!r.ok) throw new Error(r.statusText);
      const buf = await r.arrayBuffer(), hl = new DataView(buf).getUint32(0, true);
      const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
      fields[key] = gl ? fieldTexture(head, new Uint16Array(buf.slice(4 + hl))) : { state: "ready", ...head };
      renderVideoGlyph(); resettle(0);
    }
  } catch (e) { fields[key] = { state: "error", msg: e instanceof TypeError ? "The editor isn't answering. Check that 4_EDITOR.bat is open, then reload the page." : e.message }; }
  videoStatus();
}
function fieldTexture(hd, src) {   // (n, 2, h, w) float16 -> one RG16F texture, frames stacked; long clips skip frames
  const step = Math.max(1, Math.ceil(hd.n * hd.h / gl.getParameter(gl.MAX_TEXTURE_SIZE))), n = Math.floor((hd.n - 1) / step) + 1;
  const fr = hd.h * hd.w, data = new Uint16Array(n * fr * 2);
  for (let k = 0; k < n; k++) {
    const s0 = k * step * 2 * fr, d0 = k * fr * 2;
    for (let i = 0; i < fr; i++) { data[d0 + i * 2] = src[s0 + i]; data[d0 + i * 2 + 1] = src[s0 + fr + i]; }
  }
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, hd.w, hd.h * n, 0, gl.RG, gl.HALF_FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (floatOK) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }   // smooth = blur by mip level
  else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  return { state: "ready", n, h: hd.h, w: hd.w, fps: hd.fps / step, aspect: hd.aspect, tex: t, frames: hd.n };
}
const readyField = m => { const F = m.key === "video" && m.clip && fields[fieldKey(m)]; return F && F.state === "ready" && F.tex ? F : null; };
const optHtml = (cur, list) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("");
function videoBlock(m) {
  const name = m.clip ? m.clip.split(/[\\/]/).pop() : "";
  return `<div class="wl-video" data-id="${m.id}">
    <div class="wl-vrow"><button class="btn small" type="button" data-act="vpick">${m.clip ? "Change clip…" : "Choose clip…"}</button>
      <span class="pv" title="${esc(m.clip)}">${m.clip ? esc(name) : "No clip yet: choose one or drop a video here"}</span><input type="file" accept="video/*" hidden data-vfile></div>
    <div class="wl-vrow">
      <label>Source <select data-vf="source">${optHtml(m.source, [["flow", "Optical flow"], ["codec", "Codec vectors"]])}</select></label>
      <label>At the end <select data-vf="loop">${optHtml(m.loop, [["loop", "Loop"], ["pingpong", "Ping-pong"], ["hold", "Hold last motion"]])}</select></label>
      <label ${m.source === "codec" ? "" : "hidden"} title="Blocks with no motion vector to the past: intra blocks, I-frames, future-only blocks">Gaps <select data-vf="gaps">${optHtml(m.gaps, [["hold", "Hold previous"], ["zero", "Zero"]])}</select></label>
    </div>
    <div class="wl-vstat" data-vstat="${m.id}"></div>
    <p class="hint">${m.source === "codec" ? "Codec vectors: the clip's own block motion, blocky and glitchy like datamoshing." : "Optical flow: the smooth, true motion of everything in the clip."} Camera footage often moves far more per frame than a zoom; if the Motion check warns, lower the strength.</p>
  </div>`;
}
function videoStatus() {
  if (!root) return;
  $$("[data-vstat]").forEach(el => {
    const m = findMod(el.dataset.vstat); if (!m) return;
    const key = fieldKey(m), F = fields[key], running = job && job.running && job.kind === "motion";
    let h = "";
    if (!m.clip) h = "";
    else if (running && jobKey === key) h = `<span>Extracting motion… ${job.frames ? Math.round(job.frame / job.frames * 100) + "%" : "starting"}</span><button class="btn small" type="button" data-act="vstop">Stop</button>`;
    else if (!F || F.state === "loading") h = "<span>Loading motion…</span>";
    else if (F.state === "ready") h = `<span>Motion ready: ${F.frames ?? F.n} frames at ${+(F.fps * ((F.frames ?? F.n) > F.n ? (F.frames - 1) / (F.n - 1) : 1)).toFixed(2)} fps</span>`;
    else if (F.state === "missing") h = `<span>Not extracted yet.${m.source === "flow" ? " Optical flow takes about half a second per frame on this computer." : ""}</span><button class="btn small primary" type="button" data-act="vextract" ${running ? "disabled" : ""}>Extract motion</button>`;
    else h = `<span style="color:var(--bad)">${esc(F.msg || "Could not load the motion.")}</span><button class="btn small" type="button" data-act="vextract" ${running ? "disabled" : ""}>Try again</button>`;
    if (job && !job.running && job.kind === "motion" && job.code && !job.stopped && jobKey === key)
      h += `<span style="color:var(--bad)">Extraction failed: ${esc((job.log || []).slice(-1)[0] || "see the log")}</span>`;
    el.innerHTML = h;
  });
}
async function uploadClip(m, f) {
  if (!f) return;
  if (!/^video\//.test(f.type) && !/\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(f.name)) { host.toast("That is not a video file."); return; }
  try {
    host.toast(`Copying ${f.name}…`);
    m.clip = await host.uploadClip(f);
    renderStack(); commit(); loadField(m); resettle(0);
    host.toast("Clip set (copied to clips\\). Not saved yet.");
    if (picName === "clip") setPic("clip", true);
  } catch (e) { host.toast(e.message); }
}
function placeholderGlyph() {   // until a clip is chosen: a film strip
  const c = document.createElement("canvas"); c.width = 160; c.height = 90; const x = c.getContext("2d");
  x.fillStyle = "#1b1f29"; x.fillRect(0, 0, 160, 90);
  x.strokeStyle = "#9399a8"; x.lineWidth = 3; x.strokeRect(34, 16, 92, 58);
  x.fillStyle = "#9399a8"; for (let i = 0; i < 6; i++) { x.fillRect(40 + i * 14, 21, 7, 6); x.fillRect(40 + i * 14, 63, 7, 6); }
  x.strokeStyle = "#3fc6bd"; x.lineWidth = 3; x.beginPath(); x.moveTo(52, 45); x.lineTo(108, 45); x.moveTo(98, 38); x.lineTo(108, 45); x.lineTo(98, 52); x.stroke();
  return c;
}
function renderVideoGlyph() {   // once a clip's motion is loaded, the glyph shows its real flow
  const m = S.stack.find(readyField);
  glyphs.video = m && gl ? glyphFor(m) : placeholderGlyph();
  $$('canvas[data-glyph="video"]').forEach(c => paintGlyph(c, "video"));
}

let root, side, $q, $$;
const fmtv = (v, st) => (+v).toFixed(Math.min(4, decimals(st)));
// The stack goes into the settings window (root); the preview goes into the editor's monitor (side), built from
// the monitor's own pieces (.tabs, .viewer, .readout, details.log) so it looks like the other tabs.
function buildDom(extra) {
  root.innerHTML = `<div class="wl">
    <div class="wl-head"><h3>Motion stack</h3><span class="sub">modules run top to bottom · select one, then drag its pivot on the preview</span></div>
    <div class="wl-head"><span class="sub">Looks:</span><div class="chips" data-r="looks"></div><span class="sp"></span>
      <button class="btn small" type="button" data-r="reroll" title="Keep these modules, roll new settings and curves (Shift+R)">Re-roll settings</button>
      <button class="btn small primary" type="button" data-r="rnd" title="A new stack, kept inside the stress limits (R)">Random warp</button></div>
    <div class="wl-stack" data-r="stack"></div>
    <div data-r="extra"></div>
    <details class="wl-add" open data-r="addbox"><summary>Add a motion <span>arrows show where the picture moves in one frame</span></summary><div data-r="catalog"></div></details>
  </div>`;
  side.innerHTML = `<div class="wl-mon">
      <div class="tabs wl-views" role="tablist" aria-label="Preview view">
        <button role="tab" data-view="0" aria-selected="true" title="The picture after the motion runs">Result</button>
        <button role="tab" data-view="1" aria-selected="false" title="A straight grid, carried by the motion for a while">Grid</button>
        <button role="tab" data-view="2" aria-selected="false" title="Where the picture moves in one frame">Flow</button>
        <button role="tab" data-view="3" aria-selected="false" title="Where the motion stretches, squeezes or tears the picture over a second">Stress</button>
      </div>
      <div class="viewer">
        <div class="screen wl-screen" data-r="screen"><canvas data-r="cv" aria-label="Live deformation preview"></canvas><svg data-r="ov" aria-hidden="true"></svg>
          <span class="badge">Warp only · stand-in dream</span><span class="busy" data-r="busy" hidden></span></div>
        <div class="vbar wl-vo" data-r="vo"></div>
      </div>
      <div class="wl-tr">
        <button class="btn" type="button" data-r="play">Pause</button>
        <button class="btn" type="button" data-r="restart" title="Start again from the first frame">Restart</button>
        <input type="range" data-r="scrub" min="0" max="20" step="0.0333" value="0" aria-label="Time in the video">
        <span class="clock" data-r="clock">0.0 / 20 s</span>
      </div>
      <div class="jobline wl-jl"><label><select data-r="speed" aria-label="Playback speed"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option></select> speed</label>
        <label title="After an edit, re-run from frame 0 so the picture matches what a render shows at this time"><input type="checkbox" data-r="settle" checked> Re-run after edits</label></div>
    </div>
    <div class="wl-lanes"><p data-r="lanes-empty">No motion curves yet. Press <b>∿</b> next to a setting to make it change over the video.</p><canvas data-r="lanes" hidden></canvas></div>
    <div class="wl-src"><span>Picture</span><div class="chips">
      <button class="chip" type="button" data-src="monitor" title="The frame from the Editor tab's monitor: a preview, render or live frame">Last video</button>
      <button class="chip" type="button" data-src="clip" title="The Video motion module's clip, at its start point">Clip</button>
      <button class="chip" type="button" data-src="start" title="The start image from the Editor tab">Start image</button>
      <button class="chip" type="button" data-src="garden">Eye garden</button><button class="chip" type="button" data-src="face">Face</button><button class="chip" type="button" data-src="star">Siemens star</button></div></div>
    <div class="readout"><h2>Motion check</h2><dl class="facts" data-r="facts"></dl><div class="warnings" data-r="warnings"></div></div>
    <details class="log"><summary>Stand-in for the dream</summary><div class="wl-box" style="margin-top:4px">
      <p class="hint">The preview has no network, so these keep detail coming. The render gets its detail from the dream; judge the motion here, not the content.</p>
      <div class="wl-p"><label for="wl-fresh">Fresh detail</label><input type="range" id="wl-fresh" min="0" max="0.06" step="0.001" data-g="fresh"><input type="number" min="0" max="0.06" step="0.001" data-g="fresh" aria-label="Fresh detail value"></div>
      <div class="wl-p"><label for="wl-sharp">Sharpen</label><input type="range" id="wl-sharp" min="0" max="0.8" step="0.01" data-g="sharp"><input type="number" min="0" max="0.8" step="0.01" data-g="sharp" aria-label="Sharpen value"></div>
    </div></details>`;
  $q = r => root.querySelector(`[data-r="${r}"]`) || side.querySelector(`[data-r="${r}"]`);
  $$ = sel => [...root.querySelectorAll(sel), ...side.querySelectorAll(sel)];
  // Edges and prism are whole-frame settings of the stack: they join the editor's Resampling section as
  // ordinary setting rows (same markup as index.html's control()), right under the stack.
  const row = (k, name, input, help) => `<div class="ctl" data-wk="${k}"><div class="name"><label for="wl-${k}"><code>${k}</code></label>
      <span class="friendly">${name}</span><div class="tags"><span class="tag feedback" title="Changes what the network paints">dream</span></div><button class="revert" type="button" data-wrevert="${k}">revert</button></div>
    <div class="input">${input}</div><div class="help">${help}</div></div>`;
  const rows = row("edge", "Edges", `<div class="chips" data-r="edges" id="wl-edge">
      <button class="chip" type="button" data-edge="0">Reflect</button><button class="chip" type="button" data-edge="1">Wrap</button><button class="chip" type="button" data-edge="2">Smear</button></div>`,
      "What fills the frame where the motion pulls in pixels from outside it. Reflect mirrors the picture, wrap tiles it, smear stretches the border.")
    + row("prism", "Prism split", `<input type="range" id="wl-prism-r" min="0" max="0.012" step="0.0005" data-g="prism" aria-label="Prism split"><input type="number" id="wl-prism" min="0" max="0.012" step="0.0005" data-g="prism">`,
      "Red and blue zoom slightly apart every frame, so edges leave rainbow trails. 0.002–0.004 is plenty.");
  if (extra) { extra.insertAdjacentHTML("beforeend", rows); $q("extra").appendChild(extra); }
  else $q("extra").innerHTML = rows;
  cv = $q("cv");
}

// ---- stack
function paramRow(m, p) {
  const md = m.mod[p.k], id = `wl${m.id}-${p.k}`, on = md.shape !== "none", open = !!m.ui[p.k];
  return `<div class="wl-p" data-id="${m.id}" data-k="${p.k}">
    <label for="${id}" title="${esc(p.label)}${p.unit ? " (" + p.unit + ")" : ""}">${esc(p.label)}<code>${p.k}</code></label>
    <input type="range" id="${id}" data-f="val" min="${p.min}" max="${p.max}" step="${p.step}" value="${m.vals[p.k]}">
    <input type="number" data-f="val" aria-label="${esc(p.label)} value" min="${p.min}" max="${p.max}" step="${p.step}" value="${fmtv(m.vals[p.k], p.step)}">
    <button class="wl-wv${on ? " on" : ""}" type="button" data-act="wave" aria-expanded="${open}" title="Make this setting change over the video">∿</button>
  </div>
  <div class="wl-curve" data-id="${m.id}" data-k="${p.k}" ${open ? "" : "hidden"}>
    <label>Curve <select data-f="shape">${Object.entries(SHAPES).map(([s, l]) => `<option value="${s}" ${s === md.shape ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label ${md.shape === "ramp" ? "hidden" : ""}>Period <input type="number" data-f="period" min="0.5" max="120" step="0.5" value="${md.period}"> s</label>
    <label title="${md.shape === "ramp" ? "How far it travels by the end, as a share of the slider's range" : "How far it swings, as a share of the slider's range"}">Depth <input type="range" data-f="depth" min="-1" max="1" step="0.01" value="${md.depth}"></label>
    <label ${md.shape === "ramp" ? "hidden" : ""}>Phase <input type="range" data-f="phase" min="0" max="1" step="0.01" value="${md.phase}"></label>
    <canvas width="260" height="44" aria-hidden="true"></canvas>
  </div>`;
}
function renderStack() {
  const el = $q("stack");
  if (!S.stack.length) { el.innerHTML = `<div class="wl-empty">The stack is empty, so the picture stands still. Add a motion below or pick a look.</div>`; afterStructure(); return; }
  el.innerHTML = S.stack.map((m, i) => {
    const d = BY[m.key], showPivot = d.pivot || m.mask.mode > 0;
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
        ${m.key === "video" ? videoBlock(m) : ""}
        ${d.params.map(p => paramRow(m, p)).join("")}
        <div class="wl-where" data-id="${m.id}">
          ${showPivot ? `<span>Pivot <span class="pv">${m.pivot[0].toFixed(2)}, ${m.pivot[1].toFixed(2)}</span></span><button class="btn small" type="button" data-act="center">Centre</button>` : ""}
          <span>Where</span>
          <div class="chips">${["Everywhere", "Near pivot", "Away from pivot"].map((l, k) => `<button class="chip" type="button" data-act="mask" data-mode="${k}" aria-pressed="${m.mask.mode === k}">${l}</button>`).join("")}</div>
          ${m.mask.mode ? `<label>Radius <input type="range" data-f="radius" min="0.05" max="1.8" step="0.01" value="${m.mask.radius}"></label>
          <label>Soft <input type="range" data-f="soft" min="0" max="1" step="0.01" value="${m.mask.soft}"></label>` : ""}
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
  if (act === "vpick") { card.querySelector("[data-vfile]").click(); return; }
  if (act === "vextract") {
    jobKey = fieldKey(m);
    host.runJob("motion", { clip: m.clip, source: m.source, gaps: m.gaps }).then(() => { delete fields[jobKey]; videoStatus(); }).catch(err => host.toast(err.message));
    return;
  }
  if (act === "vstop") { host.stopJob(); return; }
  if (act === "wave") { const k = b.closest(".wl-p").dataset.k; m.ui[k] = !m.ui[k]; const row = card.querySelector(`.wl-curve[data-k="${k}"]`); row.hidden = !m.ui[k]; b.setAttribute("aria-expanded", m.ui[k]); if (m.ui[k]) drawSpark(row); return; }
  if (act === "fold") { m.open = !m.open; renderStack(); return; }
  if (act === "solo") { m.solo = !m.solo; renderStack(); resettle(0); return; }   // preview only, not saved
  if (act === "up" && i > 0) { S.stack.splice(i, 1); S.stack.splice(i - 1, 0, m); }
  else if (act === "down" && i < S.stack.length - 1) { S.stack.splice(i, 1); S.stack.splice(i + 1, 0, m); }
  else if (act === "on") m.on = !m.on;
  else if (act === "del") { S.stack.splice(i, 1); if (selId === m.id) selId = S.stack[0]?.id || 0; }
  else if (act === "center") m.pivot = [0, 0];
  else if (act === "mask") { m.mask.mode = +b.dataset.mode; selId = m.id; }
  else return;
  lookIdx = -1; renderLooks(); renderStack(); commit(); resettle(0);
}
function onStackInput(e) {
  const el = e.target;
  if (el.dataset.vf || el.matches("[data-vfile]")) {
    const vm = findMod(el.closest("[data-id]").dataset.id); if (!vm) return;
    if (el.matches("[data-vfile]")) { uploadClip(vm, el.files[0]); el.value = ""; return; }
    vm[el.dataset.vf] = el.value;
    renderStack(); commit(); loadField(vm); resettle(0);
    return;
  }
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
  lookIdx = -1; renderLooks(); commit(); resettle();
}

// ---- catalog, looks, globals
function renderCatalog() {
  const full = S.stack.length >= MAXM;
  $q("catalog").innerHTML = FAMS.map(([fam, sub]) => `<div class="wl-fam">${fam}${sub ? ` · <span style="text-transform:none;letter-spacing:0;font-weight:400">${sub}</span>` : ""}</div>
    <div class="wl-cat">${MODS.filter(d => d.fam === fam).map(d => { const off = full || (d.key === "video" && S.stack.some(x => x.key === "video"));
      return `<button class="wl-c" type="button" data-add="${d.key}" ${off ? "disabled" : ""} title="${full ? "The stack holds 8 modules at most" : off ? "One Video motion module at a time" : "Add " + d.name}">
      <canvas data-glyph="${d.key}" aria-hidden="true"></canvas><b>${d.name}</b><p>${d.blurb}</p></button>`; }).join("")}</div>`).join("");
  $q("catalog").querySelectorAll("canvas[data-glyph]").forEach(c => paintGlyph(c, c.dataset.glyph));
}
function renderLooks() { $q("looks").innerHTML = LOOKS.map(([n], i) => `<button class="chip" type="button" data-look="${i}" aria-pressed="${i === lookIdx}">${n}</button>`).join(""); }
function pickSel() { return (S.stack.find(m => BY[m.key].pivot && m.key !== "zoom") || S.stack[0] || {}).id || 0; }
function applyLook(i) {
  const [, mk, g = {}] = LOOKS[i]; lookIdx = i; S.stack = mk(); selId = pickSel();
  setGlobal("prism", g.prism ?? 0); S.edge = g.edge ?? 0;
  renderLooks(); renderStack(); renderGlobals(); commit(); resettle(0);
}
function setGlobal(key, v) { S[key] = v; $$(`[data-g="${key}"]`).forEach(e => e.value = v); }
function renderGlobals() {
  for (const k of ["prism", "fresh", "sharp"]) $$(`[data-g="${k}"]`).forEach(e => { if (e !== document.activeElement) e.value = S[k]; });
  $q("edges").querySelectorAll("[data-edge]").forEach(c => c.setAttribute("aria-pressed", +c.dataset.edge === S.edge));
  markChanged();
}
// the edges / prism rows get the editor's yellow "changed" outline when they differ from settings.ini
function markChanged() {
  const sv = host.saved?.() || {}, cw = host.get() || {};
  $$(".ctl[data-wk]").forEach(c => c.classList.toggle("changed", String(cw[c.dataset.wk] ?? "") !== String(sv[c.dataset.wk] ?? "")));
}
function afterStructure() { renderCatalog(); drawOverlay(); drawLanesNow = true; }

// ---- views
function renderViewOpt() {
  const vo = $q("vo");
  if (S.view === 0) vo.innerHTML = `<span>The picture after the motion, with a stand-in for the dream. Judge the movement, not the content.</span>`;
  else if (S.view === 1) vo.innerHTML = floatOK ? `<label>Carried for <input type="range" data-v="win" min="0.1" max="3" step="0.05" value="${S.gridWin}"> <span data-r="winl">${S.gridWin.toFixed(2)} s</span></label><span>Gold lines are the frame's centre axes.</span>` : `<span>This browser can't render float textures, so the grid view is off.</span>`;
  else if (S.view === 2) vo.innerHTML = `<label>Arrow length <input type="range" data-v="gain" min="0" max="3.5" step="0.01" value="${Math.log10(Math.max(1, S.gain || 60))}" ${S.autoGain ? "disabled" : ""}></label><label><input type="checkbox" data-v="auto" ${S.autoGain ? "checked" : ""}> Fit</label><span data-r="gainl"></span>`;
  else vo.innerHTML = `<div class="chips"><button class="chip" type="button" data-sm="0" aria-pressed="${S.smode === 0}">Growth</button><button class="chip" type="button" data-sm="1" aria-pressed="${S.smode === 1}">Streaking</button></div>
    ${S.smode === 0 ? `<span class="wl-legend">shrinks<i style="background:linear-gradient(90deg,#f0a34a,#21242e,#40c7bd)"></i>grows ×4/s</span>` : `<span class="wl-legend">round<i style="background:linear-gradient(90deg,#21242e,#f5d76e)"></i>×2.7/s longer</span>`}
    <span class="wl-legend"><i style="width:10px;background:var(--bad)"></i>tears</span><span class="wl-legend"><i style="width:10px;background:repeating-linear-gradient(135deg,#292b35 0 3px,#525765 3px 6px)"></i>edge fill</span>`;
}

// ---- overlay: pivot + ring
function drawOverlay() {
  const ov = $q("ov"); ov.setAttribute("viewBox", `${-A} -1 ${2 * A} 2`);
  const m = findMod(selId);
  if (!m) { ov.innerHTML = ""; return; }
  const d = BY[m.key], [x, y] = m.pivot; let s = "";
  if (m.mask.mode) s += `<circle cx="${x}" cy="${y}" r="${m.mask.radius}" fill="none" stroke="#f5d76e" stroke-width="0.008" stroke-dasharray="0.03 0.02"/>`;
  if (m.key === "bulge") { const o = paramAt(m, d.params[2], frame * DT); s += `<circle cx="${x}" cy="${y}" r="${o}" fill="none" stroke="#e7e9ee" stroke-opacity=".45" stroke-width="0.006" stroke-dasharray="0.015 0.015"/>`; }
  if (d.pivot || m.mask.mode) s += `<g stroke="#0d0f13" stroke-width="0.016"><circle cx="${x}" cy="${y}" r="0.035" fill="#3fc6bd"/></g><path d="M${x - .08} ${y}h.03M${x + .05} ${y}h.03M${x} ${y - .08}v.03M${x} ${y + .05}v.03" stroke="#3fc6bd" stroke-width="0.01"/>`;
  ov.innerHTML = `<g transform="scale(1,-1)">${s}</g>`;
}
let dragging = false;
function pointerToP(e) { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) / r.width * 2 - 1) * A, -((e.clientY - r.top) / r.height * 2 - 1)]; }
function movePivot(e) {
  const m = findMod(selId); if (!m) return;
  const [x, y] = pointerToP(e); m.pivot = [+clamp(x, -A, A).toFixed(3), +clamp(y, -1, 1).toFixed(3)];
  const pv = $q("stack").querySelector(`.wl-mod[data-id="${m.id}"] .pv`); if (pv) pv.textContent = `${m.pivot[0].toFixed(2)}, ${m.pivot[1].toFixed(2)}`;
  drawOverlay(); commit(); resettle();
}

// ----------------------------------------------------------------------------- timeline
let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches, speed = 1, acc = 0, pendingTo = -1, settleT = 0, drawLanesNow = true;
function seek(f) { reset(); pendingTo = Math.max(0, Math.round(f)); }
function resettle(delay) {
  if (!$q("settle").checked && delay !== 0) return;
  clearTimeout(settleT); const target = frame;
  settleT = setTimeout(() => seek(target), delay ?? (playing ? 450 : 120));
}
function setPlaying(p) { playing = p; $q("play").textContent = p ? "Pause" : "Play"; }
function lanes() { const out = []; for (const m of S.stack) for (const p of BY[m.key].params) if (m.mod[p.k].shape !== "none") out.push([m, p]); return out; }
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

// ----------------------------------------------------------------------------- readout
function bar(v, max, cls = "") { return `<span class="wl-bar ${cls}"><div style="width:${clamp(v / max, 0, 1) * 100}%"></div></span>`; }
function renderReadout(st) {
  const L = active(), x = v => "×" + Math.exp(v).toFixed(v > 2.3 ? 0 : 1), edgeName = EDGES[S.edge];
  const gw = st.grow > Math.log(4) ? "bad" : st.grow > Math.log(2) ? "warn" : "", sw = st.shear > Math.log(4) ? "warn" : "", tw = st.tears > .03 ? "bad" : "";
  $q("facts").innerHTML = `
    <dt>Motion</dt><dd><b>${(st.motion * 100).toFixed(1)}%</b>${bar(st.motion, .6)}<span class="status">of height / s</span></dd>
    <dt>Fastest growth</dt><dd><b>${x(Math.max(0, st.grow))} / s</b>${bar(Math.max(0, st.grow), Math.log(8), gw)}</dd>
    <dt>Streaking</dt><dd><b>${x(Math.max(0, st.shear))} / s</b>${bar(Math.max(0, st.shear), Math.log(5), sw)}</dd>
    <dt>Tears</dt><dd><b>${(st.tears * 100).toFixed(1)}%</b>${bar(st.tears, .1, tw)}</dd>
    <dt>Edge fill</dt><dd><b>${(st.outside * 100).toFixed(0)}%</b>${bar(st.outside, .6)}<span class="status">${edgeName}</span></dd>`;
  const w = [], add = (c, h) => w.push(`<div class="w ${c}">${h}</div>`);
  if (!L.length) add("", "<b>No active motion.</b> The dream would paint over a still frame and lock into fixed shapes.");
  else if (st.motion < .004) add("", "<b>Almost still.</b> Shapes will settle and stop changing. Most looks need at least a slow zoom or flow.");
  if (gw === "bad") add("bad", `<b>Parts of the frame grow ${x(st.grow)} a second.</b> The network has to repaint them constantly; expect smears or flicker there. The Stress view shows where.`);
  else if (gw === "warn") add("warn", `<b>Growth up to ${x(st.grow)} a second.</b> Fine for zoom tunnels; in a render these spots look softer than the rest.`);
  if (sw) add("warn", `<b>Shapes stretch into streaks</b> (${x(st.shear)} longer per second at the worst spots). Lower the strongest Swirl, Melt or Tilt, or limit it to a ring.`);
  if (tw) add("bad", `<b>${(st.tears * 100).toFixed(0)}% of the frame tears.</b> The picture is cut and joined there, so seams show. Lower the module with the hardest edge.`);
  if (st.outside > .25) add(S.edge === 1 ? "" : "warn", S.edge === 1 ? `<b>${(st.outside * 100).toFixed(0)}% of the frame came from beyond the edge</b> in the last second, filled by tiling the picture.` : `<b>${(st.outside * 100).toFixed(0)}% of the frame came from beyond the edge</b> in the last second. ${S.edge === 2 ? "Smear" : "Reflect"} fills it with stretched copies of the border, so the dream has little to work with there. Wrap tiles real picture in instead.`);
  if (L.some(m => m.key === "kaleido")) add("", "<b>The kaleidoscope isn't counted above.</b> Its mirror seams always show; the numbers describe the motion underneath it.");
  for (const m of L.filter(m => m.key === "video")) {
    if (!m.clip) add("bad", "<b>Video motion has no clip.</b> It does nothing, and a render stops with an error until you choose one.");
    else if (!readyField(m)) add("warn", "<b>The clip's motion isn't extracted yet.</b> Press Extract motion on its card; otherwise the render extracts it first, which takes a while.");
  }
  if (L.some(m => m.key === "edge")) add("", "<b>Contour flow reacts to the picture.</b> Here it follows the preview picture; in a render it follows the dream.");
  if (S.stack.some(m => m.solo)) add("", "<b>Solo is on.</b> The preview plays only the soloed modules; the render uses every module that is on.");
  $q("warnings").innerHTML = w.join("");
}

// ----------------------------------------------------------------------------- random warp
// Not uniform noise. One motion carries the picture through the frame, one to three more shape it, values come
// from each setting's useful middle, curve periods sit in simple ratios, and the result is turned down until it
// passes the motion check at the start, middle and end of the video. Recent combinations are skipped.
const R = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const sgn = (p = .5) => Math.random() < p ? 1 : -1;
const pm = (a, b) => sgn() * R(a, b);
function wpick(items) { const tot = items.reduce((s, [, w]) => s + w, 0); let x = Math.random() * tot; for (const [it, w] of items) if ((x -= w) <= 0) return it; return items[items.length - 1][0]; }
// carry/spice: how likely as the main motion / as an extra. rank: stack order (camera, bends, flows, self-driven, symmetry last).
const RND = {
  zoom:    { carry: 3, spice: 0, rank: 0, roll: () => ({ rate: R(.08, .35) * sgn(.85), bend: Math.random() < .4 ? R(-.3, .4) : 0 }) },
  drift:   { carry: 1, spice: 0, rank: 0, roll: () => ({ speed: R(.05, .25), angle: R(-180, 180) }) },
  flow:    { carry: 2, spice: 1.5, rank: 2, roll: () => ({ amp: R(.1, .35), scale: R(.8, 2.5), speed: R(.1, .4), detail: R(.1, .6) }) },
  melt:    { carry: 1.5, spice: 1, rank: 2, roll: () => ({ speed: pm(.08, .25), angle: Math.random() < .7 ? pick([-90, 90]) + R(-20, 20) : R(-180, 180), streaks: R(6, 30), vary: R(.3, .7), wobble: R(.1, .6) }) },
  spin:    { spice: 2, rank: 0, roll: () => ({ rate: pm(.04, .25) }) },
  tilt:    { spice: 1, rank: 0, roll: () => ({ tx: pm(0, .15), ty: pm(.05, .18), shear: pm(0, .15) }) },
  shake:   { spice: 1, rank: 0, roll: () => ({ amp: R(.006, .025), rate: R(.6, 2.5), roll: R(0, .02) }) },
  swirl:   { spice: 3, rank: 1, roll: () => ({ rate: pm(.3, 1.2), size: R(.25, .9), tail: R(0, .7) }) },
  bulge:   { spice: 2, rank: 1, roll: () => ({ k: pm(.4, 1.2), size: R(.2, .6), orbit: Math.random() < .6 ? R(.2, .7) : 0, speed: pm(.2, 1) }) },
  mobius:  { spice: 1.5, rank: 1, roll: () => ({ k: pm(.05, .2), spin: pm(.1, .5), phase: R(-180, 180) }) },
  ripple:  { spice: 2, rank: 2, roll: () => ({ amp: R(.03, .12), freq: R(1.5, 5), speed: pm(1.5, 6), radial: Math.random() < .5 ? 1 : R(0, .5), angle: R(-180, 180) }) },
  edge:    { spice: 1, rank: 3, roll: () => ({ amp: R(.2, .5), angle: Math.random() < .7 ? pick([90, -90]) : R(-30, 30) }) },
  kaleido: { spice: .8, rank: 4, roll: () => ({ n: R(3, 8), spin: pm(.02, .12), mix: R(.85, 1) }) },
};
const CURVE_KEY = { zoom: "rate", drift: "speed", flow: "amp", melt: "speed", spin: "rate", tilt: "ty", shake: "amp", swirl: "rate", bulge: "k", mobius: "k", ripple: "amp", edge: "amp", kaleido: "spin" };
function rollModule(key) {
  const d = BY[key], vals = RND[key].roll();
  for (const p of d.params) if (p.k in vals) vals[p.k] = +(Math.round(clamp(vals[p.k], p.min, p.max) / p.step) * p.step).toFixed(decimals(p.step));
  const m = M(key, vals);
  if (d.pivot && key !== "kaleido" && Math.random() < .35) m.pivot = [+(pick([-1, 1]) * A / 3).toFixed(2), +(pick([-1, 0, 1]) / 3).toFixed(2)];   // a thirds point
  return m;
}
function addCurves(list) {
  const base = pick([6, 8, 10, 12, 16, 21]), n = wpick([[0, 2], [1, 4], [2, 3]]);
  list.filter(m => CURVE_KEY[m.key]).sort(() => Math.random() - .5).slice(0, n).forEach((m, i) => {
    const shape = wpick([["sine", 5], ["tri", 1.5], ["noise", 2], ["pulse", .5], ["ramp", 1]]);
    m.mod[CURVE_KEY[m.key]] = { shape, period: i ? base * pick([.5, 2]) : base, depth: +pm(.15, .45).toFixed(2), phase: +Math.random().toFixed(2) };
  });
}
function rollStack() {
  const carry = wpick(Object.entries(RND).filter(([, r]) => r.carry).map(([k, r]) => [k, r.carry]));
  const used = new Set([carry]), stack = [rollModule(carry)], extras = wpick([[1, 4], [2, 4.5], [3, 1.5]]);
  while (stack.length < extras + 1) {
    const k = wpick(Object.entries(RND).filter(([k, r]) => r.spice && !used.has(k)).map(([k, r]) => [k, r.spice]));
    used.add(k); stack.push(rollModule(k));
  }
  stack.sort((a, b) => RND[a.key].rank - RND[b.key].rank);
  addCurves(stack);
  if (Math.random() < .15) { const m = pick(stack.slice(1)); m.mask = { mode: pick([1, 2]), radius: +R(.35, .8).toFixed(2), soft: +R(.3, .6).toFixed(2) }; }
  return { stack, prism: Math.random() < .25 ? +R(.001, .004).toFixed(4) : 0, edge: wpick([[0, 75], [1, 15], [2, 10]]) };
}
function rerollStack() {
  const stack = S.stack.map(o => o.key === "video" ? o : Object.assign(rollModule(o.key), { on: o.on, solo: o.solo, open: o.open, mask: { ...o.mask } }));
  addCurves(stack); return { stack, prism: S.prism, edge: S.edge };
}
// How far past the limits the readout warns about; also roughly how much to scale the strengths to land inside
// (stretch grows about linearly with them).
function judge(list) {
  list = list.filter(m => m.key !== "edge");   // Contour flow's stretch depends on the picture, and here that is only a stand-in
  let grow = 0, shear = 0, tears = 0;
  for (const t of [1, S.T * .5, S.T * .95]) { const s = readStats(list, t); grow = Math.max(grow, s.grow); shear = Math.max(shear, s.shear); tears = Math.max(tears, s.tears); }
  // streaking is the look of Liquid and Melt, so it gets more room than growth (which smears) and tears (seams)
  const G = Math.log(4), H = Math.log(5), TR = .03;
  const pen = Math.max(0, grow - G) * 3 + Math.max(0, shear - H) * 2 + Math.max(0, tears - TR) * 40;
  const k = Math.min(grow > G ? G / grow : 1, shear > H ? H / shear : 1, tears > TR ? .6 : 1);
  return { pen, k };
}
const STRENGTH = { zoom: ["rate"], drift: ["speed"], flow: ["amp"], melt: ["speed"], spin: ["rate"], tilt: ["tx", "ty", "shear"], shake: ["amp", "roll"],
  swirl: ["rate"], bulge: ["k"], mobius: ["k"], ripple: ["amp"], edge: ["amp"], kaleido: [], video: ["amp"] };
function tame(list, f) {
  for (const m of list) for (const k of STRENGTH[m.key]) {
    const p = BY[m.key].params.find(q => q.k === k);
    m.vals[k] = +(Math.round(m.vals[k] * f / p.step) * p.step).toFixed(decimals(p.step)); m.mod[k].depth = +(m.mod[k].depth * f).toFixed(2);
  }
}
const recentSigs = [];
function randomWarp(reroll) {
  if (reroll && !S.stack.length) reroll = false;
  const selIdx = S.stack.findIndex(m => m.id === selId), sig = c => c.stack.map(m => m.key).join("+");
  let c;
  for (let i = 0; i < 12; i++) { c = reroll ? rerollStack() : rollStack(); if (reroll || !recentSigs.includes(sig(c))) break; }
  let j = floatOK ? judge(c.stack) : { pen: 0 }, tamed = 0;
  while (j.pen > 0 && tamed < 4) { tame(c.stack, clamp(j.k * .92, .25, .9)); j = judge(c.stack); tamed++; }
  if (!reroll) { recentSigs.push(sig(c)); if (recentSigs.length > 5) recentSigs.shift(); }
  S.stack = c.stack; setGlobal("prism", c.prism); S.edge = c.edge; lookIdx = -1;
  selId = reroll && selIdx >= 0 ? S.stack[selIdx].id : pickSel();
  renderLooks(); renderStack(); renderGlobals(); commit(); resettle(0);
  host.toast(`${reroll ? "Re-rolled" : "Random warp"}: ${S.stack.map(m => BY[m.key].name).join(" + ")}${tamed ? " · turned down to stay inside the limits" : ""} (not saved yet)`);
}

// ----------------------------------------------------------------------------- main loop
let visible = false, last = performance.now(), n = 0, started = false;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(.1, (now - last) / 1000); last = now;
  if (!visible || document.hidden) return;   // paused while the Motion tab is not shown
  const r = host.render(), T = clamp(+r.seconds || 20, 1, 3600), asp = clamp((+r.width || 16) / (+r.height || 9), .5, 3);
  if (T !== S.T) { S.T = T; $q("scrub").max = T; drawLanesNow = true; $$(".wl-curve").forEach(row => { if (!row.hidden) drawSpark(row); }); }
  if (Math.abs(asp - A) > .005) { A = asp; side.style.setProperty("--wl-aspect", A); $q("screen").style.aspectRatio = String(A); makeTargets(); setPic(picName === "start" ? "garden" : picName, true) || setPic("garden", true); drawOverlay(); }
  if (pendingTo >= 0) {
    let k = 0; while (frame < pendingTo && k < 90) { step(); k++; }
    const busy = $q("busy");
    if (frame >= pendingTo) { pendingTo = -1; busy.hidden = true; } else { busy.hidden = false; busy.textContent = `Re-running from frame 0… ${Math.round(frame / pendingTo * 100)}%`; }
  } else if (playing) {
    acc += dt * speed; let k = 0;
    while (acc >= DT && k < 4) { step(); acc -= DT; k++; if (frame * DT >= S.T) { reset(); } }
    if (k === 4) acc = 0;
  }
  draw();
  if (floatOK && n % 8 === 0) { lastStats = readStats(active(), frame * DT); renderReadout(lastStats); }
  if (S.view === 2 && n % 8 === 0) { const l = $q("gainl"); if (l) l.textContent = `×${Math.round(S.gain)}`; }
  $q("clock").textContent = `${(frame * DT).toFixed(1)} / ${S.T} s`;
  const sc = $q("scrub"); if (document.activeElement !== sc) sc.value = frame * DT;
  if (drawLanesNow || playing || pendingTo >= 0) { drawLanes(); drawLanesNow = false; }
  if (findMod(selId)?.key === "bulge" && n % 2 === 0) drawOverlay();
  n++;
}

// ----------------------------------------------------------------------------- wiring
function wire() {
  $q("stack").addEventListener("click", onStackClick);
  $q("stack").addEventListener("input", onStackInput);
  const dropTarget = e => e.target.closest?.(".wl-video");   // drop a clip on a Video motion card
  $q("stack").addEventListener("dragover", e => { const v = dropTarget(e); if (v && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); v.classList.add("drop"); } });
  $q("stack").addEventListener("dragleave", e => dropTarget(e)?.classList.remove("drop"));
  $q("stack").addEventListener("drop", e => {
    const v = dropTarget(e); if (!v) return;
    e.preventDefault(); v.classList.remove("drop");
    const m = findMod(v.dataset.id); if (m) uploadClip(m, e.dataTransfer.files[0]);
  });
  $q("catalog").addEventListener("click", e => {
    const b = e.target.closest("[data-add]"); if (!b || b.disabled || S.stack.length >= MAXM) return;
    const m = M(b.dataset.add); S.stack.push(m); selId = m.id; lookIdx = -1; renderLooks(); renderStack(); commit(); resettle(0);
    host.toast(`Added ${BY[m.key].name} (not saved yet)`);
  });
  $q("looks").addEventListener("click", e => { const b = e.target.closest("[data-look]"); if (b) applyLook(+b.dataset.look); });
  $q("rnd").onclick = () => randomWarp(false);
  $q("reroll").onclick = () => randomWarp(true);
  const onGlobal = e => {
    const g = e.target.dataset.g; if (!g) return;
    const v = +e.target.value; if (e.target.value === "" || !isFinite(v)) return;
    S[g] = v; $$(`[data-g="${g}"]`).forEach(x => { if (x !== e.target) x.value = v; });
    if (g === "prism") commit();
    resettle();
  };
  root.addEventListener("input", onGlobal); side.addEventListener("input", onGlobal);
  $q("edges").addEventListener("click", e => { const b = e.target.closest("[data-edge]"); if (!b) return; S.edge = +b.dataset.edge; renderGlobals(); commit(); resettle(0); });
  side.querySelector(".wl-views").addEventListener("click", e => {
    const b = e.target.closest("[data-view]"); if (!b) return; S.view = +b.dataset.view;
    side.querySelectorAll(".wl-views [data-view]").forEach(x => x.setAttribute("aria-selected", x === b)); renderViewOpt();
  });
  $q("vo").addEventListener("input", e => {
    const v = e.target.dataset.v;
    if (v === "win") { S.gridWin = +e.target.value; $q("winl").textContent = S.gridWin.toFixed(2) + " s"; }
    if (v === "gain") S.gain = Math.pow(10, +e.target.value);
    if (v === "auto") { S.autoGain = e.target.checked; renderViewOpt(); }
  });
  $q("vo").addEventListener("click", e => { const b = e.target.closest("[data-sm]"); if (b) { S.smode = +b.dataset.sm; renderViewOpt(); } });
  side.querySelector(".wl-src").addEventListener("click", e => { const b = e.target.closest("[data-src]"); if (b) setPic(b.dataset.src); });
  const screen = $q("screen");
  screen.addEventListener("pointerdown", e => {
    const m = findMod(selId); if (!m) { host.toast("Select a module in the stack first"); return; }
    if (!BY[m.key].pivot && !m.mask.mode) { host.toast(`${BY[m.key].name} has no pivot. Limit it to a ring under "Where" to place one.`); return; }
    dragging = true; screen.setPointerCapture(e.pointerId); movePivot(e);
  });
  screen.addEventListener("pointermove", e => { if (dragging) movePivot(e); });
  screen.addEventListener("pointerup", () => dragging = false);
  screen.addEventListener("pointercancel", () => dragging = false);
  $q("play").onclick = () => setPlaying(!playing);
  $q("restart").onclick = () => seek(0);
  $q("speed").onchange = e => speed = +e.target.value;
  $q("scrub").addEventListener("input", e => { setPlaying(false); seek(+e.target.value * 30); });
  $q("extra").addEventListener("click", e => {
    const b = e.target.closest("[data-wrevert]"); if (!b) return;
    const sv = host.saved?.() || {};
    if (b.dataset.wrevert === "edge") S.edge = Math.max(0, EDGES.indexOf(String(sv.edge || "reflect").trim())); else S.prism = +sv.prism || 0;
    renderGlobals(); commit(); resettle(0);
  });
  document.addEventListener("keydown", e => {
    if (!visible || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "r" || e.target.closest("input, select, textarea")) return;
    e.preventDefault(); randomWarp(e.shiftKey);
  });
}

// ----------------------------------------------------------------------------- public
// Re-read cur.warp. Does nothing if it is what this tab wrote. An empty stack is a still picture.
function sync() {
  if (!root) return;
  markChanged();   // also after a save, when the stack itself is unchanged
  const d = host.get() || {}, sig = JSON.stringify(d);
  if (sig === lastSig) return;
  lastSig = sig;
  const old = S.stack, p = fromDict(d);
  S.stack = p.stack; S.edge = p.edge; S.prism = p.prism;
  if (p.unknown.length) host.toast(`Unknown motion modules ignored: ${p.unknown.join(", ")}`);
  S.stack.forEach((m, i) => { const o = old[i]; if (o && o.key === m.key) { m.open = o.open; m.ui = o.ui; m.solo = o.solo; if (o.id === selId) selId = m.id; } });
  if (!S.stack.some(m => m.id === selId)) selId = pickSel();
  lookIdx = -1;
  renderLooks(); renderStack(); renderGlobals();
  S.stack.filter(m => m.key === "video").forEach(loadField);
  if (gl && cur) resettle(0);
}
// the editor passes every job update; a finished motion extraction makes its field load
function onJob(j) {
  job = j;
  if (j.kind === "motion" && !j.running && j.ended && j.ended !== lastJobEnd) {
    lastJobEnd = j.ended;
    for (const k in fields) if (fields[k].state !== "ready") delete fields[k];
    S.stack.filter(m => m.key === "video").forEach(loadField);
  }
  videoStatus();
}
function show(on) {
  visible = on;
  if (!on || !gl || started) return;
  started = true;   // first time the tab is opened: use the monitor's frame if there is one
  if (!setPic("monitor", true)) setPic("garden", true);
}
// The editor's recipes still speak in the old zoom_rate / rotate_rate: they set the stack's first Zoom (added at
// the top if missing) and the wobble of its first Spin (a sine of depth 6 x rotate_rate, as in old files).
function applyRecipe(zr, rr) {
  if (zr === undefined && rr === undefined) return;
  if (zr !== undefined) {
    let z = S.stack.find(m => m.key === "zoom");
    if (!z && S.stack.length < MAXM) { z = M("zoom"); S.stack.unshift(z); }
    if (z) z.vals.rate = clamp(+zr, -1.5, 1.5);
  }
  if (rr !== undefined) {
    let s = S.stack.find(m => m.key === "spin");
    if (!s && +rr > 0 && S.stack.length < MAXM) { s = M("spin", { rate: 0 }, { rate: { shape: "sine", period: 20.944, depth: 0 } }); S.stack.splice(1, 0, s); }
    if (s) { s.vals.rate = 0; s.mod.rate = { ...MODDEF, shape: "sine", period: 20.944, depth: +clamp(6 * rr, 0, 1).toFixed(4) }; }
  }
  lookIdx = -1; renderLooks(); renderStack(); commit(); resettle(0);
}
// what a recipe's zoom_rate / rotate_rate amounts to in the current stack, so the recipe box can tell it still holds
function oldValue(k) {
  if (k === "zoom_rate") return S.stack.find(m => m.key === "zoom")?.vals.rate ?? 0;
  const s = S.stack.find(m => m.key === "spin");
  return s && s.mod.rate.shape === "sine" && !s.vals.rate ? +(s.mod.rate.depth / 6).toFixed(4) : 0;
}
// for the editor's "What to expect": the stack's names and the zoom speed that sets how long shapes last
function summary() {
  const on = S.stack.filter(m => m.on);
  return { names: on.map(m => BY[m.key].name), zoom: on.filter(m => m.key === "zoom").reduce((a, m) => a + m.vals.rate, 0) };
}
function mount(opts) {
  host = opts; root = opts.root; side = opts.side;
  buildDom(opts.extra);
  wire(); renderViewOpt(); renderGlobals(); setPlaying(playing);
  gl = cv.getContext("webgl2", { antialias: true, premultipliedAlpha: false, alpha: false });
  try {
    if (!gl) throw new Error("This browser has WebGL 2 turned off, so the live preview can't run. The stack still edits and saves.");
    initGL(); setPic("garden", true); reset(); renderGlyphs();
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err); gl = null;
    $q("screen").insertAdjacentHTML("beforeend", `<div class="nogl">${esc(err.message).slice(0, 300)}</div>`);
  }
  if (!floatOK) $q("facts").innerHTML = `<dt>Check</dt><dd>Needs float textures, which this browser doesn't offer.</dd>`;
  sync();
}
return { mount, sync, show, applyRecipe, oldValue, summary, job: onJob, _debug: () => ({ S, readStats, judge, fields, probe: (list, t) => {   // one-frame offset at the frame centre (tests)
    const tex = coordMap(list, t, 1), tg = tex === coordA.t ? coordA : coordB, b = new Float32Array(4), x = tg.w >> 1, y = tg.h >> 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, tg.f); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, b); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [b[0] - ((x + .5) / tg.w * 2 - 1) * A, b[1] - ((y + .5) / tg.h * 2 - 1)]; }, active, randomWarp, rollModule, rollStack, toDict, fromDict, get frame() { return frame; }, get visible() { return visible; } }) };
})();
