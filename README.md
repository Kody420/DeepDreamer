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
| `feed.py`, `editor/feed.js` | The feed stack (new material for the dream each frame) and the editor's Feed tab |
| `video_motion.py` | Extracts a clip's motion (optical flow or codec vectors) for the Video motion module |
| `attngan/generate.py` | AttnGAN text-to-image, ported to current PyTorch |
| `attngan/setup_files.py` | Downloads the AttnGAN files and converts them to safe formats |
| `1_SETUP.bat` … `4_EDITOR.bat` | Setup, preview, render and editor launchers |
| `README.txt` | Short usage notes and tuning tips |

Created when you use it, and not tracked by git: `venv/`, `output/` (your videos), `work/` and `work_preview/`
(render chunks), `preview.mp4`, `init_images/` (start images picked in the editor), `clips/` and `video_motion/`
(clips for the Video motion module and their extracted motion) and the AttnGAN weights.

## Tuning in brief

| To get… | Change |
|---|---|
| Shapes that hold longer before morphing | a slower Zoom module in the Motion tab (each shape lasts about 0.7 ÷ zoom speed seconds) |
| Bigger shapes | smaller `scales`, e.g. `0.12,0.2,0.3` |
| Animals and objects instead of eyes | `object_bias` 0.8–1 |
| A faster start and a busier picture | higher `strength` |
| A different video with the same look | a different `seed` |
| A video that keeps changing what it shows | a Feed stack the network can see, and Taste drift or Boredom under Variety |

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
- An empty stack keeps the picture still: no motion at all.
- Settings files from before the motion stack have no `[warp]` section. Their `zoom_rate` is read as a Zoom
  module and their `rotate_rate` as a Spin module wobbling on a sine, so older settings and videos still move
  the same way (minus the old warp's tiny drift). Recipes that set `zoom_rate` or `rotate_rate` now change the
  stack's Zoom and Spin.

### Video motion

The **Video motion** module makes the dream move the way a clip you choose moves. Pick or drop a clip on its
card (it is copied to `clips\`), then press **Extract motion**. The motion is worked out once and cached in
`video_motion\`; a render extracts it itself if you skipped that.

```ini
video.clip = C:\...\clips\drive.mp4
video.source = flow            ; flow: smooth optical flow (RAFT) / codec: the clip's own H.264/H.265 motion vectors
video.loop = loop              ; loop, pingpong (plays back and forth) or hold (keeps the last frame's motion)
video.gaps = hold              ; codec only: blocks without a past vector keep the previous motion, or zero
video.amp = 1                  ; strength
video.speed = 1                ; clip speed (2 plays it twice as fast, and so moves twice as fast)
video.smooth = 0.3             ; blur of the motion field
video.offset = 0               ; where in the clip to start, 0 to 1
```

- **Optical flow** follows everything that moves, smoothly. On this CPU-only PyTorch it takes about half a second
  per clip frame (clips are cut at 30 s).
- **Codec vectors** read the motion the encoder stored. They are blocky and glitchy, like datamoshing, and take
  no time to extract. B-frames mostly point to the future and leave gaps; **hold** keeps the motion going there.
- The clip is cropped to the video's shape the way start images are. Camera footage often moves much more per
  frame than a zoom; if the Motion check warns, lower the strength.
- The editor's preview can show the clip's own first frame (**Picture: Clip**) to check that the motion follows it.

## Feed stack

Every frame the motion moves the picture and the network repaints it. The editor's **Feed** tab adds new
material in between, for the dream to grow into something else. It is saved as a `[feed]` section and works
like the motion stack: modules run top to bottom, values can follow curves, and a module can be limited to a
disc around its pivot (`near`), everything outside it (`away`), or the parts the dream has stopped changing
(`idle`).

```ini
[feed]
stack = grain, seeds, reseed
grain.amount = 0.006 ~ pulse(period=6, depth=0.15)
grain.grid = matched           ; matched: drawn at the painting sizes / pixel: one value per pixel / size: grain.size
grain.life = 1.5               ; seconds each pattern lives (0 = new every frame)
grain.lock = world             ; world: carried along by the motion, so it grows with the thing it landed on
grain.where = near 0.45 soft 0.6
seeds.rate = 3                 ; dots, rings and eyes per second
reseed.every = 8               ; seconds between fresh discs of noise at the pivot
```

| Module | What it adds |
|---|---|
| Grain | Random values. Drawn at the painting sizes, the network receives almost all of it |
| Colour patches | Large, slow patches of colour that leave brightness alone |
| Marble | Domain-warped fractal noise: veins, folds and contours |
| Turing patterns | A small reaction–diffusion simulation: spots that split, worms or mazes |
| Seeds | Dots, rings and dot-in-ring eyes dropped at a set rate |
| Mirror | Pulls the picture toward its own mirror image across a line through the pivot |
| Reseed | Every few seconds, fresh noise in a soft disc at the pivot, like the video's start |
| Pictures | Every few seconds, one of your pictures (`init_images\` by default) dissolved into a soft disc |

- **Why it matters:** the network looks at a shrunken copy of the frame (`scales`). The old `noise` was one
  random value per pixel, and shrinking averages that away: at scale 0.12 only about 8% of it reaches the
  network. Grain drawn at the painting sizes arrives almost whole. The render log prints how much of each
  Grain module gets through.
- Amounts are per frame at 30 fps and scaled for 60 fps. Fields that are held for a while (Grain with a life,
  Colour, Marble, Turing) are added again every frame, so keep them small: 0.004–0.01.
- `near` and `away` keep the same total amount and concentrate it. With a centred zoom, things born near the
  centre stay on screen longest and grow the most.
- The preview shows what the feed adds, what the network gets of it after the shrink (**Seen by the
  network**), and where. It has no motion and no network; judge the material, not the result.
- Settings files from before the feed stack have no `[feed]` section. Their `noise` is read as a Grain module
  with one fresh value per pixel, which is what the old noise was. An empty stack adds nothing.

## Variety

Four settings in the Editor tab's **Variety** group change what the network looks for as the video goes on.
At 0 the dream is exactly as before.

| Setting | What it does |
|---|---|
| `channel_drift` (Taste drift), `channel_period` | Each feature detector gets a slowly wandering weight, so the network favours fur and snouts for a while, then pagodas or jellyfish |
| `novelty` (Boredom) | Turns down the detectors that have carried the picture for the last few seconds, so something else takes over |
| `layer_walk` (Layer wander) | Wanders between the five layers at random instead of cycling. `object_bias` then tilts the wander instead of fixing it |
| `jitter` | Shifts the picture by up to this many network pixels before each look, as the original DeepDream did |

Renders save this state, and the feed's, with each chunk, so an interrupted render continues the same way.

## Credits

- DeepDream: Mordvintsev, Olah and Tyka, Google, 2015
- VGG16 and GoogLeNet ImageNet weights from torchvision
- CLIP: OpenAI, 2021, loaded through [open_clip](https://github.com/mlfoundations/open_clip)
- AttnGAN: Xu et al., CVPR 2018, [taoxugit/AttnGAN](https://github.com/taoxugit/AttnGAN) (MIT licence).
  The network code in `attngan/generate.py` is adapted from it.
