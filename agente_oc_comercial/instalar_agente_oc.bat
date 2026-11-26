@echo off
net session >nul 2>&1
if errorlevel 1 (
  echo Pidiendo permiso de administrador ^(Comercial corre como administrador^)...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
echo Instalando el agente de OC para CONTPAQi Comercial...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar_agente_oc.ps1"
echo.
pause
