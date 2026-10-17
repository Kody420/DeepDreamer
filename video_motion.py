"""
Video motion: turn a clip's movement into motion fields for the "video" module of the warp stack.

    python video_motion.py clip.mp4 --source flow           (the editor runs this as a job)
    python video_motion.py clip.mp4 --source codec --gaps hold

Both sources produce the same thing: one backward field per clip frame. For each pixel of frame t it says
where that pixel was in frame t-1, in warp units (2 = the clip's height, y up), which is exactly what the
sampling grid needs (q = p + v). Field 0 has no previous frame; it copies field 1 (flow) or is a gap (codec).

  flow   dense optical flow between consecutive frames, torchvision RAFT small (smooth, true motion)
  codec  the clip's own H.264/H.265 motion vectors, read with PyAV (blocky, glitchy, datamosh-like)

Results are cached in video_motion/<hash>_<source>.npz (hash = file content), at about 256 px wide for
renders, plus a 64 px wide copy for the editor's preview.
"""
import os, sys, math, hashlib, argparse
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "video_motion")
FIELD_W, PREVIEW_W = 256, 64
MAX_SECONDS = 30           # longer clips are cut; a field is ~150 kB per frame
SOURCES, GAPS = ("flow", "codec"), ("zero", "hold")


def clip_hash(path):
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def cache_path(path, source, gaps="hold"):
    tag = source if source == "flow" else f"codec-{gaps}"   # gaps only matter for codec vectors
    return os.path.join(CACHE, f"{clip_hash(path)}_{tag}.npz")


def _open(path):
    import av
    c = av.open(path)
    s = c.streams.video[0]
    s.thread_type = "AUTO"
    fps = float(s.average_rate or s.guessed_rate or 30)
    n = s.frames or int(float(c.duration or 0) / 1e6 * fps)
    return c, s, fps, min(n, int(MAX_SECONDS * fps)) if n else int(MAX_SECONDS * fps)


def _size(w, h, width):
    """Field size: `width` wide, height to match the clip, both multiples of 8 (RAFT needs that)."""
    fw = width
    fh = max(8, int(round(fw * h / w / 8)) * 8)
    return fw, fh


def _downsample(field, w):
    import torch, torch.nn.functional as F
    n, _, fh, fw = field.shape
    h = max(2, int(round(w * fh / fw)))
    t = torch.from_numpy(field.astype(np.float32))
    return F.interpolate(t, size=(h, w), mode="area").numpy()


def _progress(i, n):
    print(f"\r  frame {i}/{n}", end="", flush=True)


# ----------------------------------------------------------------------------- optical flow (RAFT)
def extract_flow(path):
    import torch
    from torchvision.models.optical_flow import raft_small, Raft_Small_Weights
    from PIL import Image
    c, s, fps, n = _open(path)
    fw, fh = _size(s.codec_context.width, s.codec_context.height, FIELD_W)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = raft_small(weights=Raft_Small_Weights.DEFAULT).eval().to(dev)
    fields, prev = [], None
    with torch.no_grad():
        for i, frame in enumerate(c.decode(s)):
            if i >= n:
                break
            im = frame.to_image().convert("RGB").resize((fw, fh), Image.BILINEAR)
            cur = torch.from_numpy(np.array(im)).permute(2, 0, 1)[None].float().div(127.5).sub(1).to(dev)
            if prev is not None:
                # RAFT(image1, image2): pixel x of image1 is at x + flow in image2. image1 = frame t, image2 = t-1
                flow = model(cur, prev, num_flow_updates=12)[-1][0].cpu().numpy()
                # RAFT jitters by ~0.05 px on a still scene; fade out motion below 0.1-0.3 px so stills stay still
                mag = np.sqrt((flow ** 2).sum(0, keepdims=True))
                flow = flow * np.clip((mag - .1) / .2, 0, 1)
                fields.append(np.stack([flow[0] * 2 / fh, -flow[1] * 2 / fh]))   # px -> warp units, y up
            prev = cur
            _progress(i + 1, n)
    c.close()
    if not fields:
        raise ValueError("The clip needs at least two frames.")
    fields.insert(0, fields[0].copy())
    return np.stack(fields), fps, fw / fh


