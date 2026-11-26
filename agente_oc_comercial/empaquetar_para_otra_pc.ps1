# Arma un ZIP con el agente para instalarlo en OTRA PC (nov-2026). NO incluye la
# configuración de esta PC (claves cifradas, rutas) ni los registros.
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp = Join-Path $env:TEMP ('agente_oc_comercial_' + (Get-Date -Format 'yyyyMMddHHmmss'))
$dest = Join-Path $tmp 'agente_oc_comercial'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem -LiteralPath $Dir -File | Where-Object { $_.Name -ne 'agente_oc_config.json' -and $_.Extension -in '.ps1', '.bat', '.txt' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $dest }
$zip = Join-Path ([Environment]::GetFolderPath('Desktop')) 'agente_oc_comercial_para_otra_pc.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path $dest -DestinationPath $zip
Remove-Item -LiteralPath $tmp -Recurse -Force
Write-Host ''
Write-Host ('LISTO: ' + $zip) -ForegroundColor Green
Write-Host 'Pásalo a la otra PC (USB, correo, carpeta compartida) y sigue LEEME_OTRA_PC.txt.'
