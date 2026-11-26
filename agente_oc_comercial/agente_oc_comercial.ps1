<#
  Agente de carga automática de Órdenes de Compra a CONTPAQi Comercial
  (oct-2026, Chula Brand México).

  Corre en la PC donde está instalado Comercial (lo programa instalar_agente_oc.bat
  para que se ejecute cada 5 minutos con tu usuario de Windows). En cada vuelta:
   1. Le pregunta al sistema (Render) qué OC hay pendientes de cargar
      (agenteOcTrabajo). Si no hay, termina sin abrir nada.
   2. Abre Excel en segundo plano y HojaComercial.xls (que carga solo el
      complemento Hoja_Comercial_AddIn.xla, igual que cuando lo abres tú).
   3. Por cada empresa: la pone como "Empresa Activa" (Parametros!D2) y por
      cada OC revisa que el folio no exista, la crea con
      Hoja_Comercial_AddIn.XLA!Inserta_Documento (lo mismo que hace tu macro
      Enviar_Lote) y confirma con Dato_Documento/Importe_Documento que sí
      quedó en Comercial (nov-2026: el aviso "creado con éxito" sale aunque
      el folio ya fuera de otra OC).
   4. Cierra Excel y le reporta al sistema cuáles se cargaron y cuáles no
      (agenteOcResultado), con el mensaje que haya mostrado CONTPAQi.

  Los avisos que muestre CONTPAQi/Excel los lee y los cierra el ayudante
  cerrar_dialogos.ps1 (si no, Excel se quedaría esperando a que alguien
  diera clic). La clave del agente se guarda cifrada con tu usuario de
  Windows (DPAPI): solo tu usuario en esta PC la puede leer.

  Compatible con Windows PowerShell 5.1 (viene con Windows).
#>
param(
  [switch]$UnaVez,            # (se ignora; cada ejecución es una vuelta)
  [switch]$SoloFunciones      # pruebas: solo carga las funciones, no corre nada
)

$AGENTE_VERSION = '2026.11.30'
$SEP = [string][char]172      # separador de Inserta_Documento (kTokenSeparadorSACICOM)
$TIPO_COMPRAS = '2'
$DOCTO_ORDEN_COMPRA = '17'
$INV = [Globalization.CultureInfo]::InvariantCulture

# ------------------------------------------------------------------
# Funciones puras (se prueban sin Excel ni Comercial)
# ------------------------------------------------------------------
function Get-FechaMDY([string]$iso) {
  # "2026-10-29" -> "10/29/2026" (como la macro: mes/día/año)
  if ($iso -notmatch '^(\d{4})-(\d{2})-(\d{2})') { throw "Fecha no válida: $iso" }
  return ('{0}/{1}/{2}' -f $Matches[2], $Matches[3], $Matches[1])
}

# "2026-10-29" + 30 días -> "2026-11-28"
function Add-DiasIso([string]$iso, [int]$dias) {
  if ($iso -notmatch '^(\d{4})-(\d{2})-(\d{2})') { throw "Fecha no válida: $iso" }
  return (New-Object DateTime ([int]$Matches[1]), ([int]$Matches[2]), ([int]$Matches[3])).AddDays($dias).ToString('yyyy-MM-dd', $INV)
}

function Get-Num($v) {
  if ($null -eq $v -or ([string]$v).Trim() -eq '') { return '' }
  return ([double]$v).ToString('R', $INV)
}

# Misma cadena que Armar_Parametros de la macro LoteOrdenesCompra.bas
function Get-ParametrosOc($oc) {
  $fecha = Get-FechaMDY $oc.fecha
  $entrega = $fecha
  if ($oc.fechaEntrega) { $entrega = Get-FechaMDY $oc.fechaEntrega }
  # Vencimiento = fecha + días de crédito del proveedor en Comercial (como al capturar a mano).
  $dias = 0; if ($oc.diasCredito) { $dias = [int]$oc.diasCredito }
  $venc = Get-FechaMDY (Add-DiasIso $oc.fecha $dias)
  $p = @($TIPO_COMPRAS, [string]$oc.partidas.Count, $DOCTO_ORDEN_COMPRA, $fecha,
         ([string]$oc.concepto).Trim(), ([string]$oc.serie).Trim(), ([long]$oc.folio).ToString($INV),
         ([string]$oc.codigoProveedor).Trim(), '', $venc, $entrega, '1', '1')
  foreach ($pa in $oc.partidas) {
    $p += ([string]$pa.codigoProducto).Trim()
    $p += ([string]$oc.almacen).Trim()
    $p += (Get-Num $pa.cantidad)
    $p += (Get-Num $pa.precio)
    $p += ''; $p += ''                                   # Descuento 1 y 2 (el precio ya trae el descuento)
    # Impuesto 1 = IMPORTE del IVA (en la Hoja: Total = Neto - Desc + Imp1 + Imp2).
    # Vacío solo si el sistema no lo mandó (versión anterior): Comercial usa el del catálogo.
    if ($null -ne $pa.iva) { $p += (Get-Num ([math]::Round([double]$pa.iva, 2))) } else { $p += '' }
    $p += ''                                             # Impuesto 2
  }
  return ($p -join $SEP)
}