# ----------------------------------------------------------------------------- codec motion vectors (PyAV)
def extract_codec(path, gaps="hold"):
    """Block motion vectors the encoder stored. Only blocks that copy from the past are used (source < 0).
    A P frame after B frames refers back to the previous I/P frame, several frames earlier, so each vector is
    divided by that distance to keep the motion per frame. Gaps (intra blocks, I frames, future-only blocks)
    are zero or keep the previous frame's field, as `gaps` says."""
    import av
    from av.sidedata.sidedata import Type
    c, s, fps, n = _open(path)
    s.codec_context.options = {"flags2": "+export_mvs"}
    cw, ch = s.codec_context.width, s.codec_context.height
    fw, fh = _size(cw, ch, FIELD_W)
    gw, gh = math.ceil(cw / 4), math.ceil(ch / 4)          # rasterise on the codec's 4 px grid first
    fields, last_anchor, held = [], 0, np.zeros((2, fh, fw), np.float32)
    import torch, torch.nn.functional as F
    for i, frame in enumerate(c.decode(s)):
        if i >= n:
            break
        ptype = int(frame.pict_type)                     # 1 = I, 2 = P, 3 = B
        dist = max(1, i - last_anchor)
        if ptype in (1, 2):
            last_anchor = i
        vx, vy, cov = np.zeros((gh, gw), np.float32), np.zeros((gh, gw), np.float32), np.zeros((gh, gw), np.float32)
        mv = frame.side_data.get(Type.MOTION_VECTORS) if Type.MOTION_VECTORS in frame.side_data else None
        if mv is not None:
            a = mv.to_ndarray()
            a = a[a["source"] < 0]
            for b in a:
                x0, y0 = int(b["dst_x"] - b["w"] / 2) // 4, int(b["dst_y"] - b["h"] / 2) // 4
                x1, y1 = x0 + max(1, int(b["w"]) // 4), y0 + max(1, int(b["h"]) // 4)
                x0, y0 = max(0, x0), max(0, y0)
                vx[y0:y1, x0:x1] = (b["src_x"] - b["dst_x"]) / dist
                vy[y0:y1, x0:x1] = (b["src_y"] - b["dst_y"]) / dist
                cov[y0:y1, x0:x1] = 1
        t = F.interpolate(torch.from_numpy(np.stack([vx, vy, cov]))[None], size=(fh, fw), mode="area")[0].numpy()
        covered = t[2] > .5
        cur = np.stack([t[0] / np.maximum(t[2], 1e-6) * 2 / ch, -t[1] / np.maximum(t[2], 1e-6) * 2 / ch])
        cur[:, ~covered] = held[:, ~covered] if gaps == "hold" else 0
        held = cur
        fields.append(cur)
        _progress(i + 1, n)
    c.close()
    if not fields:
        raise ValueError("No frames could be decoded from the clip.")
    return np.stack(fields), fps, cw / ch


# ----------------------------------------------------------------------------- cache
def extract(path, source="flow", gaps="hold"):
    """Extract (or reuse) the clip's motion; returns the cache file path."""
    if source not in SOURCES:
        raise ValueError(f"source must be flow or codec, not {source!r}")
    out = cache_path(path, source, gaps)
    if os.path.exists(out):
        return out
    field, fps, aspect = extract_flow(path) if source == "flow" else extract_codec(path, gaps)
    field = field.astype(np.float16)
    os.makedirs(CACHE, exist_ok=True)
    tmp = out + ".tmp.npz"
    np.savez_compressed(tmp, field=field, preview=_downsample(field, PREVIEW_W).astype(np.float16),
                        fps=np.float32(fps), aspect=np.float32(aspect), source=source, gaps=gaps)
    os.replace(tmp, out)
    return out


def load(path, source="flow", gaps="hold", extract_missing=True):
    """dict(field=(N,2,H,W) float32, fps, aspect) for the renderer; extracts first if needed."""
    p = cache_path(path, source, gaps)
    if not os.path.exists(p):
        if not extract_missing:
            return None
        print(f"Extracting {source} motion from {os.path.basename(path)} (once, then cached) ...")
        p = extract(path, source, gaps)
        print()
    z = np.load(p)
    return dict(field=z["field"].astype(np.float32), fps=float(z["fps"]), aspect=float(z["aspect"]))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("clip")
    ap.add_argument("--source", choices=SOURCES, default="flow")
    ap.add_argument("--gaps", choices=GAPS, default="hold")
    a = ap.parse_args()
    if not os.path.isfile(a.clip):
        sys.exit(f"Clip not found: {a.clip}")
    try:
        out = extract(a.clip, a.source, a.gaps)
    except ImportError as e:
        sys.exit(f"{e}. Run 1_SETUP.bat again to install it.")
    z = np.load(out)
    print(f"\nSaved motion as {os.path.relpath(out, HERE)}: {z['field'].shape[0]} frames at {float(z['fps']):g} fps")


if __name__ == "__main__":
    main()
