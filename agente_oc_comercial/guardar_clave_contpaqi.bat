@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0guardar_clave_contpaqi.ps1"
echo.
pause