# Total esperado (neto + IVA) o $null si el sistema no mandó IVA.
function Get-TotalOc($oc) {
  $t = 0.0
  foreach ($pa in $oc.partidas) { if ($null -eq $pa.iva) { return $null }; $t += [double]$pa.cantidad * [double]$pa.precio + [double]$pa.iva }
  return [math]::Round($t, 2)
}

function Get-NetoOc($oc) {
  $t = 0.0
  foreach ($pa in $oc.partidas) { $t += [double]$pa.cantidad * [double]$pa.precio }
  return [math]::Round($t, 2)
}

function Get-NombreNormal([string]$t) {
  $n = $t.Normalize([Text.NormalizationForm]::FormD)
  $sb = New-Object Text.StringBuilder
  foreach ($c in $n.ToCharArray()) {
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($c) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($c) }
  }
  return (($sb.ToString().ToUpperInvariant() -replace '[^A-Z0-9]+', ' ').Trim())
}

# Empresa del sistema -> número en HojaComercial (pestaña Parametros).
# empresasHoja: @(@{ numero = 1; nombre = 'CHULA BRAND MEXICO' }, ...)
# mapa (opcional, de la config): @{ '16' = 2 }
function Find-NumeroEmpresa($empresaId, [string]$nombreSistema, $empresasHoja, $mapa) {
  if ($mapa -and $mapa.PSObject.Properties[[string]$empresaId]) { return [int]$mapa.([string]$empresaId) }
  $ns = Get-NombreNormal $nombreSistema
  foreach ($e in $empresasHoja) {
    $nh = Get-NombreNormal $e.nombre
    if (-not $nh) { continue }
    # El nombre del sistema puede traer la razón social completa ("..., S. DE P.R.")
    if ($ns -eq $nh -or $ns.StartsWith($nh + ' ')) { return [int]$e.numero }
  }
  return $null
}

# Decide el resultado de UNA OC con lo que se vio en Comercial.
#  antesNeto: neto del folio ANTES de crearla (0 = no existía)
#  despuesTotal / despuesNeto: después de Inserta_Documento
# Resultado de UN intento de Inserta_Documento, según el aviso que mostró CONTPAQi
# (oct-2026: Importe_Documento NO sirve para verificar — regresa importes de otros
# documentos de su memoria —, así que se usa lo que dice Comercial al guardar).
#  creada         -> "Documento creado con éxito"
#  folio_ocupado  -> error que habla del folio / documento existente: probar el siguiente
#  error          -> cualquier otra cosa
function Get-ResultadoInsercion([string[]]$mensajes, [string]$errorLlamada) {
  $txt = (($mensajes | Where-Object { $_ }) -join ' | ')
  if (-not $errorLlamada -and $txt -match 'creado con [eé]xito') { return @{ estado = 'creada'; mensaje = $txt } }
  if ($txt -match '(?i)folio[^.|]{0,40}((?<!no )existe|duplicad|repetid|ocupad|registrad)|ya existe') { return @{ estado = 'folio_ocupado'; mensaje = $txt } }
  $m = $errorLlamada
  if ($txt) { if ($m) { $m += ' | ' }; $m += $txt }
  if (-not $m) { $m = 'CONTPAQi no confirmó que se creara el documento (no mostró "Documento creado con éxito").' }
  return @{ estado = 'error'; mensaje = $m }
}

# Ruta final del PDF en el almacén digital. Si ya existe un archivo con ese
# nombre y el MISMO tamaño, es la misma factura (no se duplica); si es otro,
# se agrega " (2)", " (3)"...  $existe/$tamano: scriptblocks (para probarla sin disco).
function Get-RutaArchivo([string]$carpeta, [string]$archivo, [long]$bytes, [scriptblock]$existe, [scriptblock]$tamano) {
  $base = [IO.Path]::GetFileNameWithoutExtension($archivo); $ext = [IO.Path]::GetExtension($archivo)
  for ($i = 1; $i -le 50; $i++) {
    $nom = if ($i -eq 1) { $archivo } else { $base + ' (' + $i + ')' + $ext }
    $ruta = Join-Path $carpeta $nom
    if (-not (& $existe $ruta)) { return @{ ruta = $ruta; yaEstaba = $false } }
    if ([long](& $tamano $ruta) -eq $bytes) { return @{ ruta = $ruta; yaEstaba = $true } }
  }
  throw ('Hay demasiados archivos con el nombre ' + $archivo)
}

