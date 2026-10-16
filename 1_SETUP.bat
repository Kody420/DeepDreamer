@echo off
setlocal
cd /d "%~dp0"
echo ==== DeepDreamer setup (run once) ====
set PY=
where py >nul 2>nul && set PY=py -3
if "%PY%"=="" (where python >nul 2>nul && set PY=python)
if "%PY%"=="" (
  echo Python 3.10-3.12 not found. Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^), then run this again.
  pause & exit /b 1
)
%PY% -m venv venv || (echo Could not create venv & pause & exit /b 1)
call venv\Scripts\activate.bat
python -m pip install --upgrade pip
where nvidia-smi >nul 2>nul
if %errorlevel%==0 (
  echo NVIDIA GPU detected - installing CUDA build of PyTorch ...
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128|| goto :fail
) else (
  echo No NVIDIA GPU found - installing CPU build. Rendering will be slow.
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu || goto :fail
)
pip install numpy pillow imageio-ffmpeg open_clip_torch gdown || goto :fail
echo Downloading the VGG16 network weights ^(about 500 MB, one time^) ...
python -c "import torchvision; torchvision.models.vgg16(weights=torchvision.models.VGG16_Weights.IMAGENET1K_V1); print('weights OK')" || goto :fail
python -c "import torch; print('CUDA available:', torch.cuda.is_available())"
echo.
echo Setup done. Next: 2_PREVIEW.bat
pause
exit /b 0
:fail
echo Setup failed - see the messages above.
pause
exit /b 1
