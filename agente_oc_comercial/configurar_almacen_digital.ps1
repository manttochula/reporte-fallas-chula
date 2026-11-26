# Carpeta del ALMACEN DIGITAL donde el agente guarda las facturas (oct-2026).
# Por omisión: Z:\ALMACEN DIGITAL. Si en esta PC es otra letra o una ruta de
# red (\\servidor\...), escríbela aquí.
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $Dir 'agente_oc_config.json'
if (-not (Test-Path $cfgPath)) { throw 'Falta agente_oc_config.json: primero corre instalar_agente_oc.bat.' }
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$actual = [string]$cfg.almacenDigital; if (-not $actual) { $actual = 'Z:\ALMACEN DIGITAL' }
Write-Host ''
Write-Host '=== Carpeta del ALMACEN DIGITAL para las facturas ===' -ForegroundColor Cyan
Write-Host ('Actual: ' + $actual)
$nueva = Read-Host 'Ruta de la carpeta ALMACEN DIGITAL [Enter = la actual]'
if ($nueva) { $actual = $nueva.Trim().Trim('"').TrimEnd('\') }
if (-not (Test-Path -LiteralPath $actual)) { throw ('No encuentro la carpeta ' + $actual + ' desde esta PC. Revisa que la unidad de red esté conectada.') }
$cfg | Add-Member -NotePropertyName almacenDigital -NotePropertyValue $actual -Force
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath -Encoding UTF8
# Revisa nivel por nivel y dice en cuál no coincide, mostrando los nombres entre [ ] (así
# se ven espacios de más). El agente de todos modos usa la carpeta existente equivalente.
Write-Host ''
$ruta = $actual
foreach ($parte in @('CHULA BRAND MEXICO', 'CFDI RECIBIDOS', '01 PDF CFDI')) {
  $hijas = @(Get-ChildItem -LiteralPath $ruta -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  if ($hijas -contains $parte) { $ruta = Join-Path $ruta $parte; continue }
  $parecida = $hijas | Where-Object { ($_ -replace '\s+', ' ').Trim() -ieq $parte } | Select-Object -First 1
  if ($parecida) { Write-Host ('Ojo: en ' + $ruta + ' la carpeta se llama [' + $parecida + '] (con espacios distintos a [' + $parte + ']). El agente la usa igual.') -ForegroundColor Yellow; $ruta = Join-Path $ruta $parecida; continue }
  Write-Host ('Ojo: en ' + $ruta + ' no hay carpeta [' + $parte + ']. Hay: ' + (($hijas | Select-Object -First 15 | ForEach-Object { '[' + $_ + ']' }) -join ' ')) -ForegroundColor Yellow
  $ruta = $null; break
}
if ($ruta) { Write-Host ('OK: encontré ' + $ruta) -ForegroundColor Green }
Write-Host ('LISTO. Las facturas se guardarán en ' + $actual + '\<EMPRESA>\CFDI RECIBIDOS\01 PDF CFDI\<AÑO>\<MES>') -ForegroundColor Green
