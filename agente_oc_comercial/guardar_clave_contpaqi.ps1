# Guarda el usuario y la clave de CONTPAQi Comercial para que el agente
# conteste solo la ventana "Ingreso a CONTPAQ i COMERCIAL" (oct-2026).
# La clave queda cifrada con TU usuario de Windows (DPAPI): solo este
# usuario en esta PC la puede leer. No se guarda en texto ni se manda a
# ningún lado.
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $Dir 'agente_oc_config.json'
if (-not (Test-Path $cfgPath)) { throw 'Falta agente_oc_config.json: primero corre instalar_agente_oc.bat.' }
Write-Host ''
Write-Host '=== Usuario y clave de CONTPAQi Comercial para el agente ===' -ForegroundColor Cyan
Write-Host 'Son los mismos que escribes en la ventana "Ingreso a CONTPAQ i COMERCIAL" al abrir HojaComercial.'
Write-Host ''
$usuario = Read-Host 'Código del usuario [Enter = SUPERVISOR]'
if (-not $usuario) { $usuario = 'SUPERVISOR' }
$sec = Read-Host 'Clave de acceso (no se ve mientras la escribes)' -AsSecureString
$sec2 = Read-Host 'Escríbela otra vez para confirmar' -AsSecureString
$a = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$b = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec2))
if ($a -ne $b) { throw 'Las dos claves no coinciden. Vuelve a correrlo.' }
if (-not $a) { throw 'La clave está vacía.' }
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg | Add-Member -NotePropertyName contpaqiUsuario -NotePropertyValue $usuario.Trim() -Force
$cfg | Add-Member -NotePropertyName contpaqiClaveCifrada -NotePropertyValue (ConvertFrom-SecureString $sec) -Force
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath -Encoding UTF8
Write-Host ''
Write-Host ('LISTO. Guardado para el usuario ' + $usuario.Trim() + '. Ya puedes correr probar_agente_oc.bat.') -ForegroundColor Green
