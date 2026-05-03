@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [Glass] Node.js is not installed or not on PATH.
    echo Install it from https://nodejs.org/ and run this again.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [Glass] First run - installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [Glass] npm install failed.
        pause
        exit /b 1
    )
)

rem Hand off to a hidden wscript launcher so this console window can close
rem the moment Electron starts up. No more lingering cmd window.
wscript //nologo "%~dp0_launch.vbs"
endlocal
exit /b
