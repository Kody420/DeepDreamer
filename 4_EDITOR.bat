@echo off
cd /d "%~dp0"
if not exist venv\Scripts\python.exe (echo Run 1_SETUP.bat first. & pause & exit /b 1)
echo Starting the DeepDreamer editor in your browser.
echo Keep this window open while you use it - closing it stops the editor and any running render.
venv\Scripts\python.exe editor\server.py
pause
