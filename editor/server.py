"""
DeepDreamer settings editor - a small local web app (Python standard library only).

    venv\\Scripts\\python.exe editor\\server.py      (4_EDITOR.bat does this)

Serves the editor on http://127.0.0.1:8765, reads/writes settings.ini (keeping its comments),
runs the preview and the render (3_RENDER.bat, so finished videos are numbered as usual)
and plays the videos in output\\. Only reachable from this computer.
"""
import os, re, sys, json, time, glob, shutil, secrets, threading, subprocess, configparser, webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, unquote, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INI = os.path.join(ROOT, "settings.ini")
OUTPUT = os.path.join(ROOT, "output")
ATTN_OUT = os.path.join(ROOT, "attngan", "last")  # latest text-to-image results
INIT_DIR = os.path.join(ROOT, "init_images")     # start images picked in the editor are copied here
CLIP_DIR = os.path.join(ROOT, "clips")           # clips for the video motion module are copied here
VIDEO_EXT = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
             ".webm": "video/webm", ".avi": "video/x-msvideo"}
IMAGE_EXT = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".bmp": "image/bmp",
             ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff", ".gif": "image/gif"}
PY = os.path.join(ROOT, "venv", "Scripts", "python.exe")
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else int(os.environ.get("DREAM_EDITOR_PORT", "8765"))
VERSION = 7                   # bump with every change to the API; index.html checks it
TOKEN = secrets.token_hex(16)   # every API call must carry it, so other web pages can't drive the editor


# ----------------------------------------------------------------------------- settings.ini
def read_settings(path=INI):
    cp = configparser.ConfigParser(inline_comment_prefixes=("#", ";"), interpolation=None)
    cp.read(path, encoding="utf-8")
    s = {sec: {k: v.strip() for k, v in cp[sec].items()} for sec in ("render", "preview", "warp", "feed") if sec in cp}
    if "warp" not in s and "render" in s:
        s["warp"] = warp_from_old(s["render"])
    if "feed" not in s and "render" in s:
        s["feed"] = feed_from_old(s["render"])
    return s


def warp_from_old(render):
    """Files from before the motion stack have no [warp]; they open as the stack dream.py renders them with
    (warp_from_old there): zoom_rate as a Zoom module, the rotate_rate wobble as a Spin module on a sine."""
    zr, rr = float(render.get("zoom_rate", "0.4") or 0), float(render.get("rotate_rate", "0.05") or 0)
    w = {"stack": "zoom, spin" if rr > 0 else "zoom", "zoom.rate": str(zr)}
    if rr > 0:
        w["spin.rate"] = f"0 ~ sine(period=20.944, depth={min(1.0, 6 * rr):.4g})"
    return w


def feed_from_old(render):
    """Files from before the feed stack have no [feed]; they open as the stack dream.py renders them with
    (feed_from_old there): their noise as a Grain module with one fresh value per pixel."""
    noise = float(render.get("noise", "0") or 0)
    if noise <= 0:
        return {"stack": ""}
    return {"stack": "grain", "grain.amount": str(noise), "grain.life": "0", "grain.grid": "pixel"}


STACK_COMMENTS = {"warp": "; motion stack from the editor's Motion tab: modules run top to bottom (see README)",
                  "feed": "; feed stack from the editor's Feed tab: new material for the dream, top to bottom (see README)"}


def replace_stack(lines, name, vals):
    """A stack section ([warp], the Motion tab; [feed], the Feed tab) is always written whole: modules come and go,
    so updating it key by key would leave old ones behind. An empty dict removes it."""
    start = next((i for i, l in enumerate(lines) if re.match(rf"^\s*\[{name}\]\s*$", l)), None)
    if start is not None:
        end = next((i for i in range(start + 1, len(lines)) if re.match(r"^\s*\[.+\]\s*$", lines[i])), len(lines))
        while end > start and not lines[end - 1].strip():
            end -= 1
        del lines[start:end]
        while start < len(lines) and start > 0 and not lines[start - 1].strip() and not lines[start].strip():
            del lines[start]          # don't leave a double blank line where the section was
    if not vals:
        return lines
    block = [f"[{name}]", STACK_COMMENTS[name]]
    block += [f"{k} = {v}" for k, v in vals.items()]
    if start is None:   # new: put it after [render], before [preview]
        start = next((i for i, l in enumerate(lines) if re.match(r"^\s*\[preview\]\s*$", l)), len(lines))
        while start > 0 and not lines[start - 1].strip():
            start -= 1
        block = [""] + block
    lines[start:start] = block + ([""] if start < len(lines) and lines[start].strip() else [])
    return lines


