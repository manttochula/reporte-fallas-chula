@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0activar_conversion_gasto.ps1"
echo.
pause
