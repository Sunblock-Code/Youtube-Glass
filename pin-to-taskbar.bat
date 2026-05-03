@echo off
setlocal
cd /d "%~dp0"

rem Creates a Glass.lnk shortcut on your Desktop that points at the silent
rem launcher (so no cmd window appears) and embeds the Glass icon. Pinning
rem THIS shortcut to the taskbar will keep the custom icon — pinning the
rem running app directly shows Electron's default icon because that's what
rem is actually running under the hood (`electron.exe`).

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$sc = $ws.CreateShortcut($desktop + '\Glass.lnk');" ^
  "$sc.TargetPath = 'wscript.exe';" ^
  "$sc.Arguments = '\"%CD%\_launch.vbs\"';" ^
  "$sc.IconLocation = '%CD%\assets\icon.ico,0';" ^
  "$sc.WorkingDirectory = '%CD%';" ^
  "$sc.Description = 'Glass — Glassmorphic YouTube';" ^
  "$sc.WindowStyle = 7;" ^
  "$sc.Save()"

echo.
echo Created Glass.lnk on your Desktop with the custom icon.
echo Right-click it and choose "Pin to taskbar" — the icon will stick.
echo.
pause
endlocal