def write_settings(new):
    """Update values in place so comments and layout survive; append keys the file doesn't have yet."""
    with open(INI, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    for name in ("warp", "feed"):
        if name in new:
            lines = replace_stack(lines, name, new.pop(name))
    sec, seen, last_key_line = None, {}, {}
    out = []
    for line in lines:
        m = re.match(r"^\s*\[(.+?)\]\s*$", line)
        if m:
            sec = m.group(1)
            out.append(line)
            continue
        m = re.match(r"^(\s*)([A-Za-z_][\w]*)(\s*=\s*)([^;#]*?)(\s*[;#].*)?$", line)
        if sec in new and m and not line.lstrip().startswith((";", "#")) and m.group(2) in new[sec]:
            key = m.group(2)
            val = str(new[sec][key]).strip()
            comment = m.group(5) or ""
            if val != m.group(4).strip():          # untouched values keep their line exactly as it was
                head = f"{m.group(1)}{key} = {val}"
                if comment:
                    head = head.ljust(26) if len(head) < 26 else head + " "
                    line = head + comment.lstrip()
                else:
                    line = head
            seen.setdefault(sec, set()).add(key)
        if sec and m and not line.lstrip().startswith((";", "#")):
            last_key_line[sec] = len(out)
        out.append(line)
    # keys that were not in the file: insert after the section's last key
    for s in sorted(new, key=lambda s: -last_key_line.get(s, -1)):
        missing = [k for k in new[s] if k not in seen.get(s, set())]
        if not missing:
            continue
        if s in last_key_line:
            at = last_key_line[s] + 1
            out[at:at] = [f"{k} = {new[s][k]}" for k in missing]
        else:
            out += ["", f"[{s}]"] + [f"{k} = {new[s][k]}" for k in missing]
    tmp = INI + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\r\n") as fh:
        fh.write("\n".join(out) + "\n")
    os.replace(tmp, INI)


# ----------------------------------------------------------------------------- jobs
class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.proc = None
        self.kind = None
        self.started = None
        self.ended = None
        self.code = None
        self.lines = []
        self.partial = ""
        self.frame = self.frames = 0
        self.result = None      # saved video name (render) or "preview.mp4"
        self.stopped = False

    def state(self):
        with self.lock:
            running = self.proc is not None and self.proc.poll() is None
            return dict(kind=self.kind, running=running, code=self.code, started=self.started, ended=self.ended,
                        frame=self.frame, frames=self.frames, result=self.result, stopped=self.stopped,
                        log=self.lines[-40:] + ([self.partial] if self.partial.strip() else []))

    def _line(self, text):
        m = re.search(r"frame (\d+)/(\d+)", text)
        if m:
            self.frame, self.frames = int(m.group(1)), int(m.group(2))
            self.partial = text
            return
        m = re.search(r"Saved (?:video|motion) as (\S+\.(?:mp4|npz))", text)
        if m:
            self.result = m.group(1).replace("\\", "/")
        if text.strip():
            self.lines.append(text.rstrip())
            self.lines = self.lines[-400:]

    def _reader(self, proc):
        buf = b""
        while True:
            ch = proc.stdout.read(1)
            if not ch:
                break
            if ch in (b"\n", b"\r"):
                with self.lock:
                    self._line(buf.decode("utf-8", "replace"))
                buf = b""
            else:
                buf += ch
        with self.lock:
            if buf:
                self._line(buf.decode("utf-8", "replace"))
            self.code = proc.wait()
            self.ended = time.time()
            if self.kind == "preview" and self.code == 0:
                self.result = "preview.mp4"
            if self.kind == "attngan" and self.code == 0:
                self.result = "attngan"

    def start(self, kind, opts=None):
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                raise RuntimeError("Something is already running. Stop it first.")
            env = dict(os.environ, PYTHONUNBUFFERED="1")
            if kind == "preview":
                shutil.rmtree(os.path.join(ROOT, "work_preview"), ignore_errors=True)
                cmd = [PY, os.path.join(ROOT, "dream.py"), "--preview"]
            elif kind == "render":
                cmd = ["cmd", "/c", os.path.join(ROOT, "3_RENDER.bat")]
            elif kind == "motion":   # extract a clip's motion for the video module (video_motion.py)
                o = opts or {}
                clip = resolve(str(o.get("clip", "")))
                if not os.path.isfile(clip):
                    raise ValueError("Pick a clip first.")
                source = o.get("source") if o.get("source") in ("flow", "codec") else "flow"
                gaps = o.get("gaps") if o.get("gaps") in ("zero", "hold") else "hold"
                cmd = [PY, os.path.join(ROOT, "video_motion.py"), clip, "--source", source, "--gaps", gaps]
            elif kind == "attngan":
                o = opts or {}
                ds = o.get("dataset") if o.get("dataset") in ("birds", "coco") else "birds"
                shutil.rmtree(ATTN_OUT, ignore_errors=True)
                cmd = [PY, os.path.join(ROOT, "attngan", "generate.py"), "--dataset", ds, "--seed", str(int(o.get("seed", 1))),
                       "--count", str(int(o.get("count", 4))), "--out", ATTN_OUT, str(o.get("prompt", ""))]
            else:
                raise ValueError(kind)
            # shares the editor's console window, so closing that window also stops a running render
            self.proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT)
            self.kind, self.started, self.ended, self.code = kind, time.time(), None, None
            self.lines, self.partial, self.frame, self.frames, self.result, self.stopped = [], "", 0, 0, None, False
            threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()

    def stop(self):
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                return False
            self.stopped = True
            pid = self.proc.pid
        # the render runs as cmd -> python -> ffmpeg; take the whole tree down
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
        return True


