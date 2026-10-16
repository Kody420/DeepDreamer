@echo off
cd /d "%~dp0"
if not exist venv\Scripts\activate.bat (echo Run 1_SETUP.bat first. & pause & exit /b 1)
call venv\Scripts\activate.bat
rmdir /s /q work_preview 2>nul
python dream.py --preview
echo.
echo Preview saved as preview.mp4
pause
