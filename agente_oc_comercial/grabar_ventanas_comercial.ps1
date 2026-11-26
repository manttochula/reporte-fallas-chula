<#
  Grabador de ventanas de CONTPAQi Comercial (nov-2026).
  Mientras corre, tú haces a mano todo el proceso (abrir Comercial, Ingreso,
  empresa, Contabilidad → Cancelar, lista de ORDEN DE COMPRA GENERALES,
  abrir la OC, Convertir, Aceptar, Continuar, serie/folio, Guardar).
  Cada vez que aparece una ventana nueva anota cómo está hecha: controles,
  menús y los botones de las barras (texto y posición), para que el agente
  pueda hacer lo mismo solo.

  NO graba teclas ni clics. En las ventanas de Ingreso/usuario/clave solo
  anota tipo y posición de las cajas (nunca lo escrito) y el texto de los
  botones; en ninguna ventana lee campos de contraseña.

  Termina cuando das Enter en esta ventana negra (o a los 20 minutos).
  Resultado: logs\grabacion_comercial.txt
#>
param([int]$Minutos = 20, [switch]$SoloFunciones)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Grab {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll")] static extern int GetMenuItemID(IntPtr m, int pos);
  [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr m, int pos);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr m, int pos, StringBuilder s, int n, int flags);
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize, flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(int tid, ref GUITHREADINFO i);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int acc, bool inh, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr a, int size, int type, int prot);
  [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr p, IntPtr a, int size, int type);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr p, IntPtr a, byte[] b, int size, out IntPtr leidos);

  static string Clase(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string Titulo(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  static string TextoControl(IntPtr h) { var s = new StringBuilder(512); SendMessage(h, 0x000D, new IntPtr(512), s); return s.ToString(); }
  static string Limpio(string t) { return (t ?? "").Replace("\r", " ").Replace("\n", " "); }

  public static bool EsIngreso(string titulo, string clase) {
    string t = (titulo ?? "").ToUpperInvariant();
    return t.Contains("INGRESO") || t.Contains("CONTRASE") || t.Contains("PASSWORD") || t.Contains("LOGIN") || t.Contains("ACCESO") || t.Contains("USUARIO") || clase == "ThunderDFrame";
  }
  // Solo botones/etiquetas: nunca cajas de texto ni combos.
  public static bool EsBotonOEtiqueta(string cl) {
    string u = cl.ToUpperInvariant();
    return (u.Contains("BUTTON") || u.Contains("BITBTN") || u.Contains("BTN") || u.Contains("LABEL") || u == "STATIC" || u.Contains("STATICTEXT") || u.Contains("CHECKBOX") || u.Contains("RADIO") || u.Contains("TABSHEET") || u.Contains("GROUPBOX"))
        && !u.Contains("EDIT") && !u.Contains("COMBO") && !u.Contains("MASCARA");
  }

  public static List<IntPtr> Ventanas(HashSet<int> pids) {
    var l = new List<IntPtr>();
    EnumWindows((h, x) => { int p; GetWindowThreadProcessId(h, out p); if (pids.Contains(p) && IsWindowVisible(h)) l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
  public static string Firma(IntPtr w) {
    var sb = new StringBuilder(Clase(w) + "|" + Titulo(w));
    EnumChildWindows(w, (c, x) => { if (IsWindowVisible(c)) sb.Append("|" + Clase(c)); return true; }, IntPtr.Zero);
    return sb.ToString();
  }
  public static string Encabezado(IntPtr w) {
    int p; GetWindowThreadProcessId(w, out p); RECT r; GetWindowRect(w, out r);
    return "clase=[" + Clase(w) + "] titulo=[" + Titulo(w) + "] pid=" + p + " pos=" + r.L + "," + r.T + " tam=" + (r.R - r.L) + "x" + (r.B - r.T);
  }

  public static List<string> Describir(IntPtr w) {
    var r = new List<string>();
    string titulo = Titulo(w), clase = Clase(w);
    bool ingreso = EsIngreso(titulo, clase);
    RECT wr; GetWindowRect(w, out wr);
    int pid; int tid = GetWindowThreadProcessId(w, out pid);
    if (ingreso) r.Add("   (ventana de ingreso: no se lee lo escrito en cajas; solo botones y etiquetas)");
    var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(gi);
    if (GetGUIThreadInfo(tid, ref gi) && gi.hwndFocus != IntPtr.Zero) r.Add("   foco en: clase=[" + Clase(gi.hwndFocus) + "] h=" + gi.hwndFocus.ToInt64());
    var toolbars = new List<IntPtr>();
    EnumChildWindows(w, (c, x) => {
      if (!IsWindowVisible(c)) return true;
      string cl = Clase(c);
      int estilo = GetWindowLong(c, -16);
      bool esClave = (estilo & 0x20) != 0 && cl.ToUpperInvariant().Contains("EDIT");
      string tx;
      if (EsBotonOEtiqueta(cl)) tx = Titulo(c);
      else if (ingreso || esClave) tx = "(no se lee)";
      else if (cl.ToUpperInvariant().Contains("TOOLBAR")) tx = "";
      else tx = TextoControl(c);
      RECT cr; GetWindowRect(c, out cr);
      r.Add("   control clase=[" + cl + "] h=" + c.ToInt64() + " id=" + GetDlgCtrlID(c) + " pos=" + (cr.L - wr.L) + "," + (cr.T - wr.T) + " tam=" + (cr.R - cr.L) + "x" + (cr.B - cr.T) +
            " estilo=0x" + estilo.ToString("X8") + (esClave ? " CLAVE" : "") + " padre=" + (GetParent(c) == w ? "ventana" : "h" + GetParent(c).ToInt64()) + " texto=[" + Limpio(tx) + "]");
      if (cl.ToUpperInvariant().Contains("TOOLBAR")) toolbars.Add(c);
      return true;
    }, IntPtr.Zero);
    foreach (var tb in toolbars) r.AddRange(BotonesBarra(tb, pid, wr));
    IntPtr m = GetMenu(w);
    if (m != IntPtr.Zero) { r.Add("   MENU:"); Menu(m, "     ", r, 0); }
    return r;
  }

  static void Menu(IntPtr m, string sangria, List<string> r, int nivel) {
    int n = GetMenuItemCount(m);
    for (int i = 0; i < n && i < 80; i++) {
      var s = new StringBuilder(256); GetMenuString(m, i, s, 256, 0x400);
      IntPtr sub = GetSubMenu(m, i);
      r.Add(sangria + "[" + i + "] " + Limpio(s.ToString()) + (sub == IntPtr.Zero ? " id=" + GetMenuItemID(m, i) : " >"));
      if (sub != IntPtr.Zero && nivel < 3) Menu(sub, sangria + "    ", r, nivel + 1);
    }
  }

  // Botones de una barra (ToolbarWindow32 / TToolBar): id, texto y posición. Lee la memoria del otro programa.
  static List<string> BotonesBarra(IntPtr tb, int pid, RECT wr) {
    var r = new List<string>();
    int n = SendMessage(tb, 0x0418, IntPtr.Zero, IntPtr.Zero).ToInt32();   // TB_BUTTONCOUNT
    r.Add("   BARRA h=" + tb.ToInt64() + " botones=" + n);
    if (n <= 0 || n > 200) return r;
    IntPtr proc = OpenProcess(0x0438, false, pid);
    if (proc == IntPtr.Zero) { r.Add("     (no pude leer la barra: sin permiso)"); return r; }
    IntPtr mem = VirtualAllocEx(proc, IntPtr.Zero, 1024, 0x1000, 0x04);
    try {
      RECT tr; GetWindowRect(tb, out tr);
      for (int i = 0; i < n; i++) {
        byte[] b = new byte[32]; IntPtr leidos;
        SendMessage(tb, 0x0417, new IntPtr(i), mem);                       // TB_GETBUTTON → TBBUTTON
        ReadProcessMemory(proc, mem, b, 32, out leidos);
        int idCmd = BitConverter.ToInt32(b, 4); byte estado = b[8], estilo = b[9];
        SendMessage(tb, 0x041D, new IntPtr(i), mem);                       // TB_GETITEMRECT
        byte[] rb = new byte[16]; ReadProcessMemory(proc, mem, rb, 16, out leidos);
        int l = BitConverter.ToInt32(rb, 0), t = BitConverter.ToInt32(rb, 4), rr = BitConverter.ToInt32(rb, 8), bb = BitConverter.ToInt32(rb, 12);
        string texto = "";
        int len = SendMessage(tb, 0x044B, new IntPtr(idCmd), IntPtr.Zero).ToInt32();   // TB_GETBUTTONTEXTW
        if (len > 0 && len < 400) {
          SendMessage(tb, 0x044B, new IntPtr(idCmd), mem);
          byte[] tbuf = new byte[(len + 1) * 2]; ReadProcessMemory(proc, mem, tbuf, tbuf.Length, out leidos);
          texto = Encoding.Unicode.GetString(tbuf, 0, len * 2);
        }
        r.Add("     boton[" + i + "] id=" + idCmd + " estado=0x" + estado.ToString("X2") + " estilo=0x" + estilo.ToString("X2") +
              " rect=" + l + "," + t + "-" + rr + "," + bb + " (en ventana " + (tr.L - wr.L + (l + rr) / 2) + "," + (tr.T - wr.T + (t + bb) / 2) + ") texto=[" + Limpio(texto) + "]");
      }
    } finally { VirtualFreeEx(proc, mem, 0, 0x8000); CloseHandle(proc); }
    return r;
  }
}
'@

if ($SoloFunciones) { return }

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'logs') | Out-Null
$Salida = Join-Path $Dir 'logs\grabacion_comercial.txt'
function Anotar([string]$m) { Add-Content -Path $Salida -Value $m -Encoding UTF8 }
Set-Content -Path $Salida -Value ('Grabación de ventanas de Comercial ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8

Write-Host ''
Write-Host '=== Grabando ventanas de CONTPAQi Comercial ===' -ForegroundColor Cyan
Write-Host 'Haz a mano lo que te pidieron, despacio (espera 2 segundos en cada pantalla).'
Write-Host 'Para los datos del gasto: abre un GASTOS EN PESOS ya guardado y pasa por las'
Write-Host 'pestañas 3 Información Adicional y 6 Usuario (un clic en cada una).'
Write-Host 'No graba teclas ni clics, ni lo que escribes en usuario/clave.'
Write-Host 'Cuando termines, regresa a esta ventana y da Enter.' -ForegroundColor Yellow
Write-Host ''

$vistas = @{}; $abiertas = @{}
$fin = (Get-Date).AddMinutes($Minutos)
while ((Get-Date) -lt $fin) {
  if ([Console]::KeyAvailable) { $k = [Console]::ReadKey($true); if ($k.Key -eq 'Enter') { break } }
  $pids = New-Object 'System.Collections.Generic.HashSet[int]'
  $rutas = @{}
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'Comercial|CONTPAQ|Compac|AdminPAQ' -or $_.MainWindowTitle -match 'CONTPAQ' })) {
    [void]$pids.Add($p.Id)
    try { $rutas[$p.Id] = $p.ProcessName + ' (' + $p.Path + ')' } catch { $rutas[$p.Id] = $p.ProcessName }
  }
  $ahora = @{}
  if ($pids.Count) {
    foreach ($w in [Grab]::Ventanas($pids)) {
      $ahora[[string]$w] = $true
      try {
        $firma = [Grab]::Firma($w)
        if (-not $vistas.ContainsKey($firma)) {
          $vistas[$firma] = $true
          Start-Sleep -Milliseconds 600      # deja que termine de dibujarse
          $enc = [Grab]::Encabezado($w)
          $pidW = [int](($enc -replace '.* pid=(\d+) .*', '$1'))
          Anotar ''
          Anotar ((Get-Date -Format 'HH:mm:ss') + ' VENTANA ' + $enc + ' programa=' + $rutas[$pidW])
          [Grab]::Describir($w) | ForEach-Object { Anotar $_ }
          Write-Host ((Get-Date -Format 'HH:mm:ss') + '  anotada: ' + ($enc -replace ' pid=.*', '')) -ForegroundColor Green
        }
        if (-not $abiertas.ContainsKey([string]$w)) { $abiertas[[string]$w] = ($enc = [Grab]::Encabezado($w)) }
      } catch { }
    }
  }
  foreach ($k in @($abiertas.Keys)) {
    if (-not $ahora.ContainsKey($k)) { Anotar ((Get-Date -Format 'HH:mm:ss') + ' SE CERRÓ ' + ($abiertas[$k] -replace ' pid=.*', '')); $abiertas.Remove($k) }
  }
  Start-Sleep -Milliseconds 700
}
Anotar ''
Anotar ('Fin ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' - ventanas distintas: ' + $vistas.Count)
Write-Host ''
Write-Host ('LISTO: ' + $vistas.Count + ' ventanas anotadas en ' + $Salida) -ForegroundColor Green
