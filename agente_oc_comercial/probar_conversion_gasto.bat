@echo off
net session >nul 2>&1
if errorlevel 1 (
  echo Pidiendo permiso de administrador ^(Comercial corre como administrador^)...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
echo PRUEBA de conversion OC -^> GASTOS EN PESOS ^(OC GENERALES^) o COMPRA EN PESOS ^(OC VRZ^) en Comercial.
echo Si Comercial esta cerrado, lo abre y entra solo con tu usuario.
echo Si tiene documentos abiertos, lo cierra (guarda antes lo tuyo).
echo Te va a preguntar antes de cada paso importante: abrir/cerrar
echo Comercial, abrir la empresa, ACEPTAR la conversion y GUARDAR el documento.
echo Entre pregunta y pregunta no uses el mouse ni el teclado.
echo.
pause
set AGENTE_OC_DETALLE=1
set AGENTE_GASTO_PROBAR=1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agente_oc_comercial.ps1"
echo.
echo Ultimas lineas del registro:
powershell -NoProfile -Command "Get-ChildItem \"%~dp0logs\agente_*.log\" | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Tail 20"
echo.
pause
