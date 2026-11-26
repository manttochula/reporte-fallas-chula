@echo off
net session >nul 2>&1
if errorlevel 1 (
  echo Pidiendo permiso de administrador ^(Comercial corre como administrador^)...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0grabar_ventanas_comercial.ps1"
echo.
pause
