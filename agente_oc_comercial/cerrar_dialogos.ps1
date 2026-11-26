<#
  Ayudante del agente de OC (oct-2026): mientras el agente usa Excel en
  segundo plano, CONTPAQi/Excel pueden mostrar avisos ("Documento
  insertado", "El concepto no existe", etc.). Si nadie les da clic, Excel se
  queda detenido. Este ayudante, cada 0.3 s, busca ventanas de aviso de ESE
  Excel, guarda su texto en el log (el agente lo reporta al Panel) y las
  cierra: "Aceptar"/"OK"; si solo hay "Sí"/"No", elige "No" (lo más seguro).
  Termina solo cuando Excel se cierra.

  Inicio de sesión (oct-2026): al abrir HojaComercial, el complemento muestra
  "Ingreso a CONTPAQ i COMERCIAL" (frmLogin, un formulario de VBA). Si nadie
  lo contesta, el agente se queda esperando para siempre. Este ayudante lo
  llena con el usuario y la clave guardados (cifrados con DPAPI) por
  guardar_clave_contpaqi.bat: primero mandándole las teclas a la ventana
  (funciona aunque la PC esté bloqueada) y, si no, con SendKeys. Si no hay
  clave guardada o no logra entrar en 60 s, cierra ese Excel para que el
  agente no se quede trabado y deja el motivo en logs\login.txt.
#>
param([int]$ExcelPid, [string]$Log, [string]$Config = '', [string]$LoginLog = '')

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Dialogos {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  const int BM_CLICK = 0x00F5;
  static string Clase(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string Texto(IntPtr h) { var s = new StringBuilder(2048); GetWindowText(h, s, 2048); return s.ToString(); }
  // Regresa los textos de los avisos que encontró y cerró.
  public static List<string> CerrarDe(int pid) {
    var vistos = new List<string>();
    var avisos = new List<IntPtr>();
    EnumWindows((h, l) => {
      int p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Clase(h) == "#32770") avisos.Add(h);
      return true;
    }, IntPtr.Zero);
    foreach (var d in avisos) {
      var textos = new List<string>();
      var botones = new Dictionary<string, IntPtr>();
      EnumChildWindows(d, (c, l) => {
        string cl = Clase(c), tx = Texto(c).Replace("&", "").Trim();
        if (cl == "Static" && tx.Length > 0) textos.Add(tx);
        if (cl == "Button" && tx.Length > 0 && !botones.ContainsKey(tx.ToUpperInvariant())) botones[tx.ToUpperInvariant()] = c;
        return true;
      }, IntPtr.Zero);
      string titulo = Texto(d);
      vistos.Add((titulo.Length > 0 ? titulo + ": " : "") + string.Join(" ", textos).Replace("\r", " ").Replace("\n", " "));
      IntPtr boton = IntPtr.Zero;
      foreach (var k in new[] { "ACEPTAR", "OK", "CERRAR", "NO", "CANCELAR" }) { if (botones.ContainsKey(k)) { boton = botones[k]; break; } }
      if (boton == IntPtr.Zero) foreach (var b in botones.Values) { boton = b; break; }
      if (boton != IntPtr.Zero) SendMessage(boton, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }
    return vistos;
  }

  // ---- Inicio de sesión de CONTPAQi (formulario de VBA, clase ThunderDFrame) ----
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  // Ventana del formulario de ingreso de ESE Excel (o Zero).
  public static IntPtr VentanaLogin(int pid) {
    IntPtr encontrada = IntPtr.Zero;
    EnumWindows((h, l) => {
      int p; GetWindowThreadProcessId(h, out p);
      // Solo VISIBLE: después de Aceptar el formulario solo se oculta (Me.Hide) y la ventana sigue existiendo.
      if (p == pid && IsWindowVisible(h) && Clase(h) == "ThunderDFrame" && Texto(h).IndexOf("Ingreso a CONTPAQ", StringComparison.OrdinalIgnoreCase) >= 0) { encontrada = h; return false; }
      return true;
    }, IntPtr.Zero);
    return encontrada;
  }
  // Ventana interna que recibe las teclas de los controles del formulario.
  public static IntPtr Receptor(IntPtr form) {
    IntPtr r = IntPtr.Zero;
    EnumChildWindows(form, (c, l) => { if (Clase(c).StartsWith("F3 Server")) { r = c; return false; } return true; }, IntPtr.Zero);
    return r == IntPtr.Zero ? form : r;
  }
  static IntPtr LParam(int vk, bool arriba) {
    long scan = MapVirtualKey((uint)vk, 0);
    long v = 1 | (scan << 16);
    if (arriba) v |= (1L << 30) | (1L << 31);
    return new IntPtr(v);
  }
  public static void Tecla(IntPtr h, int vk) {
    PostMessage(h, 0x0100, new IntPtr(vk), LParam(vk, false));   // WM_KEYDOWN
    PostMessage(h, 0x0101, new IntPtr(vk), LParam(vk, true));    // WM_KEYUP
  }
  public static void Letras(IntPtr h, string t) {
    foreach (char ch in t) PostMessage(h, 0x0102, new IntPtr(ch), new IntPtr(1));   // WM_CHAR
  }
  // Borra la caja que tiene el foco: Fin + retrocesos.
  public static void Vaciar(IntPtr h) {
    Tecla(h, 0x23);
    for (int i = 0; i < 40; i++) { Tecla(h, 0x08); PostMessage(h, 0x0102, new IntPtr(8), new IntPtr(1)); }
  }
}
'@

# --- Usuario y clave de CONTPAQi (cifrados con DPAPI por guardar_clave_contpaqi.bat) ---
function Write-Login([string]$m) {
  if ($LoginLog) { Add-Content -Path $LoginLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding UTF8 }
}
$usuarioCq = ''; $claveCq = ''
try {
  if ($Config -and (Test-Path $Config)) {
    $c = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($c.contpaqiUsuario) { $usuarioCq = [string]$c.contpaqiUsuario }
    if ($c.contpaqiClaveCifrada) {
      $s = ConvertTo-SecureString $c.contpaqiClaveCifrada
      $claveCq = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    }
  }
} catch { Write-Login ('No pude leer la clave de CONTPAQi guardada: ' + $_.Exception.Message) }
if (-not $usuarioCq) { $usuarioCq = 'SUPERVISOR' }

function Escapar-SendKeys([string]$t) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $t.ToCharArray()) { if ('+^%~(){}[]'.IndexOf($ch) -ge 0) { [void]$sb.Append('{' + $ch + '}') } else { [void]$sb.Append($ch) } }
  return $sb.ToString()
}

