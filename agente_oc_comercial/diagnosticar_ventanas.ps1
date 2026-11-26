<#
  Diagnóstico (oct-2026): con la ventana que se quiere automatizar abierta
  ("Ingreso a CONTPAQ i COMERCIAL", o en Comercial "Convertir a GASTOS EN
  PESOS"), anota cómo está hecha (tipo de ventana y de cada control) para
  que el agente la pueda contestar solo. NO lee lo escrito en las cajas
  de texto (ni usuario ni clave): solo tipos, botones y etiquetas.
#>
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Salida = Join-Path $Dir 'logs\diagnostico_ventanas.txt'
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'logs') | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DiagVent {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, StringBuilder l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  // Texto de controles de OTRO programa (WM_GETTEXT); GetWindowText no lo lee.
  static string TextoControl(IntPtr h) { var s = new StringBuilder(512); SendMessage(h, 0x000D, new IntPtr(512), s); return s.ToString(); }
  static string Clase(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string Texto(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static List<string> Describe(int[] pids) {
    var r = new List<string>();
    var set = new HashSet<int>(pids);
    var tops = new List<IntPtr>();
    EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p); if (set.Contains(p) && IsWindowVisible(h)) tops.Add(h); return true; }, IntPtr.Zero);
    foreach (var t in tops) {
      int p; GetWindowThreadProcessId(t, out p);
      string titulo = Texto(t);
      RECT wr; GetWindowRect(t, out wr);
      // En las ventanas de Ingreso (usuario/clave) NO se lee lo escrito; en las de documentos sí (serie, folio, fechas).
      bool esIngreso = titulo.IndexOf("Ingreso", StringComparison.OrdinalIgnoreCase) >= 0 || Clase(t) == "ThunderDFrame";
      r.Add("VENTANA pid=" + p + " clase=[" + Clase(t) + "] titulo=[" + titulo + "] pos=" + wr.L + "," + wr.T + " tam=" + (wr.R - wr.L) + "x" + (wr.B - wr.T));
      EnumChildWindows(t, (c, l) => {
        if (!IsWindowVisible(c)) return true;
        string cl = Clase(c);
        bool esCaja = cl.ToUpperInvariant().Contains("EDIT") || cl.ToUpperInvariant().Contains("TEXT") || cl.ToUpperInvariant().Contains("MASCARA") || cl.Contains("DateTime") || cl.Contains("Combo");
        int estilo = GetWindowLong(c, -16);
        bool clave = (estilo & 0x20) != 0;
        string tx = esCaja ? ((esIngreso || clave) ? "(no se lee)" : TextoControl(c)) : Texto(c);
        RECT cr; GetWindowRect(c, out cr);
        r.Add("   control clase=[" + cl + "] h=" + c.ToInt64() + " pos=" + (cr.L - wr.L) + "," + (cr.T - wr.T) + " tam=" + (cr.R - cr.L) + "x" + (cr.B - cr.T) +
              " padre=" + (GetParent(c) == t ? "ventana" : "otro") + " texto=[" + tx + "]");
        return true;
      }, IntPtr.Zero);
    }
    return r;
  }
}
'@

$procs = @(Get-Process -Name 'EXCEL' -ErrorAction SilentlyContinue)
$lineas = @('Diagnóstico ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), ('Excel abiertos: ' + $procs.Count))
if ($procs.Count) { $lineas += [DiagVent]::Describe([int[]]($procs | ForEach-Object { $_.Id })) }
# También CONTPAQi Comercial (para automatizar "Convertir a GASTOS EN PESOS")
# y otros procesos cuyo título mencione CONTPAQ.
Get-Process | Where-Object { $_.ProcessName -ne 'EXCEL' -and ($_.ProcessName -match 'Comercial|CONTPAQ' -or $_.MainWindowTitle -match 'CONTPAQ|Ingreso') } | ForEach-Object {
  $lineas += ('OTRO PROGRAMA: ' + $_.ProcessName + ' pid=' + $_.Id + ' titulo=[' + $_.MainWindowTitle + ']')
  $lineas += [DiagVent]::Describe([int[]]@($_.Id))
}
$lineas | Set-Content -Path $Salida -Encoding UTF8
$lineas | ForEach-Object { Write-Host $_ }
