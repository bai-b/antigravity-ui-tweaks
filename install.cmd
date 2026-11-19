@echo off
setlocal
rem Double-click entry for the release package: installs the copy that ships
rem next to this file, no download and no Python required.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (echo Done.) else (echo Installer exited with code %CODE%.)
pause
exit /b %CODE%