JOB = Job()


# ----------------------------------------------------------------------------- videos
def list_videos():
    vids = []
    for p in glob.glob(os.path.join(OUTPUT, "*.mp4")):
        name = os.path.basename(p)
        m = re.match(r"^(\d+)-", name)
        ini = os.path.splitext(p)[0] + "_settings.ini"
        st = os.stat(p)
        s = read_settings(ini) if os.path.exists(ini) else {}
        vids.append(dict(name=name, num=int(m.group(1)) if m else None, size=st.st_size, mtime=st.st_mtime,
                         settings=s.get("render"), warp=s.get("warp"), feed=s.get("feed")))
    vids.sort(key=lambda v: (v["num"] is None, -(v["num"] or 0), -v["mtime"]))
    return vids


def resolve(p):
    p = p.strip().strip('"')
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def save_clip(name, data):
    """Store a clip picked in the browser in clips\\ (reusing an identical one) and return its full path."""
    import hashlib
    base, ext = os.path.splitext(os.path.basename(name or "clip.mp4"))
    if ext.lower() not in VIDEO_EXT:
        raise ValueError("That is not a video file (use MP4, MOV, MKV, WEBM or AVI).")
    base = re.sub(r"[^\w\-. ]+", "_", base).strip(" .") or "clip"
    os.makedirs(CLIP_DIR, exist_ok=True)
    digest = hashlib.sha1(data).hexdigest()
    for i in range(1000):
        p = os.path.join(CLIP_DIR, f"{base}{'' if i == 0 else f'-{i}'}{ext.lower()}")
        if not os.path.exists(p):
            with open(p, "wb") as fh:
                fh.write(data)
            return p
        with open(p, "rb") as fh:
            if hashlib.sha1(fh.read()).hexdigest() == digest:
                return p
    raise ValueError("Too many clips with that name in clips.")


def motion_field(q):
    """The 64 px preview copy of a clip's extracted motion: 4-byte header length, JSON header, raw float16."""
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    import numpy as np, video_motion
    clip = resolve(q.get("clip", [""])[0])
    if not os.path.isfile(clip):
        return None, "clip not found"
    source = q.get("source", ["flow"])[0]
    p = video_motion.cache_path(clip, source if source in ("flow", "codec") else "flow", q.get("gaps", ["hold"])[0])
    if not os.path.exists(p):
        return None, "not extracted"
    z = np.load(p)
    pv = np.ascontiguousarray(z["preview"].astype(np.float16))
    head = json.dumps(dict(n=int(pv.shape[0]), h=int(pv.shape[2]), w=int(pv.shape[3]), fps=float(z["fps"]), aspect=float(z["aspect"]))).encode()
    return len(head).to_bytes(4, "little") + head + pv.tobytes(), None


