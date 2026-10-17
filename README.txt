DeepDreamer - infinite DeepDream "fall" video with a real neural net (VGG16)

1. Double-click 1_SETUP.bat  (once; downloads PyTorch + weights, ~3 GB, needs Python 3.10-3.12)
2. Double-click 2_PREVIEW.bat  -> 10 s test at 960x540 -> preview.mp4
3. Edit settings.ini (resolution, fps, length, wildness...), then double-click 3_RENDER.bat
   Default is 1920x1080 @ 60 fps -> output\NN-dream_1080p60.mp4, numbered 1, 2, 3...
   (+ output\NN-dream_1080p60_settings.ini, a copy of the settings used)
   When it finishes, the work files are cleared so the next render starts fresh.
4. Or double-click 4_EDITOR.bat for the editor in your browser: sliders with explanations,
   recipes, a live "what to expect" readout and warnings, Save & preview / Save & render
   buttons with progress, and all your videos (play them, load the settings they used).
   Keep its window open while you use it; closing it stops the editor and any running render.

Prompts
- prompt = any text steers the dream toward it (prompt_mode = clip, uses OpenAI CLIP RN50 from 2021),
  or prompt_mode = imagenet with object names like "volcano, castle" (the dreaming network's own classifier).
  prompt_weight 0.8-0.95 for clearly visible results. Rendering is ~3-4x slower with a prompt.
- While a preview or render runs, the editor shows the frame being dreamed live.
- Text to image tab: AttnGAN (2018, github.com/taoxugit/AttnGAN, MIT). "birds" draws birds from a
  description; "coco" tries everyday scenes (rough). Shows the 64 -> 128 -> 256 px stages and which word
  drew which part. Any result can be used as the start image of a video.
  First time only: venv\Scripts\python.exe attngan\setup_files.py  (downloads ~315 MB and prepares
  the networks). attngan\downloads is only needed for that step and can be deleted afterwards.

Notes
- Needs an NVIDIA GPU for sensible speed. Run the preview first and look at the
  elapsed time to estimate the full render (time scales with frames x pixels).
- Out of GPU memory? Use 1280x720 in settings.ini, or set scales = 0.4,0.7
- Interrupted? Just run 3_RENDER.bat again, it resumes from the last finished 30 s segment.
- For a different video: change "seed" and run 3_RENDER.bat again.
- Wilder / more objects: raise "strength", add scales < 0.4 (e.g. 0.25,0.4,0.7,1.0).
  More stable: lower "strength".
- Keeps showing the same kind of thing? Add a Feed stack (editor's Feed tab), or Taste drift / Boredom
  in the Editor tab's Variety group. The old "noise" setting barely reaches the network.
- More "things" (animals, objects) and fewer eyes: object_bias = 0.8 to 1.
- Low zoom_rate (e.g. 0.2) turning into tiny dense cells: use smaller scales
  (e.g. 0.15,0.25,0.4), sharpen = 0 and a lower strength (e.g. 1.5).
- Start from your own photo: set init_image = C:\path\to\photo.jpg
