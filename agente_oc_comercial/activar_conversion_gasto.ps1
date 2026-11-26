# Prende o apaga la conversión AUTOMÁTICA de OC de gastos a GASTOS EN PESOS (nov-2026).
# Con esto prendido, cada vuelta del agente convierte las OC con factura cuando
# nadie ha usado la PC en 10 minutos y Comercial está listo (empresa abierta,
# lista de ORDEN DE COMPRA GENERALES abierta, sin otros documentos abiertos).
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $Dir 'agente_oc_config.json'
if (-not (Test-Path $cfgPath)) { throw 'Falta agente_oc_config.json: primero corre instalar_agente_oc.bat.' }
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$actual = [bool]$cfg.conversionGastoAuto
Write-Host ''
Write-Host '=== Conversión automática OC -> GASTOS EN PESOS ===' -ForegroundColor Cyan
Write-Host ('Ahora está: ' + $(if ($actual) { 'PRENDIDA' } else { 'APAGADA' }))
$r = Read-Host 'Escribe S para prenderla, N para apagarla [Enter = no cambiar]'
if ($r -match '^[sS]') { $actual = $true } elseif ($r -match '^[nN]') { $actual = $false }
$cfg | Add-Member -NotePropertyName conversionGastoAuto -NotePropertyValue $actual -Force
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath -Encoding UTF8
Write-Host ('LISTO: la conversión automática quedó ' + $(if ($actual) { 'PRENDIDA' } else { 'APAGADA' }) + '.') -ForegroundColor Green
