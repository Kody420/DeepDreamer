# DeepDreamer

Endless "falling into the picture" videos made with DeepDream, the 2015 technique that makes a trained
image-recognition network exaggerate whatever it sees until eyes, animals and objects grow out of noise.
DeepDreamer zooms into the image frame after frame and keeps dreaming, so new shapes keep forming and morphing.

It runs locally on Windows with an NVIDIA GPU. It is controlled through `settings.ini`, or through an editor
that runs in your browser.

## What it can do

- **Dream videos** at any resolution and frame rate, with VGG16 or GoogLeNet (the original DeepDream network)
  doing the dreaming. Zoom, swirl, colour cycling, strength, painting size and the kind of things that appear
  (eyes and spirals, birds, objects, animals) are all adjustable.
- **Motion stack**: instead of a plain zoom, stack up to 8 motions (zoom, spin, drift, tilt, handheld shake,
  swirl, bulge, Möbius bend, kaleidoscope, ripple, liquid currents, melt, contour flow). Any setting can follow a
  curve over the video, and a live preview shows the deformation before you render.
- **Prompts**: steer the dream toward a sentence with OpenAI CLIP RN50 (2021), or toward ImageNet object names
  such as "volcano, castle".
- **Start images**: begin the dream from your own photo instead of noise.
- **Text to image**: AttnGAN (2018) draws a bird or a rough everyday scene from a sentence. It shows its
  64 → 128 → 256 px stages and which word drew which part. Any result can be used as a start image.
- **Browser editor**: sliders with explanations, recipes, a "what to expect" readout with warnings, preview
  and render buttons with progress, a live view of the frame being dreamed, and a gallery of your videos
  that can load the settings each one used.
- **Long renders** are saved in chunks, so an interrupted render resumes where it stopped. Finished videos are
  numbered (`output\NN-dream_1080p30.mp4`) and saved next to a copy of the settings that made them.

## Requirements

- Windows with an NVIDIA GPU (tested on an RTX 5070 Ti; the CPU fallback is very slow)
- Python 3.10–3.12
- About 4 GB of disk space for PyTorch and the network weights

## Getting started

1. Double-click **`1_SETUP.bat`** once. It creates `venv\` and installs PyTorch (CUDA 12.8 build), CLIP and
   the other packages, then downloads the VGG16 weights.
2. Double-click **`4_EDITOR.bat`**. The editor opens in your browser. Pick a recipe, press **Save & preview**,
   then **Save & render** when you like it.

Without the editor: edit `settings.ini`, run `2_PREVIEW.bat` for a short test, then `3_RENDER.bat`.

For the Text to image tab, run this once to download and prepare AttnGAN (about 315 MB):

```bash
venv\Scripts\python.exe attngan\setup_files.py
```

## What's in the repository

| Path | What it is |
|---|---|
| `dream.py` | The renderer: networks, the per-frame dream step, video writing, resuming |
| `prompts.py` | Prompt guidance (CLIP and ImageNet classes) |
| `settings.ini` | All render settings, each with a comment explaining it |
| `editor/server.py`, `editor/index.html` | The browser editor: a small local web server (Python standard library only) and the page |
| `editor/warp.js`, `editor/warp.css` | The editor's Motion tab: the motion stack and its live WebGL preview |
| `attngan/generate.py` | AttnGAN text-to-image, ported to current PyTorch |
| `attngan/setup_files.py` | Downloads the AttnGAN files and converts them to safe formats |
| `1_SETUP.bat` … `4_EDITOR.bat` | Setup, preview, render and editor launchers |
| `README.txt` | Short usage notes and tuning tips |

Created when you use it, and not tracked by git: `venv/`, `output/` (your videos), `work/` and `work_preview/`
(render chunks), `preview.mp4`, `init_images/` (start images picked in the editor) and the AttnGAN weights.

## Tuning in brief

| To get… | Change |
|---|---|
| Shapes that hold longer before morphing | lower `zoom_rate` (each shape lasts about 0.7 ÷ zoom_rate seconds) |
| Bigger shapes | smaller `scales`, e.g. `0.12,0.2,0.3` |
| Animals and objects instead of eyes | `object_bias` 0.8–1 |
| A faster start and a busier picture | higher `strength` |
| A different video with the same look | a different `seed` |

The editor explains every setting and warns about combinations that look bad.

## Motion stack

The editor's **Motion** tab replaces the single zoom with a stack of motion modules, saved as a `[warp]`
section in `settings.ini`. Modules run top to bottom and only move the sampling grid, so a frame is still
resampled once, however many there are. Rates are per second, so 30 and 60 fps move the same.

```ini
[warp]
stack = zoom, swirl, melt
edge = reflect                 ; reflect, wrap or smear: what fills the frame where motion pulls in the outside
prism = 0                      ; red and blue zoom slightly apart for rainbow trails
zoom.rate = 0.25 ~ sine(period=12, depth=0.3)   ; a value can follow a curve: sine, tri, saw, pulse, noise, ramp
swirl.rate = 1.2
swirl.pivot = 0.59, 0.33       ; centre, in frame heights from the middle (y up)
swirl.where = near 0.6 soft 0.4
melt.on = no                   ; kept, but switched off
```

- The preview runs only the motion, on a stand-in picture (or the frame on the monitor), at 30 fps. Its Grid,
  Flow and Stress views and the Motion check show where the motion stretches or tears the picture.
- **Random warp** (R) builds a new stack that stays inside the Motion check's limits; **Re-roll settings**
  (Shift+R) keeps the modules and draws new values.
- Without a `[warp]` section, `dream.py` uses the classic `zoom_rate` and `rotate_rate` motion exactly as
  before, so older settings files and videos render the same. **Back to classic motion** removes the section.

## Credits

- DeepDream: Mordvintsev, Olah and Tyka, Google, 2015
- VGG16 and GoogLeNet ImageNet weights from torchvision
- CLIP: OpenAI, 2021, loaded through [open_clip](https://github.com/mlfoundations/open_clip)
- AttnGAN: Xu et al., CVPR 2018, [taoxugit/AttnGAN](https://github.com/taoxugit/AttnGAN) (MIT licence).
  The network code in `attngan/generate.py` is adapted from it.
