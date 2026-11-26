# Instala el agente de carga automática de OC a CONTPAQi Comercial (oct-2026).
# Lo corre instalar_agente_oc.bat. No guarda ninguna clave en texto: la clave
# del agente queda cifrada con tu usuario de Windows (DPAPI).
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Si algo falla, el mensaje se queda en pantalla y en logs\instalacion.txt (nov-2026: en otra PC
# la ventana se cerró y no se supo por qué).
trap {
  $msg = $_.Exception.Message
  Write-Host ''
  Write-Host ('NO SE PUDO INSTALAR: ' + $msg) -ForegroundColor Red
  try { New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'logs') | Out-Null; Add-Content -Path (Join-Path $Dir 'logs\instalacion.txt') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg) -Encoding UTF8 } catch { }
  Write-Host 'Toma una captura de este mensaje. Luego da Enter para cerrar.' -ForegroundColor Yellow
  [void](Read-Host)
  exit 1
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host ''
Write-Host '=== Agente de OC para CONTPAQi Comercial ===' -ForegroundColor Cyan
Write-Host 'Instálalo en la PC donde está Comercial, con el usuario de Windows que usa Comercial.'
Write-Host ''

$api = Read-Host 'Dirección del sistema [Enter = https://reporte-fallas-chula.onrender.com]'
if (-not $api) { $api = 'https://reporte-fallas-chula.onrender.com' }

$hoja = Join-Path $env:USERPROFILE 'Desktop\Mantenimientos\rev\PARA ENLACE COMERCIAL\HojaComercial.xls'
if (-not (Test-Path $hoja)) {
  Write-Host 'Buscando HojaComercial.xls en esta PC...'
  $lugares = @((Join-Path $env:USERPROFILE 'Desktop'), (Join-Path $env:USERPROFILE 'Documents'), (Join-Path $env:USERPROFILE 'OneDrive'), (Join-Path $env:USERPROFILE 'Downloads'), 'C:\Compac', $env:PUBLIC) | Where-Object { $_ -and (Test-Path $_) }
  $hoja = Get-ChildItem -Path $lugares -Filter 'HojaComercial*.xls*' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if ($hoja) { Write-Host "HojaComercial encontrada: $hoja" -ForegroundColor Green } else { Write-Host 'No encontré HojaComercial.xls sola.' -ForegroundColor Yellow }
while ($true) {
  $otra = Read-Host $(if ($hoja) { 'Ruta de HojaComercial.xls [Enter = la de arriba]' } else { 'Escribe la ruta completa de HojaComercial.xls (ej. C:\Users\...\HojaComercial.xls)' })
  if ($otra) { $hoja = $otra.Trim().Trim('"') }
  if ($hoja -and (Test-Path -LiteralPath $hoja)) { break }
  Write-Host 'No existe ese archivo. Tip: en el Explorador, Shift + clic derecho sobre HojaComercial.xls -> "Copiar como ruta" y pégala aquí con clic derecho.' -ForegroundColor Yellow
  $hoja = $null
}

Write-Host ''
Write-Host 'Pega la CLAVE DEL AGENTE: la que te dio el Panel al dar de alta ESTA PC'
Write-Host '(Exportar OC para CONTPAQi -> PCs con agente). En la PC principal es OC_AGENTE_TOKEN de Render.'
Write-Host 'Pégala con clic derecho (o Ctrl+V) y da Enter. Se ve mientras la pegas para que revises que quedó completa;'
Write-Host 'al terminar se borra de la pantalla y se guarda cifrada.'
# Visible (nov-2026): con la entrada oculta, en otra PC el pegado solo metía 1 carácter y no se veía por qué.
$token = ''
foreach ($intento in 1..3) {
  $token = ((Read-Host 'Clave del agente') -replace '\s', '')
  if ($token.Length -ge 16) { break }
  Write-Host ('Esa clave tiene ' + $token.Length + ' caracteres; la del Panel tiene 48. ¿Copiaste la clave en ESTA PC? Lo más fácil: abre el Panel en esta PC, "Nueva clave" en esta PC y cópiala.') -ForegroundColor Yellow
}
if ($token.Length -lt 16) { throw 'La clave es muy corta (mínimo 16 caracteres).' }
try { Clear-Host } catch { }
Write-Host ('Clave recibida (' + $token.Length + ' caracteres).')
$sec = ConvertTo-SecureString $token -AsPlainText -Force

Write-Host 'Probando la conexión...'
$body = [Text.Encoding]::UTF8.GetBytes((@{ args = @($token) } | ConvertTo-Json -Compress))
$r = Invoke-RestMethod -Uri ($api.TrimEnd('/') + '/api/agenteOcPing') -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 120
if (-not $r.success) { throw ('El sistema rechazó la clave: ' + $r.error) }
Write-Host ('Conexión correcta: esta es la "' + $r.agente + '"' + $(if ($r.usuarios -and @($r.usuarios).Count) { ' y atiende las compras de: ' + (@($r.usuarios) -join ', ') } else { ' (atiende todo lo que no tenga otra PC)' })) -ForegroundColor Green
Write-Host ('Empresas en el sistema: ' + (($r.empresas | ForEach-Object { $_.nombre }) -join '; '))

Write-Host ''
Write-Host 'Usuario y clave de CONTPAQi Comercial (los de la ventana "Ingreso a CONTPAQ i COMERCIAL" al abrir HojaComercial).'
$usuarioCq = Read-Host 'Código del usuario [Enter = SUPERVISOR]'
if (-not $usuarioCq) { $usuarioCq = 'SUPERVISOR' }
$secCq = Read-Host 'Clave de acceso de CONTPAQi (no se ve)' -AsSecureString

$cfg = [ordered]@{
  apiBase = $api
  hojaComercial = $hoja
  tokenCifrado = (ConvertFrom-SecureString $sec)
  contpaqiUsuario = $usuarioCq.Trim()
  contpaqiClaveCifrada = (ConvertFrom-SecureString $secCq)
  empresas = @{}
}
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $Dir 'agente_oc_config.json') -Encoding UTF8

$ps1 = Join-Path $Dir 'agente_oc_comercial.ps1'
# Tarea programada cada 5 minutos, con TU usuario y solo con la sesión
# abierta (Excel necesita el escritorio). Se usa Register-ScheduledTask
# (y no schtasks.exe) porque la ruta lleva espacios ("Carlos Contreras").
$accion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"') -WorkingDirectory $Dir
$disparo = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
# Con privilegios altos si se instala como administrador: Comercial corre como
# administrador y Windows no deja que un programa normal opere sus ventanas.
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$quien = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel $(if ($esAdmin) { 'Highest' } else { 'Limited' })
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'Chula - Agente OC Comercial' -Action $accion -Trigger $disparo -Principal $quien -Settings $ajustes -Force | Out-Null
if (-not (Get-ScheduledTask -TaskName 'Chula - Agente OC Comercial' -ErrorAction SilentlyContinue)) { throw 'No se pudo crear la tarea programada.' }
Write-Host ''
Write-Host 'LISTO. El agente revisará cada 5 minutos si hay OC por cargar (solo mientras tu sesión de Windows esté abierta).' -ForegroundColor Green
Write-Host 'Para probarlo ya: corre probar_agente_oc.bat. Para quitarlo: desinstalar_agente_oc.bat.'