# Carpeta del almacén que YA existe aunque su nombre traiga espacios de más, otro uso de
# mayúsculas o acentos (nov-2026: en la PC de Edith "CHULA BRAND MEXICO\CFDI RECIBIDOS\01 PDF CFDI"
# se veía igual pero no coincidía). Por cada nivel usa la carpeta existente equivalente y
# solo crea las que de verdad faltan. $hijas: scriptblock(ruta) -> nombres de subcarpetas.
function Get-NombreCarpetaNormal([string]$t) {
  $n = $t.Normalize([Text.NormalizationForm]::FormD); $sb = New-Object Text.StringBuilder
  foreach ($c in $n.ToCharArray()) { if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($c) -ne 'NonSpacingMark') { [void]$sb.Append($c) } }
  return (($sb.ToString() -replace '[\s\u00A0]+', ' ').Trim().ToUpperInvariant())
}
function Resolve-CarpetaAlmacen([string]$raiz, [string]$relativa, [scriptblock]$hijas) {
  $ruta = $raiz
  foreach ($parte in ($relativa -split '\\' | Where-Object { $_ })) {
    $buscado = Get-NombreCarpetaNormal $parte
    $real = @(& $hijas $ruta) | Where-Object { (Get-NombreCarpetaNormal $_) -eq $buscado } | Select-Object -First 1
    $ruta = Join-Path $ruta $(if ($real) { $real } else { $parte })
  }
  return $ruta
}

# Nov-2026: actualización desde el Panel. Revisa el paquete que manda el sistema
# (agenteOcArchivos): solo nombres simples .ps1/.bat/.txt y que el sha256 de cada
# archivo coincida. Regresa @{ nombre; bytes } por archivo o truena con el motivo.
function Get-ArchivosActualizacion($archivos) {
  $lista = @($archivos | Where-Object { $_ })
  if (-not @($lista | Where-Object { [string]$_.nombre -eq 'agente_oc_comercial.ps1' }).Count) { throw 'El paquete del sistema no trae agente_oc_comercial.ps1.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  $out = @()
  foreach ($a in $lista) {
    $n = [string]$a.nombre
    if ($n -notmatch '^[A-Za-z0-9_\-]+\.(ps1|bat|txt)$' -or $n -eq 'agente_oc_config.json') { throw ('Archivo no permitido en el paquete: ' + $n) }
    $b = [Convert]::FromBase64String([string]$a.base64)
    $h = -join ($sha.ComputeHash($b) | ForEach-Object { $_.ToString('x2') })
    if ($h -ne ([string]$a.sha256).ToLower()) { throw ('El archivo ' + $n + ' llegó dañado (no coincide su sha256).') }
    if ($b.Length -lt 20) { throw ('El archivo ' + $n + ' llegó vacío.') }
    $out += @{ nombre = $n; bytes = $b }
  }
  return ,$out
}

# Reemplaza los archivos del agente en $carpeta (respaldo de los anteriores en
# $respaldo). Primero escribe todos como .nuevo y luego los pone en su lugar.
function Install-ArchivosActualizacion([string]$carpeta, $listos, [string]$respaldo) {
  New-Item -ItemType Directory -Force -Path $respaldo | Out-Null
  foreach ($a in $listos) {
    $ruta = Join-Path $carpeta $a.nombre
    if (Test-Path -LiteralPath $ruta) { Copy-Item -LiteralPath $ruta -Destination (Join-Path $respaldo $a.nombre) -Force }
    [IO.File]::WriteAllBytes($ruta + '.nuevo', [byte[]]$a.bytes)
  }
  foreach ($a in $listos) {
    $ruta = Join-Path $carpeta $a.nombre
    Move-Item -LiteralPath ($ruta + '.nuevo') -Destination $ruta -Force
  }
}

if ($SoloFunciones) { return }

# ------------------------------------------------------------------
# Ejecución
# ------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile = Join-Path $Dir ('logs\agente_' + (Get-Date -Format 'yyyy-MM') + '.log')
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'logs') | Out-Null
function Write-Log([string]$m) { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding UTF8 }

# Una sola vuelta a la vez
$mutex = New-Object System.Threading.Mutex($false, 'AgenteOcComercialChula')
if (-not $mutex.WaitOne(0)) { Write-Log 'Otra vuelta sigue corriendo; se salta esta.'; return }

