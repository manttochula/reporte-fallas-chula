# Le da privilegios altos a la tarea "Chula - Agente OC Comercial" (nov-2026).
# Comercial corre como administrador; sin esto, Windows no deja que el agente
# escriba ni dé clic en sus ventanas (conversión a GASTOS EN PESOS).
# No cambia la clave del agente ni la configuración: solo el permiso de la tarea.
$ErrorActionPreference = 'Stop'
$nombre = 'Chula - Agente OC Comercial'
$t = Get-ScheduledTask -TaskName $nombre -ErrorAction SilentlyContinue
if (-not $t) { throw 'No encuentro la tarea programada: primero corre instalar_agente_oc.bat.' }
$quien = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
Set-ScheduledTask -TaskName $nombre -Principal $quien | Out-Null
$nivel = (Get-ScheduledTask -TaskName $nombre).Principal.RunLevel
Write-Host ''
if ($nivel -eq 'Highest') { Write-Host 'LISTO: la tarea del agente ya corre con privilegios de administrador.' -ForegroundColor Green }
else { Write-Host ('Ojo: la tarea quedó con nivel ' + $nivel + '.') -ForegroundColor Yellow }
