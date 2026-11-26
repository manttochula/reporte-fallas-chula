@echo off
cd /d "%~dp0"
echo Corriendo UNA vuelta del agente (puede tardar 1-2 minutos si hay OC)...
set AGENTE_OC_DETALLE=1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agente_oc_comercial.ps1"
echo.
echo Ultimas lineas del registro:
powershell -NoProfile -Command "Get-ChildItem \"%~dp0logs\agente_*.log\" | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Tail 20"
echo.
pause