$loginVisto = $null      # cuándo apareció la ventana de ingreso
$loginIntentos = 0
$loginUltimo = [datetime]::MinValue
function Revisar-Login {
  $f = [Dialogos]::VentanaLogin($ExcelPid)
  if ($f -eq [IntPtr]::Zero) {
    if ($script:loginVisto) { Write-Login 'Sesión de CONTPAQi iniciada.'; $script:loginVisto = $null; $script:loginIntentos = 0 }
    return
  }
  $ahora = Get-Date
  if (-not $script:loginVisto) { $script:loginVisto = $ahora }
  if (-not $claveCq) {
    if (($ahora - $script:loginVisto).TotalSeconds -ge 3) {
      Write-Login 'CONTPAQi pide usuario y clave y no hay clave guardada: corre guardar_clave_contpaqi.bat en esta PC.'
      Stop-Process -Id $ExcelPid -Force -ErrorAction SilentlyContinue
    }
    return
  }
  if (($ahora - $script:loginVisto).TotalSeconds -ge 60) {
    Write-Login 'No pude entrar a CONTPAQi en 60 s (¿clave cambiada? vuelve a correr guardar_clave_contpaqi.bat).'
    Stop-Process -Id $ExcelPid -Force -ErrorAction SilentlyContinue
    return
  }
  if (($ahora - $script:loginUltimo).TotalSeconds -lt 4) { return }   # deja que el formulario procese
  if ($script:loginIntentos -ge 2) { return }                          # solo 2 intentos; luego espera los 60 s
  $script:loginUltimo = $ahora
  $script:loginIntentos++
  if ($script:loginIntentos -eq 1) {
    # 1) Teclas directo a la ventana (sirve con la PC bloqueada). Foco inicial: Código del usuario.
    $r = [Dialogos]::Receptor($f)
    [Dialogos]::Vaciar($r); [Dialogos]::Letras($r, $usuarioCq)
    [Dialogos]::Tecla($r, 0x09)                                  # Tab → Clave de acceso
    [Dialogos]::Vaciar($r); [Dialogos]::Letras($r, $claveCq)
    [Dialogos]::Tecla($r, 0x09)                                  # Tab → Aceptar
    [Dialogos]::Tecla($r, 0x0D)                                  # Enter
    Write-Login ('Contestando el ingreso a CONTPAQi (usuario ' + $usuarioCq + ', intento ' + $script:loginIntentos + ').')
  } else {
    # 2) Si no funcionó: la trae al frente y escribe con SendKeys (necesita la sesión desbloqueada).
    Add-Type -AssemblyName System.Windows.Forms
    [void][Dialogos]::BringWindowToTop($f); [void][Dialogos]::SetForegroundWindow($f)
    Start-Sleep -Milliseconds 300
    # Seguridad: solo se escribe si la ventana de ingreso quedó al frente y visible;
    # si no, las teclas (y la clave) irían a otro programa.
    if ([Dialogos]::GetForegroundWindow() -ne $f -or [Dialogos]::VentanaLogin($ExcelPid) -ne $f) {
      Write-Login 'No pude traer al frente la ventana de ingreso; no escribo nada fuera de ella.'
      return
    }
    [System.Windows.Forms.SendKeys]::SendWait('{END}{BS 40}' + (Escapar-SendKeys $usuarioCq) + '{TAB}{END}{BS 40}' + (Escapar-SendKeys $claveCq) + '{TAB}{ENTER}')
    Write-Login ('Contestando el ingreso a CONTPAQi con el teclado (intento ' + $script:loginIntentos + ').')
  }
}

while ($true) {
  if (-not (Get-Process -Id $ExcelPid -ErrorAction SilentlyContinue)) { break }
  try { Revisar-Login } catch { Write-Login ('Error al contestar el ingreso: ' + $_.Exception.Message) }
  try {
    foreach ($t in [Dialogos]::CerrarDe($ExcelPid)) {
      if ($t) { Add-Content -Path $Log -Value $t -Encoding UTF8 }
    }
  } catch { }
  Start-Sleep -Milliseconds 300
}