def save_init_image(name, data):
    """Store an image picked in the browser in init_images\\ and return its full path."""
    import hashlib, io
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
    except Exception:
        raise ValueError("That file is not an image dream.py can read (use JPG, PNG, BMP, WEBP or TIFF).")
    base, ext = os.path.splitext(os.path.basename(name or "image.jpg"))
    ext = ext.lower() if ext.lower() in IMAGE_EXT else ".png"
    base = re.sub(r"[^\w\-. ]+", "_", base).strip(" .") or "image"
    os.makedirs(INIT_DIR, exist_ok=True)
    digest = hashlib.sha1(data).hexdigest()
    for i in range(1000):
        p = os.path.join(INIT_DIR, f"{base}{'' if i == 0 else f'-{i}'}{ext}")
        if not os.path.exists(p):
            with open(p, "wb") as fh:
                fh.write(data)
            return p
        with open(p, "rb") as fh:            # same picture picked again: reuse it
            if hashlib.sha1(fh.read()).hexdigest() == digest:
                return p
    raise ValueError("Too many images with that name in init_images.")


LIVE = {"live/preview.jpg": ("work_preview", "live.jpg"), "live/preview.json": ("work_preview", "live.jpg.json"),
        "live/render.jpg": ("work", "live.jpg"), "live/render.json": ("work", "live.jpg.json")}


def media_path(rel):
    """Only preview.mp4, the live frame of a running job and files directly in output\\ are served."""
    rel = unquote(rel).replace("\\", "/")
    if rel == "preview.mp4":
        return os.path.join(ROOT, "preview.mp4")
    if rel in LIVE:
        return os.path.join(ROOT, *LIVE[rel])
    if rel.startswith("attngan/") and re.fullmatch(r"[\w.]+\.(png|json)", rel[8:]):
        return os.path.join(ATTN_OUT, rel[8:])
    if rel.startswith("output/") and "/" not in rel[7:] and rel[7:] not in ("", ".", ".."):
        return os.path.join(OUTPUT, rel[7:])
    return None


