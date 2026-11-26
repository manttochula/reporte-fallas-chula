@echo off
cd /d "%~dp0"
echo Revisando las ventanas de Excel/CONTPAQi (deja abierta la ventana que quieres revisar)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnosticar_ventanas.ps1"
echo.
echo Listo. Se guardo en logs\diagnostico_ventanas.txt
pause
