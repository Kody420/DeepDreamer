@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title DeepDreamer
set PYTHONIOENCODING=utf-8
set "PYEXE="

rem ---- 1. find a Python that PyTorch supports (3.10 - 3.14, 64-bit) -------------------------------------
if exist "%~dp0python\python.exe" call :try "%~dp0python\python.exe"
if not defined PYEXE where py >nul 2>nul && call :launcher
if not defined PYEXE for /f "delims=" %%P in ('where python 2^>nul') do call :trypath "%%P"

rem ---- 2. none found: install Python 3.12 into the DeepDreamer folder (no administrator rights needed) ---
if not defined PYEXE (
  echo No suitable Python found. Installing Python 3.12 for DeepDreamer ^(about 25 MB^) ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; $f=Join-Path $env:TEMP 'deepdreamer-python-setup.exe'; Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' -OutFile $f; $s=Get-AuthenticodeSignature $f; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Python Software Foundation') { Remove-Item $f; throw 'The Python installer failed its signature check.' }"
  if errorlevel 1 goto :nopython
  start /wait "" "%TEMP%\deepdreamer-python-setup.exe" /quiet InstallAllUsers=0 "TargetDir=%~dp0python" Include_launcher=0 Include_test=0 Include_doc=0 Include_pip=1 PrependPath=0 Shortcuts=0 AssociateFiles=0
  del "%TEMP%\deepdreamer-python-setup.exe" >nul 2>nul
  call :try "%~dp0python\python.exe"
)
if not defined PYEXE goto :nopython

rem ---- 3. start the editor: it opens in your browser and installs everything else there ----------------
echo Starting DeepDreamer. Keep this window open while you use it - closing it stops the editor and any render.
"%PYEXE%" "%~dp0editor\server.py" %*
if errorlevel 1 pause
exit /b

:nopython
echo.
echo Could not find or install Python 3.10 - 3.14 ^(64-bit^). Install it from https://www.python.org/downloads/
echo and start DeepDreamer.bat again.
pause
exit /b 1

:launcher
for %%V in (3.12 3.13 3.11 3.14 3.10) do if not defined PYEXE for /f "delims=" %%P in ('py -%%V -c "import sys;print(sys.executable)" 2^>nul') do call :try "%%P"
exit /b

:trypath
rem skip the Microsoft Store placeholder "python.exe" (it opens the Store instead of running Python)
set "cand=%~1"
if /i not "%cand:WindowsApps=%"=="%cand%" exit /b
call :try "%~1"
exit /b

:try
if defined PYEXE exit /b
"%~1" -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,14) and sys.maxsize > 2**32 else 1)" >nul 2>nul
if not errorlevel 1 set "PYEXE=%~1"
exit /b
