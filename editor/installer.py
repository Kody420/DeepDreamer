"""
DeepDreamer installer - checks that venv\\ has everything dream.py needs and, if not, builds it
(Python standard library only; the editor server runs it in a background thread and shows its progress).

Steps: virtual environment -> pip -> PyTorch (CUDA build matching the NVIDIA driver, else CPU) -> other
packages -> VGG16 weights -> check. Safe to run again at any time: pip skips what is already installed.
"""
import os, re, sys, json, time, shutil, threading, subprocess

SUPPORTED = ((3, 10), (3, 14))     # Python versions PyTorch publishes Windows wheels for
PACKAGES = ["numpy", "pillow", "imageio-ffmpeg", "open_clip_torch", "gdown", "av"]
# (oldest driver CUDA version, PyTorch wheel index), newest first
CUDA_BUILDS = [((12, 8), "cu128"), ((12, 6), "cu126")]
CHECK = ("import torch, torchvision, numpy, PIL, imageio_ffmpeg, open_clip, av, gdown; "
         "print(torch.__version__, torch.cuda.is_available())")
WEIGHTS = "import torchvision as t; t.models.vgg16(weights=t.models.VGG16_Weights.IMAGENET1K_V1); print('weights OK')"
MARKER_VERSION = 1


def nvidia_driver_cuda():
    """(major, minor) CUDA version the installed NVIDIA driver supports, or None without an NVIDIA driver."""
    exes = [shutil.which("nvidia-smi"),
            os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe"),
            os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe")]
    for exe in exes:
        if exe and os.path.isfile(exe):
            try:
                out = subprocess.run([exe], capture_output=True, text=True, timeout=30).stdout
            except (OSError, subprocess.SubprocessError):
                continue
            m = re.search(r"CUDA Version:\s*(\d+)\.(\d+)", out)
            if m:
                return int(m.group(1)), int(m.group(2))
    return None


def pick_torch_index():
    """-> (pip index url, label, warning or None)"""
    cuda = nvidia_driver_cuda()
    base = "https://download.pytorch.org/whl/"
    if cuda is None:
        return base + "cpu", "CPU", ("No NVIDIA graphics card (driver) found. DeepDreamer will install the CPU version of "
                                     "PyTorch, which works but is very slow. Install the NVIDIA driver and restart if you have a card.")
    for need, tag in CUDA_BUILDS:
        if cuda >= need:
            return base + tag, f"NVIDIA GPU ({tag})", None
    return base + "cpu", "CPU", (f"Your NVIDIA driver is too old for the GPU version of PyTorch (it supports CUDA "
                                 f"{cuda[0]}.{cuda[1]}, 12.6 or newer is needed). Update the driver from nvidia.com, then restart DeepDreamer.")


class Installer:
    def __init__(self, root):
        self.root = root
        self.venv = os.path.join(root, "venv")
        self.py = os.path.join(self.venv, "Scripts", "python.exe")
        self.marker = os.path.join(self.venv, "deepdreamer.json")
        self.lock = threading.Lock()
        self.status = "checking"      # checking | installing | ready | error
        self.step = 0
        self.steps = ["Check the installation", "Create the Python environment", "Install PyTorch (about 3 GB)",
                      "Install the other packages", "Download the VGG16 network (500 MB)", "Final check"]
        self.log = []
        self.error = None
        self.warning = None
        self.info = {}
        self.proc = None
        self.thread = None

    # ---- state for the page
    def state(self):
        with self.lock:
            return dict(status=self.status, step=self.step, steps=self.steps, log=self.log[-60:], error=self.error,
                        warning=self.warning, info=self.info, python=sys.version.split()[0])

    def ready(self):
        return self.status == "ready"

    def _say(self, text):
        with self.lock:
            self.log.append(text.rstrip())
            self.log = self.log[-500:]
        print(text.rstrip(), flush=True)

    def _set(self, **kw):
        with self.lock:
            for k, v in kw.items():
                setattr(self, k, v)

    # ---- running things
    def _run(self, cmd, **kw):
        """Run a command, streaming its output into the log; raise on a non-zero exit code."""
        self._say("> " + " ".join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd)))
        env = dict(os.environ, PYTHONUNBUFFERED="1", PIP_DISABLE_PIP_VERSION_CHECK="1", PYTHONIOENCODING="utf-8")
        proc = subprocess.Popen(cmd, cwd=self.root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, **kw)
        self.proc = proc
        buf = b""
        tail = []
        def line(b):
            t = b.decode("utf-8", "replace").strip()
            if t:
                tail.append(t)
                self._say("  " + t[:300])
        while True:
            ch = proc.stdout.read(1)
            if not ch:
                break
            if ch in (b"\n", b"\r"):
                line(buf)
                buf = b""
            else:
                buf += ch
        line(buf)
        code = proc.wait()
        self.proc = None
        if code != 0:
            raise RuntimeError("\n".join(tail[-6:]) or f"exit code {code}")
        return "\n".join(tail)

    def _pip(self, *args):
        return self._run([self.py, "-m", "pip", "install", "--retries", "10", "--timeout", "60", *args])

    # ---- checks
    def is_installed(self):
        if not (os.path.isfile(self.py) and os.path.isfile(self.marker)):
            return False
        try:
            with open(self.marker, encoding="utf-8") as fh:
                if json.load(fh).get("version") != MARKER_VERSION:
                    return False
            r = subprocess.run([self.py, "-c", CHECK], capture_output=True, text=True, timeout=180)
        except (OSError, ValueError, subprocess.SubprocessError):
            return False
        if r.returncode != 0:
            return False
        self.info = self._parse_check(r.stdout)
        return True

    @staticmethod
    def _parse_check(out):
        parts = out.split()
        return dict(torch=parts[0], gpu=parts[1] == "True") if len(parts) >= 2 else {}

    # ---- the install
    def start(self):
        """Check, and install if needed, in the background. Does nothing while already working."""
        with self.lock:
            if self.thread is not None and self.thread.is_alive():
                return
            self.status, self.error, self.step = "checking", None, 0
            self.thread = threading.Thread(target=self._main, daemon=True)
            self.thread.start()

    def _main(self):
        try:
            if self.is_installed():
                self._set(status="ready", step=len(self.steps))
                return
            self._set(status="installing", step=1)
            self._install()
            self._set(status="ready", step=len(self.steps))
        except Exception as e:
            self._say(f"FAILED: {e}")
            self._set(status="error", error=str(e))

    def _install(self):
        ver = sys.version_info[:2]
        if not SUPPORTED[0] <= ver <= SUPPORTED[1]:
            raise RuntimeError(f"Python {ver[0]}.{ver[1]} is not supported by PyTorch yet (need 3.10 to 3.14). "
                               "Close this window and start DeepDreamer.bat again; it will install a suitable Python.")
        if not sys.maxsize > 2**32:
            raise RuntimeError("This is a 32-bit Python. DeepDreamer needs 64-bit Windows and 64-bit Python.")
        # 1. environment (an old or half-built one is rebuilt, not repaired: nothing in it is precious)
        self._set(step=1)
        cfg = os.path.join(self.venv, "pyvenv.cfg")
        if os.path.isfile(self.py) and os.path.isfile(cfg):
            try:
                subprocess.run([self.py, "-c", "pass"], check=True, capture_output=True, timeout=60)
                broken = False
            except (OSError, subprocess.SubprocessError):
                broken = True
        else:
            broken = os.path.exists(self.venv)
        if broken:
            self._say("The existing environment is broken - rebuilding it.")
            shutil.rmtree(self.venv, ignore_errors=True)
        if not os.path.isfile(self.py):
            self._run([sys.executable, "-m", "venv", self.venv])
        self._run([self.py, "-m", "pip", "install", "--upgrade", "pip"])
        # 2. PyTorch
        self._set(step=2)
        index, label, warning = pick_torch_index()
        self._set(warning=warning, info=dict(build=label))
        self._say(f"PyTorch build: {label}")
        self._pip("torch", "torchvision", "--index-url", index)
        # 3. the rest
        self._set(step=3)
        self._pip(*PACKAGES)
        # 4. network weights
        self._set(step=4)
        self._run([self.py, "-c", WEIGHTS])
        # 5. check
        self._set(step=5)
        out = self._run([self.py, "-c", CHECK]).splitlines()[-1]
        info = self._parse_check(out)
        if not info:
            raise RuntimeError("The final check printed nothing useful: " + out)
        if warning is None and label != "CPU" and not info["gpu"]:
            self._set(warning="PyTorch is installed but cannot see the GPU. Update the NVIDIA driver and restart your "
                              "computer; until then DeepDreamer runs on the CPU, which is very slow.")
        os.makedirs(self.venv, exist_ok=True)
        with open(self.marker, "w", encoding="utf-8") as fh:
            json.dump(dict(version=MARKER_VERSION, build=label, torch=info["torch"], time=time.time()), fh)
        self._set(info=dict(build=label, **info))
        self._say("All done.")
