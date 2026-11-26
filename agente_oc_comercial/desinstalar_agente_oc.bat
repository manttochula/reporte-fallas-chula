@echo off
powershell -NoProfile -Command "Unregister-ScheduledTask -TaskName 'Chula - Agente OC Comercial' -Confirm:$false"
echo Agente desinstalado (ya no correra solo). Tus archivos se quedan en esta carpeta.
pause