# ----------------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "DeepDreamerEditor"

    def log_message(self, *a):
        pass

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _api_ok(self):
        return self._host_ok() and self.headers.get("X-Token") == TOKEN

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "forbidden"})
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            with open(os.path.join(os.path.dirname(__file__), "index.html"), encoding="utf-8") as fh:
                return self._send(200, fh.read().replace("__TOKEN__", TOKEN), "text/html; charset=utf-8")
        if path.startswith("/media/"):
            return self._media(path[len("/media/"):])
        if path in ("/warp.js", "/warp.css", "/feed.js"):   # the Motion and Feed tabs' stack editors and previews
            with open(os.path.join(os.path.dirname(__file__), path[1:]), encoding="utf-8") as fh:
                return self._send(200, fh.read(), "text/javascript; charset=utf-8" if path.endswith(".js") else "text/css; charset=utf-8")
        if path == "/api/image":   # thumbnail of the start image; <img> can't send headers, so the token is in the query
            q = parse_qs(urlparse(self.path).query)
            if q.get("token", [""])[0] != TOKEN:
                return self._send(403, {"error": "forbidden"})
            p = q.get("path", [""])[0].strip().strip('"')
            if not os.path.isabs(p):
                p = os.path.join(ROOT, p)
            ext = os.path.splitext(p)[1].lower()
            if ext not in IMAGE_EXT or not os.path.isfile(p):
                return self._send(404, {"error": "not found"})
            with open(p, "rb") as fh:
                return self._send(200, fh.read(), IMAGE_EXT[ext])
        if path == "/api/clip":   # a picked clip, for the Motion tab's preview picture (token in the query, like /api/image)
            q = parse_qs(urlparse(self.path).query)
            if q.get("token", [""])[0] != TOKEN:
                return self._send(403, {"error": "forbidden"})
            p = resolve(q.get("path", [""])[0])
            if os.path.splitext(p)[1].lower() not in VIDEO_EXT or not os.path.isfile(p):
                return self._send(404, {"error": "not found"})
            return self._media("", p)
        if not self._api_ok():
            return self._send(403, {"error": "missing token - reload the page"})
        if path == "/api/motion":
            body, err = motion_field(parse_qs(urlparse(self.path).query))
            if body is None:
                return self._send(404, {"error": err, "missing": err == "not extracted"})
            return self._send(200, body, "application/octet-stream")
        if path == "/api/state":
            return self._send(200, dict(version=VERSION, settings=read_settings(), job=JOB.state(), videos=list_videos(),
                                        unfinished=os.path.isdir(os.path.join(ROOT, "work")),
                                        has_preview=os.path.exists(os.path.join(ROOT, "preview.mp4"))))
        if path == "/api/job":
            return self._send(200, JOB.state())
        if path == "/api/match":   # which ImageNet classes an imagenet-mode prompt picks
            if ROOT not in sys.path:
                sys.path.insert(0, ROOT)
            from prompts import match_classes
            matches, unmatched = match_classes(parse_qs(urlparse(self.path).query).get("prompt", [""])[0])
            return self._send(200, dict(matches=[[p, [n for _, n in m]] for p, m in matches], unmatched=unmatched))
        return self._send(404, {"error": "not found"})

    do_HEAD = do_GET

    def do_POST(self):
        # Take in the whole body before answering, even to refuse it: a browser whose upload is cut off halfway
        # only reports "Failed to fetch", not the reason.
        n = int(self.headers.get("Content-Length") or 0)
        path = urlparse(self.path).path
        limit = {"/api/upload_clip": 2 << 30, "/api/upload_image": 100 << 20}.get(path, 10 << 20)
        if n > limit:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                left -= len(chunk)
            return self._send(413, {"error": "That clip is larger than 2 GB." if path == "/api/upload_clip" else "That file is too large."})
        raw = self.rfile.read(n) if n else b""
        if not self._api_ok():
            return self._send(403, {"error": "The editor was restarted after this page was opened. Reload the page."})
        try:
            if path == "/api/upload_clip":
                saved = save_clip(unquote(self.headers.get("X-Filename") or ""), raw)
                return self._send(200, {"ok": True, "path": saved})
            if path == "/api/upload_image":
                saved = save_init_image(unquote(self.headers.get("X-Filename") or ""), raw)
                return self._send(200, {"ok": True, "path": saved})
            data = json.loads(raw or b"{}")
            if path == "/api/save":
                write_settings({s: {k: v for k, v in vals.items()} for s, vals in data.items() if s in ("render", "preview", "warp", "feed")})
                return self._send(200, {"ok": True, "settings": read_settings()})
            if path == "/api/run":
                JOB.start(data.get("kind"), data)
                return self._send(200, {"ok": True})
            if path == "/api/stop":
                return self._send(200, {"ok": JOB.stop()})
            if path == "/api/attngan_use":   # copy a generated image into init_images and return its path
                name = os.path.basename(str(data.get("file", "")))
                src = os.path.join(ATTN_OUT, name)
                if not re.fullmatch(r"\d+_stage3_256\.png", name) or not os.path.isfile(src):
                    raise ValueError("Generate an image first.")
                with open(src, "rb") as fh:
                    saved = save_init_image(f"attngan_{int(time.time())}.png", fh.read())
                return self._send(200, {"ok": True, "path": saved})
            if path == "/api/discard":
                if JOB.state()["running"]:
                    raise RuntimeError("Stop the running job first.")
                shutil.rmtree(os.path.join(ROOT, "work"), ignore_errors=True)
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})
        except Exception as e:  # report to the page instead of dropping the connection
            return self._send(400, {"error": str(e)})

    def _media(self, rel, p=None):
        p = p or media_path(rel)
        if not p or not os.path.isfile(p):
            return self._send(404, {"error": "not found"})
        size = os.path.getsize(p)
        ctype = {**VIDEO_EXT, ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json"}.get(
            os.path.splitext(p)[1].lower(), "text/plain; charset=utf-8")
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416); self.send_header("Content-Range", f"bytes */{size}"); self.end_headers(); return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(p, "rb") as fh:
                fh.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = fh.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass   # the browser cancels range requests all the time while seeking


def main():
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Port {PORT} is busy - is the editor already open? Try http://127.0.0.1:{PORT}")
        webbrowser.open(f"http://127.0.0.1:{PORT}")
        return
    url = f"http://127.0.0.1:{PORT}"
    print(f"DeepDreamer editor running at {url}  (close this window to stop it)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        JOB.stop()


if __name__ == "__main__":
    main()