try {
  $cfgPath = Join-Path $Dir 'agente_oc_config.json'
  if (-not (Test-Path $cfgPath)) { throw 'Falta agente_oc_config.json: corre instalar_agente_oc.bat.' }
  $Cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $sec = ConvertTo-SecureString $Cfg.tokenCifrado
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  function Invoke-Api([string]$fn, $argumentos) {
    $body = @{ args = $argumentos } | ConvertTo-Json -Depth 12 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    $r = Invoke-RestMethod -Uri ($Cfg.apiBase.TrimEnd('/') + '/api/' + $fn) -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 120
    return $r
  }

  $info = @{ version = $AGENTE_VERSION; equipo = $env:COMPUTERNAME }
  $trabajo = Invoke-Api 'agenteOcTrabajo' @($Token, $info)
  if (-not $trabajo.success) { throw ('El sistema rechazó al agente: ' + $trabajo.error) }

  # --- Actualización pedida desde el Panel (nov-2026) ---
  if ($trabajo.actualizar) {
    try {
      Write-Log ('Actualización pedida desde el Panel: v' + $AGENTE_VERSION + ' -> v' + $trabajo.actualizar.version)
      $paq = Invoke-Api 'agenteOcArchivos' @($Token)
      if (-not $paq.success) { throw ('El sistema no mandó los archivos: ' + $paq.error) }
      $listos = Get-ArchivosActualizacion @($paq.archivos)
      $respaldo = Join-Path $Dir ('logs\respaldo_v' + $AGENTE_VERSION + '_' + (Get-Date -Format 'yyyyMMddHHmmss'))
      Install-ArchivosActualizacion $Dir $listos $respaldo
      Write-Log ('Agente actualizado a v' + $paq.version + ' (' + $listos.Count + ' archivos; los anteriores quedaron en ' + $respaldo + '). La siguiente vuelta ya corre la versión nueva.')
    } catch {
      $em = $_.Exception.Message
      Write-Log ('No se pudo actualizar el agente: ' + $em)
      try { [void](Invoke-Api 'agenteOcTrabajo' @($Token, @{ version = $AGENTE_VERSION; equipo = $env:COMPUTERNAME; error = ('No se pudo actualizar el agente: ' + $em); errorActualizar = $em })) } catch { }
    }
    return
  }
  $empresas = @($trabajo.empresas)

  # --- Facturas al almacén digital (no necesita Excel ni Comercial) ---
  $facturas = @($trabajo.facturas | Where-Object { $_ })
  if ($facturas.Count) {
    $raiz = [string]$Cfg.almacenDigital; if (-not $raiz) { $raiz = 'Z:\ALMACEN DIGITAL' }
    $resFact = @()
    foreach ($f in $facturas) {
      try {
        if (-not (Test-Path -LiteralPath $raiz)) { throw ('No encuentro la carpeta del almacén digital (' + $raiz + ') en esta PC. Revisa que la unidad esté conectada o corre configurar_almacen_digital.bat.') }
        $carpeta = Resolve-CarpetaAlmacen $raiz ([string]$f.carpeta) { param($r) if (Test-Path -LiteralPath $r) { Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } } }
        if (-not (Test-Path -LiteralPath $carpeta)) { New-Item -ItemType Directory -Force -Path $carpeta | Out-Null }
        $url = [string]$f.url; if ($url.StartsWith('/')) { $url = $Cfg.apiBase.TrimEnd('/') + $url }
        $bytes = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 120).Content
        if ($bytes -is [string]) { $bytes = [Text.Encoding]::GetEncoding(28591).GetBytes($bytes) }
        if ($bytes.Length -lt 100) { throw 'El PDF de la factura llegó vacío.' }
        $dest = Get-RutaArchivo $carpeta ([string]$f.archivo) $bytes.Length { param($r) Test-Path -LiteralPath $r } { param($r) (Get-Item -LiteralPath $r).Length }
        if (-not $dest.yaEstaba) { [IO.File]::WriteAllBytes($dest.ruta, $bytes) }
        $resFact += @{ id = $f.id; ok = $true; ruta = $dest.ruta }
        Write-Log ('Factura de la OC ' + $f.oc + ' guardada en ' + $dest.ruta)
      } catch {
        $resFact += @{ id = $f.id; ok = $false; mensaje = $_.Exception.Message }
        Write-Log ('Factura de la OC ' + $f.oc + ': ERROR - ' + $_.Exception.Message)
      }
    }
    try { [void](Invoke-Api 'agenteFacturasResultado' @($Token, $resFact)) } catch { Write-Log ('No pude avisar al sistema de las facturas: ' + $_.Exception.Message) }
  }

  # --- OC de gastos con factura → GASTOS EN PESOS (opera la pantalla de Comercial) ---
  $gastos = @($trabajo.gastos | Where-Object { $_ })
  $probarGasto = ($env:AGENTE_GASTO_PROBAR -eq '1')
  # Automático solo cuando ya se probó y se prendió con activar_conversion_gasto.bat.
  if ($gastos.Count -and -not $probarGasto -and -not $Cfg.conversionGastoAuto) { $gastos = @() }
  if ($gastos.Count) {
    $gTrabajo = Join-Path $Dir 'logs\gastos_trabajo.json'
    $gResultado = Join-Path $Dir 'logs\gastos_resultado.json'
    if (Test-Path $gResultado) { Remove-Item $gResultado -Force }
    (ConvertTo-Json -InputObject @($gastos) -Depth 6) | Set-Content -Path $gTrabajo -Encoding UTF8
    $gArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $Dir 'convertir_gasto.ps1') + '"'), '-Trabajo', ('"' + $gTrabajo + '"'), '-Resultado', ('"' + $gResultado + '"'), '-Config', ('"' + $cfgPath + '"'), '-Log', ('"' + $LogFile + '"'))
    if ($probarGasto) { $gArgs += @('-Forzar', '-Probar') }
    try {
      $pg = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList $gArgs
      if (-not $pg.WaitForExit(15 * 60 * 1000)) { try { $pg.Kill() } catch { }; throw 'La conversión tardó más de 15 minutos; la detuve.' }
      if (-not (Test-Path $gResultado)) { throw 'convertir_gasto.ps1 terminó sin dejar resultado (revisa el registro).' }
      # Se arma de nuevo con hashtables: en PowerShell 5.1 un arreglo leído con ConvertFrom-Json se
      # vuelve a mandar como {"value":[...],"Count":1} y el sistema no lo veía (2-nov: la OC quedó "pendiente").
      $resGastos = @(@(Get-Content $gResultado -Raw -Encoding UTF8 | ConvertFrom-Json) | ForEach-Object { $_ } | Where-Object { $_ } | ForEach-Object {
        @{ id = $_.id; ok = [bool]$_.ok; esperar = [bool]$_.esperar; paso = [string]$_.paso; mensaje = [string]$_.mensaje } })
      $resumen = @($resGastos | ForEach-Object { if ($_.esperar) { 'espera' } elseif ($_.ok) { 'ok' } else { 'error' } }) -join ', '
      if ($probarGasto -or ($resGastos | Where-Object { -not $_.esperar })) { Write-Log ('Gastos en Comercial: ' + $resumen + ' - ' + (($resGastos | ForEach-Object { $_.mensaje }) -join ' | ')) }
      [void](Invoke-Api 'agenteGastosResultado' @($Token, $resGastos))
    } catch {
      Write-Log ('Conversión a gasto: ERROR - ' + $_.Exception.Message)
    }
  }

  $totalOcs = 0; foreach ($e in $empresas) { $totalOcs += @($e.ocs).Count }
  if ($totalOcs -eq 0) {
    # Desde probar_agente_oc.bat sí se anota, para que se vea que se conectó.
    if ($env:AGENTE_OC_DETALLE -eq '1') { Write-Log 'Conectado al sistema: no hay OC por cargar.' }
    return
  }
  Write-Log ("Hay $totalOcs OC por cargar.")

  # --- Excel + HojaComercial ---
  $xl = $null; $wb = $null; $ayudante = $null
  $resultados = @()
  $dialogLog = Join-Path $Dir 'logs\dialogos.txt'
  if (Test-Path $dialogLog) { Remove-Item $dialogLog -Force }
  $loginLog = Join-Path $Dir 'logs\login.txt'
  if (Test-Path $loginLog) { Remove-Item $loginLog -Force }
  try {
    if (-not (Test-Path $Cfg.hojaComercial)) { throw ('No encuentro HojaComercial.xls en ' + $Cfg.hojaComercial) }
    $xl = New-Object -ComObject Excel.Application
    $xl.Visible = $false
    $xl.DisplayAlerts = $false
    $xl.AutomationSecurity = 1   # deja correr las macros del libro (Auto_Open)
    Add-Type -Namespace AgenteOc -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);' -ErrorAction SilentlyContinue
    $xlPid = 0; [void][AgenteOc.Win]::GetWindowThreadProcessId([IntPtr]$xl.Hwnd, [ref]$xlPid)
    # Rutas entre comillas: llevan espacios ("Carlos Contreras") y Start-Process no las cita solo.
    $ayudante = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $Dir 'cerrar_dialogos.ps1') + '"'), '-ExcelPid', $xlPid, '-Log', ('"' + $dialogLog + '"'), '-Config', ('"' + $cfgPath + '"'), '-LoginLog', ('"' + $loginLog + '"'))
    $wb = $xl.Workbooks.Open($Cfg.hojaComercial, 0, $true)
    $wb.RunAutoMacros(1)         # Auto_Open: carga Hoja_Comercial_AddIn.xla
    $par = $wb.Worksheets.Item('Parametros')
    $empresasHoja = @()
    for ($r = 4; $r -le 60; $r++) {
      $nom = [string]$par.Cells.Item($r, 2).Value2
      if ($nom -and $nom.Trim()) { $empresasHoja += @{ numero = [int]$par.Cells.Item($r, 1).Value2; nombre = $nom.Trim() } }
    }

    # Días de crédito del proveedor (Dato_Proveedor 29 de la Hoja Electrónica).
    $diasCache = @{}
    function Get-DiasCredito([string]$prov, [int]$numEmp) {
      $k = [string]$numEmp + '|' + $prov
      if (-not $diasCache.ContainsKey($k)) {
        $d = 0
        try { $v = [string]$xl.Run('Hoja_Comercial_AddIn.XLA!Dato_CliProv', $prov, 29, 'P', $numEmp); $n = 0.0; if ([double]::TryParse($v.Trim(), [Globalization.NumberStyles]::Any, $INV, [ref]$n)) { $d = [int][math]::Round($n) } } catch { }
        if ($d -lt 0 -or $d -gt 365) { $d = 0 }
        if ($d -eq 0) {
          # Para ubicar el dato correcto si el 29 no son los días de crédito.
          $vals = @(); for ($i = 1; $i -le 60; $i++) { $x = ''; try { $x = ([string]$xl.Run('Hoja_Comercial_AddIn.XLA!Dato_CliProv', $prov, $i, 'P', $numEmp)).Trim() } catch { $x = 'ERROR' }; $vals += ([string]$i + '=' + $x) }
          Write-Log ('  Proveedor ' + $prov + ' sin días de crédito (dato 29). Datos: ' + ($vals -join ' | '))
        }
        $diasCache[$k] = $d
      }
      return $diasCache[$k]
    }
    # Bitácora local de lo ya creado en Comercial (por si una vuelta se cae
    # después de crear la OC y antes de avisar al sistema: no se duplica).
    $journalPath = Join-Path $Dir 'logs\cargadas.json'
    $journal = @{}
    if (Test-Path $journalPath) { try { (Get-Content $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $journal[$_.Name] = $_.Value } } catch { } }
    $limiteJournal = (Get-Date).AddDays(-90).ToString('s')
    foreach ($k in @($journal.Keys)) { if ([string]$journal[$k].en -lt $limiteJournal) { $journal.Remove($k) } }
    # Nov-2026: Inserta_Documento dice "Documento creado con éxito" aunque el
    # folio YA EXISTA en Comercial (pasó con VER 100029: era de otro proveedor
    # y la OC nueva no quedó en ningún lado). Por eso, antes de crear, se
    # revisa con Dato_Documento/Importe_Documento (solo lectura) si el folio
    # existe, y después se confirma que sí quedó.
    # Devuelve 'si' / 'no' / '?' (no se pudo leer) y los valores leídos.
    $DOC_DE_OC = 17
    function Read-Doc([double]$folio, [string]$serie) {
      # Otra serie primero: el complemento guarda en memoria el último bloque
      # leído y, sin esto, un documento recién creado no aparecería.
      try { [void]$xl.Run('Hoja_Comercial_AddIn.XLA!Dato_Documento', [double]1, 'ZZZZ', $DOC_DE_OC, 1) } catch { }
      try { [void]$xl.Run('Hoja_Comercial_AddIn.XLA!Importe_Documento', [double]1, 'ZZZZ', $DOC_DE_OC, 1) } catch { }
      $d = @(); $imp = @()
      for ($n = 1; $n -le 45; $n++) { $x = 'ERROR'; try { $x = ([string]$xl.Run('Hoja_Comercial_AddIn.XLA!Dato_Documento', $folio, $serie, $DOC_DE_OC, $n)).Trim() } catch { }; $d += $x }
      for ($n = 1; $n -le 31; $n++) { $x = 0.0; try { $x = [double]$xl.Run('Hoja_Comercial_AddIn.XLA!Importe_Documento', $folio, $serie, $DOC_DE_OC, $n) } catch { }; $imp += $x }
      return @{ datos = $d; importes = $imp }
    }
    $docVacio = @{}
    function Get-EstadoFolio([string]$serie, [long]$folio) {
      if (-not $docVacio.ContainsKey($serie)) { $docVacio[$serie] = Read-Doc 999999998 $serie }
      $base = $docVacio[$serie]; $r = Read-Doc $folio $serie
      $leidos = @($r.datos | Where-Object { $_ -ne 'ERROR' }).Count
      if ($leidos -eq 0) { return @{ estado = '?'; doc = $r } }
      $dif = $false
      for ($i = 0; $i -lt $r.datos.Count; $i++) { if ($r.datos[$i] -ne 'ERROR' -and $r.datos[$i] -ne $base.datos[$i]) { $dif = $true; break } }
      if (-not $dif) { for ($i = 0; $i -lt $r.importes.Count; $i++) { if ([math]::Abs($r.importes[$i] - $base.importes[$i]) -gt 0.001) { $dif = $true; break } } }
      return @{ estado = $(if ($dif) { 'si' } else { 'no' }); doc = $r }
    }
    # Total con letra de CONTPAQi -> número: "(cinco mil doscientos setenta y siete pesos 54/100)" = 5277.54
    function ConvertFrom-ImporteLetra([string]$t) {
      $n = (Get-NombreNormal $t).ToLower()
      if (([string]$t) -notmatch '/\s*100' -or $n -notmatch '^(.+?)\s+pesos?\s+(\d{1,2})\s+100\b') { return $null }   # Get-NombreNormal quita ( ) y /
      $pal = $Matches[1]; $cent = [int]$Matches[2]
      $v = @{ cero = 0; un = 1; uno = 1; una = 1; dos = 2; tres = 3; cuatro = 4; cinco = 5; seis = 6; siete = 7; ocho = 8; nueve = 9; diez = 10; once = 11; doce = 12; trece = 13; catorce = 14; quince = 15
        dieciseis = 16; diecisiete = 17; dieciocho = 18; diecinueve = 19; veinte = 20; veintiun = 21; veintiuno = 21; veintidos = 22; veintitres = 23; veinticuatro = 24; veinticinco = 25; veintiseis = 26; veintisiete = 27; veintiocho = 28; veintinueve = 29
        treinta = 30; cuarenta = 40; cincuenta = 50; sesenta = 60; setenta = 70; ochenta = 80; noventa = 90; cien = 100; ciento = 100; doscientos = 200; trescientos = 300; cuatrocientos = 400; quinientos = 500
        seiscientos = 600; setecientos = 700; ochocientos = 800; novecientos = 900 }
      $total = 0.0; $cur = 0.0
      foreach ($w in ($pal -split '\s+')) {
        if (-not $w -or $w -eq 'y') { continue }
        if ($v.ContainsKey($w)) { $cur += $v[$w] }
        elseif ($w -eq 'mil') { $total += [math]::Max($cur, 1) * 1000; $cur = 0 }
        elseif ($w -match '^millon(es)?$') { $total += [math]::Max($cur, 1) * 1000000; $cur = 0 }
        else { return $null }
      }
      return [math]::Round($total + $cur + $cent / 100.0, 2)
    }
    # ¿El documento leído es esta OC? Proveedor (dato 1) y total con letra.
    # Devuelve '' si cuadra, o el motivo si no.
    function Test-DocEsDeOc($doc, [string]$codProv, $total) {
      $p = ([string]$doc.datos[0]).Trim().TrimStart('0'); $q = ([string]$codProv).Trim().TrimStart('0')
      if ($p -ne $q) { return ('es del proveedor ' + ([string]$doc.datos[0]).Trim() + ' ' + ([string]$doc.datos[1]).Trim() + ', no del ' + $codProv) }
      if ($null -ne $total) {
        foreach ($t in $doc.datos) {
          $x = ConvertFrom-ImporteLetra ([string]$t)
          if ($null -ne $x) { if ([math]::Abs($x - [double]$total) -gt 0.05) { return ('su total es $' + $x.ToString('0.00', $INV) + ', no $' + ([double]$total).ToString('0.00', $INV)) } else { return '' } }
        }
      }
      return ''
    }
    function Format-Doc($doc) { return ('datos=[' + (($doc.datos | ForEach-Object { ([string]$_) -replace '[\r\n]', ' ' }) -join '|') + '] importes=[' + (($doc.importes | ForEach-Object { $_.ToString('0.##', $INV) }) -join '|') + ']') }

    function Save-Journal { ($journal | ConvertTo-Json -Depth 3) | Set-Content -Path $journalPath -Encoding UTF8 }
    function Get-Dialogos([int]$desde) {
      if (-not (Test-Path $dialogLog)) { return @() }
      $l = @(Get-Content $dialogLog -Encoding UTF8)
      if ($l.Count -le $desde) { return @() }
      return $l[$desde..($l.Count - 1)]
    }

    foreach ($e in $empresas) {
      $num = Find-NumeroEmpresa $e.empresaId $e.empresa $empresasHoja $Cfg.empresas
      if (-not $num) {
        foreach ($oc in @($e.ocs)) {
          $resultados += @{ empresaId = $e.empresaId; serie = $oc.serie; folio = $oc.folio; ok = $false; total = $null
            mensaje = ('La empresa "' + $e.empresa + '" no está dada de alta en HojaComercial (pestaña Parametros → Insertar empresa).') }
        }
        continue
      }
      try { $par.Unprotect() } catch { }
      $par.Range('D2').Value2 = $num
      Write-Log ("Empresa activa $num = " + $e.empresa)
      foreach ($oc in @($e.ocs)) {
        $folioSistema = [long]$oc.folio
        $serieOc = [string]$oc.serie
        $neto = Get-NetoOc $oc
        $totEsp = Get-TotalOc $oc; if ($null -eq $totEsp) { $totEsp = $neto }
        $clave = [string]$e.empresaId + '|' + $serieOc + '|' + $folioSistema + '|' + $neto.ToString('0.00', $INV)
        $oc | Add-Member -NotePropertyName diasCredito -NotePropertyValue (Get-DiasCredito ([string]$oc.codigoProveedor).Trim() $num) -Force
        $res = $null
        if ($journal.ContainsKey($clave)) {
          $fj = [long]$journal[$clave].folio
          $ej = Get-EstadoFolio $serieOc $fj
          $deOtra = ($ej.estado -eq 'si' -and (Test-DocEsDeOc $ej.doc ([string]$oc.codigoProveedor) (Get-TotalOc $oc)) -ne '')
          if ($ej.estado -eq 'no' -or $deOtra) {
            # La bitácora dice que se creó, pero en Comercial no está (o ese folio
            # es de otra OC, con otro total): se vuelve a crear con un folio libre.
            Write-Log ('  ' + $serieOc + ' ' + $fj + ' estaba en la bitácora pero ' + $(if ($deOtra) { 'en Comercial es OTRA OC (otro total)' } else { 'NO existe en Comercial' }) + '; se vuelve a crear.')
            $journal.Remove($clave); Save-Journal
          } else {
            $oc.folio = $fj
            $res = @{ ok = $true; total = $totEsp; mensaje = 'Ya se había creado en Comercial en una vuelta anterior (folio ' + $oc.folio + ').' }
          }
        }
        if (-not $res) {
          $sinLeer = $false
          for ($intento = 0; $intento -lt 200 -and -not $res; $intento++) {
            $oc.folio = $folioSistema + $intento
            $ef = Get-EstadoFolio $serieOc ([long]$oc.folio)
            if ($ef.estado -eq 'si') { Write-Log ('  Folio ' + $serieOc + ' ' + $oc.folio + ' ya existe en Comercial; pruebo el siguiente.'); continue }
            if ($ef.estado -eq '?') { $sinLeer = $true; Write-Log ('  No pude leer si el folio ' + $serieOc + ' ' + $oc.folio + ' existe (Dato_Documento dio ERROR).') }
            $nDial = @(Get-Dialogos 0).Count
            $errLlamada = ''
            try {
              $wb.Activate()
              [void]$xl.Run('Hoja_Comercial_AddIn.XLA!Inserta_Documento', (Get-ParametrosOc $oc))
            } catch { $errLlamada = 'Error al llamar a CONTPAQi: ' + $_.Exception.Message }
            Start-Sleep -Milliseconds 800
            $r1 = Get-ResultadoInsercion (Get-Dialogos $nDial) $errLlamada
            if ($r1.estado -eq 'creada') {
              # Comprobar que de verdad quedó (no confiar solo en el aviso).
              $ev = Get-EstadoFolio $serieOc ([long]$oc.folio)
              Write-Log ('  Revisión ' + $serieOc + ' ' + $oc.folio + ': ' + $ev.estado + ' ' + (Format-Doc $ev.doc))
              if ($ev.estado -eq 'no') {
                $res = @{ ok = $false; total = $null; mensaje = ('CONTPAQi dijo "Documento creado con éxito" pero la OC ' + $serieOc + ' ' + $oc.folio + ' NO aparece en Comercial. No se marcó como cargada; revisa el folio en Comercial y dale Reintentar.') }
                break
              }
              $journal[$clave] = @{ folio = [long]$oc.folio; en = (Get-Date -Format 's') }
              Save-Journal
              $m = 'Creada en Comercial (vence en ' + $oc.diasCredito + ' días).'
              $dif = $(if ($ev.estado -eq 'si') { Test-DocEsDeOc $ev.doc ([string]$oc.codigoProveedor) (Get-TotalOc $oc) } else { '' })
              if ($dif) { $m += ' OJO: en Comercial el ' + $serieOc + ' ' + $oc.folio + ' ' + $dif + '; revísalo.' }
              elseif ($ev.estado -eq '?' -or $sinLeer) { $m += ' (No pude comprobarla en Comercial; revísala.)' }
              if ($oc.folio -ne $folioSistema) { $m = 'Se usó el folio ' + $oc.folio + ' (el ' + $folioSistema + ' ya estaba ocupado en Comercial). ' + $m }
              $res = @{ ok = $true; total = $totEsp; mensaje = $m }
            } elseif ($r1.estado -eq 'folio_ocupado') {
              Write-Log ('  Folio ' + $serieOc + ' ' + $oc.folio + ' ocupado: ' + $r1.mensaje)
            } else {
              $res = @{ ok = $false; total = $null; mensaje = $r1.mensaje }
            }
          }
          if (-not $res) { $res = @{ ok = $false; total = $null; mensaje = ('No encontré folio libre en 200 intentos a partir del ' + $folioSistema + '.') } }
        }
        # folio = el que asignó el sistema (para encontrarla); folioReal = el que quedó en Comercial
        $res.empresaId = $e.empresaId; $res.serie = $serieOc; $res.folio = $folioSistema; $res.folioReal = [long]$oc.folio
        $resultados += $res
        Write-Log ('OC ' + $serieOc + ' ' + $oc.folio + ': ' + $(if ($res.ok) { 'OK' } else { 'ERROR' }) + ' - ' + $res.mensaje)
      }
    }
  } finally {
    if ($wb) { try { $wb.Close($false) } catch { } }
    if ($xl) { try { $xl.Quit() } catch { }; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
    if ($ayudante -and -not $ayudante.HasExited) { try { $ayudante.Kill() } catch { } }
    if (Test-Path $loginLog) { Get-Content $loginLog -Encoding UTF8 | ForEach-Object { Add-Content -Path $LogFile -Value $_ -Encoding UTF8 } }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
  if ($resultados.Count) {
    $r = Invoke-Api 'agenteOcResultado' @($Token, $resultados)
    Write-Log ('Reportado: ' + $r.cargadas + ' cargadas, ' + $r.errores + ' con error.')
  }
} catch {
  $msg = $_.Exception.Message
  # Si se cayó porque CONTPAQi pidió usuario y clave, el ayudante dejó el motivo.
  try {
    if ($loginLog -and (Test-Path $loginLog)) {
      $motivo = @(Get-Content $loginLog -Encoding UTF8 | Where-Object { $_ -match 'no hay clave guardada|No pude entrar|No pude leer' }) | Select-Object -Last 1
      if ($motivo) { $msg = ($motivo -replace '^\S+ \S+\s+', '') }
    }
  } catch { }
  Write-Log ('ERROR: ' + $msg)
  try { [void](Invoke-Api 'agenteOcTrabajo' @($Token, @{ version = $AGENTE_VERSION; equipo = $env:COMPUTERNAME; error = $msg })) } catch { }
} finally {
  $mutex.ReleaseMutex()
}
