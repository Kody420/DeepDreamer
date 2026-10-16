@echo off
cd /d "%~dp0"
if not exist venv\Scripts\activate.bat (echo Run 1_SETUP.bat first. & pause & exit /b 1)
call venv\Scripts\activate.bat
echo Rendering with settings.ini ^(safe to close and re-run - it resumes^)
python dream.py
if errorlevel 1 (echo. & echo Render did not finish - run 3_RENDER.bat again to resume. & pause & exit /b 1)
echo.
rem finished: number the video + settings in output\ and clear the work files so the next render starts fresh
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content -LiteralPath '%~f0' -Raw) -split '#POWERSHELL#')[-1]"
rmdir /s /q work 2>nul
echo Done. Change "seed" in settings.ini for a different video, then run 3_RENDER.bat again.
pause
exit /b

#POWERSHELL#
# Renames the finished render (settings.ini [render] output, in the output folder) to NN-dream_<height>p<fps>.mp4,
# where NN is one more than the highest number already used by NN-*.mp4 files in the output folder.
$out = 'output'
$cfg = @{}; $section = ''
foreach ($line in Get-Content 'settings.ini') {
    $l = ($line -replace '\s[;#].*$', '').Trim()
    if ($l -match '^\[(.+)\]$') { $section = $Matches[1]; continue }
    if ($section -eq 'render' -and $l -match '^(\w+)\s*=\s*(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}
$src = if ($cfg['output']) { Join-Path $out $cfg['output'] }
if (-not $src -or -not (Test-Path -LiteralPath $src)) { Write-Host "No finished video ($src) to rename."; exit 0 }

# resolution from the video itself (settings.ini may have been edited since), settings.ini as fallback
$h = $cfg['height']; $fps = $cfg['fps']
try {
    $ff = & 'venv\Scripts\python.exe' -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())" 2>$null
    $info = (& $ff -hide_banner -i $src 2>&1 | Out-String)
    if ($info -match 'Video:.*?, \d+x(\d+)[ ,].*?([\d.]+) fps') { $h = $Matches[1]; $fps = [math]::Round([double]$Matches[2]) }
} catch {}

$max = 0
foreach ($f in Get-ChildItem -LiteralPath $out -Filter '*.mp4') {
    if ($f.Name -match '^(\d+)-' -and [int]$Matches[1] -gt $max) { $max = [int]$Matches[1] }
}
$name = '{0}-dream_{1}p{2}.mp4' -f ($max + 1), $h, $fps
Rename-Item -LiteralPath $src -NewName $name
Write-Host "Saved video as $out\$name"

# settings backup written by dream.py next to the video gets the same number
$ini = Join-Path $out ([IO.Path]::GetFileNameWithoutExtension($src) + '_settings.ini')
if (Test-Path -LiteralPath $ini) {
    $iniName = [IO.Path]::GetFileNameWithoutExtension($name) + '_settings.ini'
    Rename-Item -LiteralPath $ini -NewName $iniName
    Write-Host "Saved settings as $out\$iniName"
}
