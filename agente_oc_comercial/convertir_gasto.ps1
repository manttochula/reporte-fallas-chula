<#
  Conversión de OC a GASTOS EN PESOS en CONTPAQi Comercial (nov-2026, Carlos).
  Nov-2026: también OC VRZ (lista ORDEN DE COMPRA VRZ) → COMPRA EN PESOS, con
  los mismos datos; la tecla de "Convertir a COMPRA EN PESOS" se busca y se
  recuerda en logs\conversion_teclas.json. La primera se hace en modo prueba.
  Hace lo mismo que se hace a mano:
    lista ORDEN DE COMPRA GENERALES → "Abrir el documento" serie/folio →
    Ctrl+2 (Convertir a GASTOS EN PESOS) → Fecha = fecha de la factura,
    Recepción = fecha de entrega cotizada → Aceptar → Continuar →
    en el gasto: Serie y Folio de la factura → Guardar.
  Seguridad:
    - Solo corre con la sesión de Windows DESBLOQUEADA.
    - Automático: solo si el mouse/teclado llevan 10 min sin usarse; si
      alguien mueve el mouse a media conversión, se detiene y lo reporta.
    - Antes de cada paso que no se puede deshacer (Aceptar y Guardar) lee lo
      que quedó escrito en Comercial y, si no coincide, cancela.
    - Con -Probar pregunta antes de Aceptar y antes de Guardar.
  Si Comercial no está abierto, lo abre (acceso directo del escritorio), entra
  con el usuario/clave de guardar_clave_contpaqi (la clave se escribe directo
  en el campo de clave de la ventana de Ingreso, nunca con teclas), cierra los
  tips, Contabilidad → Cancelar, abre la empresa y la lista de ORDEN DE COMPRA
  GENERALES. Si Comercial tiene documentos o avisos abiertos (y nadie ha usado
  la PC), lo cierra y lo vuelve a abrir (decisión de Carlos, 2-nov-2026).
  Aceptar y Guardar = F8 (lo dice el aviso del botón: "Guardar Documento <F8>").
  Uso (lo llama agente_oc_comercial.ps1): -Trabajo trabajo.json -Resultado resultado.json -Config agente_oc_config.json [-Forzar] [-Probar]
#>
param([string]$Trabajo, [string]$Resultado, [string]$Config = '', [switch]$Forzar, [switch]$Probar, [int]$MinutosLibre = 10, [string]$Log = '', [switch]$SoloFunciones)
$ErrorActionPreference = 'Stop'
$INV = [Globalization.CultureInfo]::InvariantCulture

if ($SoloFunciones) { try { Add-Type -AssemblyName System.Windows.Forms } catch { } } else { Add-Type -AssemblyName System.Windows.Forms }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Cmx {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] static extern IntPtr SendMessageStr(IntPtr h, int msg, IntPtr w, string l);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll")] static extern int GetMenuItemID(IntPtr m, int pos);
  [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr m, int pos);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr m, int pos, StringBuilder s, int n, int flags);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int acc, bool inh, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr p, out bool w);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr a, int size, int type, int prot);
  [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr p, IntPtr a, int size, int type);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr p, IntPtr a, byte[] b, int size, out IntPtr n);
  [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr p, IntPtr a, byte[] b, int size, out IntPtr n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, int flags, IntPtr extra);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(int a, int b, bool attach);
  [DllImport("kernel32.dll")] static extern int GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetFocus();
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public int cbSize; public int dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(int flags, bool inherit, int access);
  [DllImport("user32.dll")] static extern bool SwitchDesktop(IntPtr d);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr d);

  public class Ctl { public IntPtr H; public string Cls; public int X, Y, W, Hgt; public bool Vis; public string Text; public bool Clave; }
  // Solo se lee el texto de cajas, etiquetas y botones. NO de tablas ni campos de base de datos ocultos
  // (TMCCDbGrid, TMCCDbCampo, TMCCDbStaticText): al pedirles su texto, Comercial consulta su base de datos
  // dentro de nuestra llamada y truena con "No se puede hacer una llamada de salida..." (2-nov-2026).
  public static bool SeLee(string cl) {
    string u = cl.ToUpperInvariant();
    if (u.Contains("GRID") || u.Contains("CAMPO") || u.Contains("DBSTATIC") || u.Contains("PAGECONTROL") || u.Contains("LISTVIEW") || u.Contains("OUTBAR") || u.Contains("TOOLBAR") || u.Contains("STATUSBAR")) return false;
    return u.Contains("EDIT") || u.Contains("MASCARA") || u.Contains("STATIC") || u.Contains("BUTTON") || u.Contains("BITBTN") || u.Contains("CHECKBOX") || u.Contains("LABEL") || u.Contains("COMBO") || u.Contains("DATETIME") || u.Contains("PANEL") || u.Contains("TABSHEET") || u == "#32770";
  }
  public static string Clase(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Titulo(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Texto(IntPtr h) { var s = new StringBuilder(1024); SendMessage(h, 0x000D, new IntPtr(1024), s); return s.ToString(); }
  public static int Pid(IntPtr h) { int p; GetWindowThreadProcessId(h, out p); return p; }

  // Ventanas visibles de nivel superior de un proceso.
  public static List<IntPtr> Ventanas(int pid) {
    var l = new List<IntPtr>();
    EnumWindows((h, x) => { int p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
  // Controles visibles con su posición relativa a la ventana.
  public static List<Ctl> Controles(IntPtr w) {
    var l = new List<Ctl>(); RECT wr; GetWindowRect(w, out wr);
    EnumChildWindows(w, (c, x) => {
      if (!IsWindowVisible(c)) return true;
      RECT r; GetWindowRect(c, out r);
      string cl = Clase(c);
      // Campo de contraseña (ES_PASSWORD): nunca se lee.
      bool clave = (GetWindowLong(c, -16) & 0x20) != 0 && cl.ToUpperInvariant().Contains("EDIT");
      l.Add(new Ctl { H = c, Cls = cl, X = r.L - wr.L, Y = r.T - wr.T, W = r.R - r.L, Hgt = r.B - r.T, Vis = true, Text = (clave || !SeLee(cl)) ? "" : Texto(c), Clave = clave });
      return true;
    }, IntPtr.Zero);
    return l;
  }
  public static bool Activar(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    if (GetForegroundWindow() == h) return true;
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(150);
    if (GetForegroundWindow() == h) return true;
    keybd_event(0x12, 0, 0, IntPtr.Zero); keybd_event(0x12, 0, 2, IntPtr.Zero);   // Alt: permite traer la ventana al frente
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(250);
    return GetForegroundWindow() == h;
  }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize, flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(int tid, ref GUITHREADINFO i);
  // Qué control tiene el cursor en el programa (sin mandarle mensajes).
  public static IntPtr Foco(IntPtr cualquiera) {
    int pid; int tid = GetWindowThreadProcessId(cualquiera, out pid);
    var g = new GUITHREADINFO(); g.cbSize = Marshal.SizeOf(g);
    return GetGUIThreadInfo(tid, ref g) ? g.hwndFocus : IntPtr.Zero;
  }
  // Poner el cursor en un campo con un clic mandado por mensaje (PostMessage), como lo haría la persona.
  // NO usar SetFocus desde aquí en documentos: al salir del campo anterior Comercial lo valida contra su
  // base de datos y, si el cambio de campo viene de otro programa, truena con
  // "LeerEstadoCursor / No se puede hacer una llamada de salida..." (2-nov-2026).
  public static bool EnfocarClic(IntPtr ctl) {
    if (Foco(ctl) == ctl) return true;
    IntPtr lp = new IntPtr((4 << 16) | 4);
    PostMessage(ctl, 0x0201, new IntPtr(1), lp); PostMessage(ctl, 0x0202, IntPtr.Zero, lp);
    for (int i = 0; i < 20; i++) { System.Threading.Thread.Sleep(100); if (Foco(ctl) == ctl) return true; }
    return false;
  }
  public static bool Enfocar(IntPtr ctl) {
    int pid; int tid = GetWindowThreadProcessId(ctl, out pid); int yo = GetCurrentThreadId();
    AttachThreadInput(yo, tid, true);
    SetFocus(ctl);
    bool ok = GetFocus() == ctl;
    AttachThreadInput(yo, tid, false);
    return ok;
  }
  public static int SegundosLibre() {
    var i = new LASTINPUTINFO(); i.cbSize = Marshal.SizeOf(i); GetLastInputInfo(ref i);
    return (int)((uint)Environment.TickCount - (uint)i.dwTime) / 1000;
  }
  public static bool SesionBloqueada() {
    IntPtr d = OpenInputDesktop(0, false, 0x0100);
    if (d == IntPtr.Zero) return true;
    bool ok = SwitchDesktop(d); CloseDesktop(d);
    return !ok;
  }
  // BM_CLICK con PostMessage (no SendMessage): si el clic hace que Comercial llame a su base de datos (COM)
  // dentro de un SendMessage de otro programa, truena con "No se puede hacer una llamada de salida..." (2-nov).
  public static void Clic(IntPtr boton) { PostMessage(boton, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
  public static void Cerrar(IntPtr w) { PostMessage(w, 0x0010, IntPtr.Zero, IntPtr.Zero); }        // WM_CLOSE
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int MessageBoxW(IntPtr h, string t, string c, int tipo);
  // Pregunta Sí/No encima de todo (MB_YESNO|ICONQUESTION|DEFBUTTON2|SETFOREGROUND|TOPMOST). 6 = Sí.
  public static int Preguntar(string texto, string titulo) { return MessageBoxW(IntPtr.Zero, texto, titulo, 0x4 | 0x20 | 0x100 | 0x10000 | 0x40000); }
  // Largo del texto (WM_GETTEXTLENGTH): sirve para saber si la clave quedó escrita sin leerla.
  public static int Largo(IntPtr ctl) { return (int)SendMessage(ctl, 0x000E, IntPtr.Zero, IntPtr.Zero).ToInt64(); }
  // Letras mandadas SOLO a ese campo (WM_CHAR a su ventana): no dependen de qué ventana esté al frente.
  public static void Letras(IntPtr ctl, string t) { foreach (char c in t) { PostMessage(ctl, 0x0102, new IntPtr(c), new IntPtr(1)); } }
  // Enter mandado SOLO a ese campo (botón predeterminado = Aceptar).
  public static void EnterEn(IntPtr ctl) { PostMessage(ctl, 0x0100, new IntPtr(0x0D), new IntPtr(0x001C0001)); PostMessage(ctl, 0x0101, new IntPtr(0x0D), new IntPtr(unchecked((int)0xC01C0001))); }
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, int acc, out IntPtr t);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr t, int clase, out int valor, int largo, out int ret);
  // ¿El programa corre "como administrador"? Si no se puede abrir su token desde aquí, también cuenta como sí.
  public static bool Elevado(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid); if (p == IntPtr.Zero) return true;
    try {
      IntPtr t; if (!OpenProcessToken(p, 0x0008, out t)) return true;
      try { int v, r; return GetTokenInformation(t, 20, out v, 4, out r) ? v != 0 : true; } finally { CloseHandle(t); }
    } finally { CloseHandle(p); }
  }
  // Tecla mandada SOLO a ese control (WM_KEYDOWN/UP a su ventana), sin depender de la ventana al frente.
  public static void Tecla(IntPtr ctl, int vk) { PostMessage(ctl, 0x0100, new IntPtr(vk), new IntPtr(1)); PostMessage(ctl, 0x0101, new IntPtr(vk), new IntPtr(unchecked((int)0xC0000001))); System.Threading.Thread.Sleep(60); }
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  // Botones de una barra (TToolBar = ToolbarWindow32): "índice|id|texto" de cada uno (lee la memoria de Comercial).
  public static List<string> TbBotones(IntPtr tb) {
    var r = new List<string>();
    int n = (int)SendMessage(tb, 0x0418, IntPtr.Zero, IntPtr.Zero).ToInt64();   // TB_BUTTONCOUNT
    if (n <= 0 || n > 200) return r;
    IntPtr proc = OpenProcess(0x0438, false, Pid(tb)); if (proc == IntPtr.Zero) return r;
    IntPtr mem = VirtualAllocEx(proc, IntPtr.Zero, 1024, 0x1000, 0x04);
    try {
      for (int i = 0; i < n; i++) {
        IntPtr x; byte[] b = new byte[32];
        SendMessage(tb, 0x0417, new IntPtr(i), mem);                     // TB_GETBUTTON → idCommand en +4
        ReadProcessMemory(proc, mem, b, 32, out x);
        int id = BitConverter.ToInt32(b, 4);
        string texto = "";
        int len = (int)SendMessage(tb, 0x044B, new IntPtr(id), IntPtr.Zero).ToInt64();   // TB_GETBUTTONTEXTW
        if (len > 0 && len < 400) {
          SendMessage(tb, 0x044B, new IntPtr(id), mem);
          byte[] t = new byte[(len + 1) * 2]; ReadProcessMemory(proc, mem, t, t.Length, out x);
          texto = Encoding.Unicode.GetString(t, 0, len * 2);
        }
        r.Add(i + "|" + id + "|" + texto);
      }
    } finally { VirtualFreeEx(proc, mem, 0, 0x8000); CloseHandle(proc); }
    return r;
  }
  // Rectángulo de cada botón de la barra (por posición; no necesita el nombre): "índice|izq|arriba|der|abajo".
  public static List<string> TbRects(IntPtr tb) {
    var r = new List<string>();
    int n = (int)SendMessage(tb, 0x0418, IntPtr.Zero, IntPtr.Zero).ToInt64();
    if (n <= 0 || n > 200) return r;
    IntPtr proc = OpenProcess(0x0438, false, Pid(tb)); if (proc == IntPtr.Zero) return r;
    IntPtr mem = VirtualAllocEx(proc, IntPtr.Zero, 64, 0x1000, 0x04);
    try {
      for (int i = 0; i < n; i++) {
        IntPtr x; WriteProcessMemory(proc, mem, new byte[16], 16, out x);
        SendMessage(tb, 0x041D, new IntPtr(i), mem);                       // TB_GETITEMRECT
        byte[] b = new byte[16]; ReadProcessMemory(proc, mem, b, 16, out x);
        r.Add(i + "|" + BitConverter.ToInt32(b, 0) + "|" + BitConverter.ToInt32(b, 4) + "|" + BitConverter.ToInt32(b, 8) + "|" + BitConverter.ToInt32(b, 12));
      }
    } finally { VirtualFreeEx(proc, mem, 0, 0x8000); CloseHandle(proc); }
    return r;
  }
  // Clic por mensaje en la pestaña i de un TPageControl (TCM_GETITEMRECT). false si no existe.
  public static bool TabClic(IntPtr pc, int i) {
    int n = (int)SendMessage(pc, 0x1304, IntPtr.Zero, IntPtr.Zero).ToInt64();   // TCM_GETITEMCOUNT
    if (i >= n) return false;
    IntPtr proc = OpenProcess(0x0438, false, Pid(pc)); if (proc == IntPtr.Zero) return false;
    IntPtr mem = VirtualAllocEx(proc, IntPtr.Zero, 64, 0x1000, 0x04);
    try {
      IntPtr x; byte[] b = new byte[16];
      if (SendMessage(pc, 0x130A, new IntPtr(i), mem) == IntPtr.Zero) return false;   // TCM_GETITEMRECT
      ReadProcessMemory(proc, mem, b, 16, out x);
      ClicEn(pc, (BitConverter.ToInt32(b, 0) + BitConverter.ToInt32(b, 8)) / 2, (BitConverter.ToInt32(b, 4) + BitConverter.ToInt32(b, 12)) / 2);
      return true;
    } finally { VirtualFreeEx(proc, mem, 0, 0x8000); CloseHandle(proc); }
  }
  // Clic de mouse por mensaje en (x,y) de la barra, sin mover el mouse.
  public static void ClicEn(IntPtr h, int x, int y) {
    IntPtr lp = new IntPtr((y << 16) | (x & 0xFFFF));
    PostMessage(h, 0x0200, IntPtr.Zero, lp); System.Threading.Thread.Sleep(80);
    PostMessage(h, 0x0201, new IntPtr(1), lp); System.Threading.Thread.Sleep(120);
    PostMessage(h, 0x0202, IntPtr.Zero, lp);
  }
  // Clic en un botón de la barra: WM_COMMAND con su id al padre de la barra (como lo manda la barra al soltar el clic).
  public static void TbClic(IntPtr tb, int id) { PostMessage(GetParent(tb), 0x0111, new IntPtr(id & 0xFFFF), tb); }
  // Selecciona todo el campo (EM_SETSEL) y lo borra (Retroceso), con mensajes al campo.
  public static void Borrar(IntPtr ctl) { PostMessage(ctl, 0x00B1, IntPtr.Zero, new IntPtr(-1)); PostMessage(ctl, 0x0102, new IntPtr(8), new IntPtr(1)); }
  public static void PonerTexto(IntPtr ctl, string t) { SendMessageStr(ctl, 0x000C, IntPtr.Zero, t); }  // WM_SETTEXT directo al campo
  public static void Comando(IntPtr w, int id) { PostMessage(w, 0x0111, new IntPtr(id), IntPtr.Zero); } // WM_COMMAND (opción de menú)

  // Opción del menú de la ventana por su texto (sin "&" ni el atajo). 0 = no está.
  public static int BuscarMenu(IntPtr w, string texto) { IntPtr m = GetMenu(w); return m == IntPtr.Zero ? 0 : BuscarMenu_(m, texto.ToUpperInvariant(), 0); }
  static int BuscarMenu_(IntPtr m, string texto, int nivel) {
    int n = GetMenuItemCount(m);
    for (int i = 0; i < n; i++) {
      var s = new StringBuilder(256); GetMenuString(m, i, s, 256, 0x400);
      string t = s.ToString().Split('\t')[0].Replace("&", "").Trim().ToUpperInvariant();
      IntPtr sub = GetSubMenu(m, i);
      if (sub == IntPtr.Zero) { if (t == texto) return GetMenuItemID(m, i); }
      else if (nivel < 3) { int r = BuscarMenu_(sub, texto, nivel + 1); if (r != 0) return r; }
    }
    return 0;
  }

  // Barra izquierda (TDCOutBarVertListView): se intenta leer como ListView.
  public static int LvCuenta(IntPtr lv) { return (int)SendMessage(lv, 0x1004, IntPtr.Zero, IntPtr.Zero).ToInt64(); }   // LVM_GETITEMCOUNT
  public static List<string> LvTextos(IntPtr lv) {
    var r = new List<string>(); int n = LvCuenta(lv); if (n <= 0 || n > 500) return r;
    IntPtr proc = OpenProcess(0x0438, false, Pid(lv)); if (proc == IntPtr.Zero) return r;
    IntPtr mem = VirtualAllocEx(proc, IntPtr.Zero, 2048, 0x1000, 0x04);
    try {
      bool wow; IsWow64Process(proc, out wow);
      bool de32 = wow || IntPtr.Size == 4;
      IntPtr buf = new IntPtr(mem.ToInt64() + 512); IntPtr x;
      for (int i = 0; i < n; i++) {
        byte[] it = new byte[64];
        BitConverter.GetBytes(1).CopyTo(it, 0);              // mask = LVIF_TEXT
        BitConverter.GetBytes(i).CopyTo(it, 4);
        if (de32) { BitConverter.GetBytes((int)buf.ToInt64()).CopyTo(it, 20); BitConverter.GetBytes(255).CopyTo(it, 24); }
        else { BitConverter.GetBytes(buf.ToInt64()).CopyTo(it, 24); BitConverter.GetBytes(255).CopyTo(it, 32); }
        WriteProcessMemory(proc, mem, it, 64, out x);
        int len = (int)SendMessage(lv, 0x1073, new IntPtr(i), mem).ToInt64();   // LVM_GETITEMTEXTW
        byte[] tb = new byte[512]; ReadProcessMemory(proc, buf, tb, 512, out x);
        r.Add(len > 0 && len < 255 ? Encoding.Unicode.GetString(tb, 0, len * 2) : "");
      }
    } finally { VirtualFreeEx(proc, mem, 0, 0x8000); CloseHandle(proc); }
    return r;
  }
  // Clic (mensaje, sin mover el mouse) en el elemento i.
  public static bool LvClic(IntPtr lv, int i) {
    SendMessage(lv, 0x1013, new IntPtr(i), IntPtr.Zero);   // LVM_ENSUREVISIBLE
    IntPtr proc = OpenProcess(0x0438, false, Pid(lv)); if (proc == IntPtr.Zero) return false;
    IntPtr mem = VirtualAllocEx(proc, IntPtr.Zero, 64, 0x1000, 0x04);
    try {
      IntPtr x; WriteProcessMemory(proc, mem, new byte[16], 16, out x);   // left = LVIR_BOUNDS
      if (SendMessage(lv, 0x100E, new IntPtr(i), mem) == IntPtr.Zero) return false;   // LVM_GETITEMRECT
      byte[] b = new byte[16]; ReadProcessMemory(proc, mem, b, 16, out x);
      int cx = (BitConverter.ToInt32(b, 0) + BitConverter.ToInt32(b, 8)) / 2, cy = (BitConverter.ToInt32(b, 4) + BitConverter.ToInt32(b, 12)) / 2;
      IntPtr lp = new IntPtr((cy << 16) | (cx & 0xFFFF));
      PostMessage(lv, 0x0201, new IntPtr(1), lp); PostMessage(lv, 0x0202, IntPtr.Zero, lp);
      return true;
    } finally { VirtualFreeEx(proc, mem, 0, 0x8000); CloseHandle(proc); }
  }
}
'@

# ------------------------------------------------------------------
function Write-L([string]$m) { if ($Log) { Add-Content -Path $Log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  [gasto] ' + $m) -Encoding UTF8 } }
class PasoError : Exception { [string]$Paso; [bool]$Esperar; PasoError([string]$paso, [string]$m, [bool]$esperar) : base($m) { $this.Paso = $paso; $this.Esperar = $esperar } }
function Falla([string]$paso, [string]$m) { throw [PasoError]::new($paso, $m, $false) }
function Espera([string]$paso, [string]$m) { throw [PasoError]::new($paso, $m, $true) }

$script:Cursor = $null
function Guardar-Cursor { $p = New-Object Cmx+POINT; [void][Cmx]::GetCursorPos([ref]$p); $script:Cursor = $p }
# Si alguien movió el mouse desde el último paso, se detiene.
function Revisar-Usuario([string]$paso) {
  if ($Probar) { return }
  $p = New-Object Cmx+POINT; [void][Cmx]::GetCursorPos([ref]$p)
  if ($script:Cursor -and ($p.X -ne $script:Cursor.X -or $p.Y -ne $script:Cursor.Y)) { Falla $paso 'Alguien empezó a usar la computadora a media conversión; me detuve.' }
}
function Esperar-Ventana([int]$procId, [string]$clase, [string]$titulo, [int]$segundos) {
  $fin = (Get-Date).AddSeconds($segundos)
  while ((Get-Date) -lt $fin) {
    foreach ($w in [Cmx]::Ventanas($procId)) {
      if ((-not $clase -or [Cmx]::Clase($w) -eq $clase) -and (-not $titulo -or [Cmx]::Titulo($w) -like $titulo)) { return $w }
    }
    Start-Sleep -Milliseconds 250
  }
  return [IntPtr]::Zero
}
# Avisos de Comercial (#32770) que aparecieron: su texto.
function Leer-Avisos([int]$procId) {
  $t = @()
  foreach ($w in [Cmx]::Ventanas($procId)) {
    if ([Cmx]::Clase($w) -eq '#32770') { $t += ([Cmx]::Titulo($w) + ': ' + ((([Cmx]::Controles($w) | Where-Object { $_.Cls -eq 'Static' -and $_.Text }) | ForEach-Object { $_.Text }) -join ' ')) }
  }
  return $t
}
# Escribe en un campo de Comercial y confirma leyendo lo que quedó.
function Escribir-Campo([IntPtr]$hwnd, [IntPtr]$ctl, [string]$valor, [string]$paso, [scriptblock]$comparar) {
  if (-not [Cmx]::Activar($hwnd)) { Falla $paso 'No pude traer al frente la ventana de Comercial.' }
  foreach ($intento in 1..2) {
    if (-not [Cmx]::EnfocarClic($ctl)) { Falla $paso 'No pude poner el cursor en el campo (clic).' }
    # Letras mandadas al campo (WM_CHAR), no al teclado: respetan mayúsculas aunque esté Bloq Mayús
    # (con teclas, "SB" quedaba "sb") y no caen en otra ventana.
    $txt = if ($intento -eq 1) { $valor } else { $valor -replace '[^0-9A-Za-z]', '' }   # 2º intento: sin "/" (campos con máscara)
    [Cmx]::Borrar($ctl)
    Start-Sleep -Milliseconds 150
    [Cmx]::Letras($ctl, $txt)
    Start-Sleep -Milliseconds 400
    $leido = [Cmx]::Texto($ctl)
    if (& $comparar $leido) { return $leido }
  }
  Falla $paso ('El campo quedó con "' + $leido + '" en vez de "' + $valor + '".')
}
function Get-NombreNormal([string]$t) {
  $n = $t.Normalize([Text.NormalizationForm]::FormD); $sb = New-Object Text.StringBuilder
  foreach ($c in $n.ToCharArray()) { if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($c) -ne 'NonSpacingMark') { [void]$sb.Append($c) } }
  return (($sb.ToString().ToUpperInvariant() -replace '[^A-Z0-9]+', ' ').Trim())
}
# El título de Comercial dice "[Empresa: CHULA BRAND MEXICO]"; el sistema puede traer acentos o "S.A. de C.V.".
function Es-MismaEmpresa([string]$tituloMenu, [string]$empresa) {
  if ($tituloMenu -notmatch 'Empresa:\s*([^\]]+)') { return $false }
  $a = Get-NombreNormal $Matches[1]; $b = Get-NombreNormal $empresa
  return ($a -and $b -and ($a -eq $b -or $b.StartsWith($a + ' ') -or $a.StartsWith($b + ' ')))
}
# Fechas de Comercial: encima de la caja hay un calendario (TDateTimePicker) que es el
# que recibe las teclas. Se llena por partes (día/mes/año con flechas): primero día 01
# para que no choque con meses cortos, luego mes y año, al final el día. Tab para que
# Comercial lo pase a la caja, y se confirma leyendo la caja y el calendario.
function Teclas-Fecha([string]$ddmmyyyy) {
  $p = $ddmmyyyy.Split('/')
  return '{LEFT}{LEFT}{LEFT}01{RIGHT}' + $p[1] + '{RIGHT}' + $p[2] + '{LEFT}{LEFT}' + $p[0]
}
function Escribir-Fecha([IntPtr]$hwnd, $caja, [string]$valor, [string]$paso) {
  $cal = [Cmx]::Controles($hwnd) | Where-Object { $_.Cls -match 'DateTimePicker' -and [math]::Abs($_.X - $caja.X) -le 3 -and [math]::Abs($_.Y - $caja.Y) -le 3 } | Select-Object -First 1
  if (-not $cal) { return (Escribir-Campo $hwnd $caja.H $valor $paso { param($t) $t -eq $valor }) }
  if (-not [Cmx]::Activar($hwnd)) { Falla $paso 'No pude traer al frente la ventana de Comercial.' }
  if (-not [Cmx]::Enfocar($cal.H)) { Falla $paso 'No pude poner el cursor en la fecha.' }
  # 1) La fecha en el calendario, por partes.
  [System.Windows.Forms.SendKeys]::SendWait((Teclas-Fecha $valor))
  Start-Sleep -Milliseconds 300
  $metodo = ''
  # 2) Como lo hace la persona: abrir el calendario (Alt+Abajo) y escoger el día (Enter).
  #    Enter solo si de verdad se abrió el calendario (si no, Enter podría hacer otra cosa en la ventana).
  if ([Cmx]::Texto($cal.H) -eq $valor) {
    [System.Windows.Forms.SendKeys]::SendWait('%{DOWN}')
    Start-Sleep -Milliseconds 600
    $mes = Ventana-De ([Cmx]::Pid($hwnd)) { param($c, $t) $c -match 'MonthCal|DropDown' }
    if ($mes -ne [IntPtr]::Zero) { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); Start-Sleep -Milliseconds 500; $metodo = 'calendario' }
    else { Write-L ('No se abrió el calendario desplegable de la fecha (clases: ' + (([Cmx]::Ventanas([Cmx]::Pid($hwnd)) | ForEach-Object { [Cmx]::Clase($_) }) -join ', ') + ').') }
  }
  # 3) Si la caja no cambió, se le pone el texto directo.
  if ([Cmx]::Texto($caja.H) -ne $valor) { [Cmx]::PonerTexto($caja.H, $valor); Start-Sleep -Milliseconds 300; $metodo = 'texto directo' }
  [void][Cmx]::Activar($hwnd)
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  Start-Sleep -Milliseconds 400
  $tCaja = [Cmx]::Texto($caja.H); $tCal = [Cmx]::Texto($cal.H)
  Write-L ('Fecha ' + $valor + ': caja "' + $tCaja + '", calendario "' + $tCal + '" (' + $metodo + ')')
  if ($tCaja -ne $valor) { Falla $paso ('La fecha quedó: caja "' + $tCaja + '", calendario "' + $tCal + '" en vez de "' + $valor + '".') }
  return $tCaja
}
# Clic en el botón de la barra de herramientas cuyo texto coincide (ej. Aceptar). $false si no lo encontró.
function Clic-BotonBarra([IntPtr]$ventana, [string]$patron) {
  $todos = @()
  foreach ($tb in @([Cmx]::Controles($ventana) | Where-Object { $_.Cls -match 'ToolBar' })) {
    $botones = @(); try { $botones = @([Cmx]::TbBotones($tb.H)) } catch { Write-L ('No pude leer la barra: ' + $_.Exception.Message) }
    foreach ($b in $botones) {
      $p = $b.Split('|', 3); $todos += ('[' + $p[0] + '] id=' + $p[1] + ' "' + $p[2] + '"')
      if (($p[2] -replace '&', '') -match $patron) { [Cmx]::TbClic($tb.H, [int]$p[1]); Write-L ('Clic en el botón "' + ($p[2] -replace '&', '') + '" de la barra.'); return $true }
    }
  }
  Write-L ('No encontré el botón ' + $patron + ' en la barra (botones: ' + ($todos -join ', ') + ').')
  return $false
}
# Botones reales de la barra (sin separadores ni ocultos), de izquierda a derecha.
function Botones-Visibles([string[]]$rects) {
  $l = @()
  foreach ($r in $rects) {
    $p = $r.Split('|') | ForEach-Object { [int]$_ }
    if (($p[3] - $p[1]) -ge 25 -and ($p[4] - $p[2]) -ge 15) { $l += [pscustomobject]@{ I = $p[0]; X = [int](($p[1] + $p[3]) / 2); Y = [int](($p[2] + $p[4]) / 2); Ancho = $p[3] - $p[1] } }
  }
  return @($l | Sort-Object X)
}
# Clic en el botón número $n (1 = el de más a la izquierda) de la barra de la ventana.
function Clic-BotonPosicion([IntPtr]$ventana, [int]$n, [int]$esperados) {
  foreach ($tb in @([Cmx]::Controles($ventana) | Where-Object { $_.Cls -match 'ToolBar' })) {
    $vis = Botones-Visibles @([Cmx]::TbRects($tb.H))
    Write-L ('Barra: ' + $vis.Count + ' botones visibles (' + (($vis | ForEach-Object { 'x=' + $_.X + ' ancho=' + $_.Ancho }) -join ', ') + ').')
    if ($vis.Count -ge $esperados) { [Cmx]::ClicEn($tb.H, $vis[$n - 1].X, $vis[$n - 1].Y); return $true }
  }
  return $false
}
# Pestaña del documento por su número (Alt+número, como el subrayado de "&3 Información Adicional").
# Si no cambia, clic por mensaje en cada pestaña hasta dar con ella.
function Pestana-Visible([IntPtr]$doc) { return ([Cmx]::Controles($doc) | Where-Object { $_.Cls -eq 'TTabSheet' } | Select-Object -First 1) }
# Nov-2026: $num también puede ser parte del NOMBRE ('Usuario'): en la OC la pestaña Usuario no es la 6.
function Ir-Pestana([IntPtr]$doc, [string]$num, [string]$paso) {
  $porNumero = $num -match '^\d+$'
  $es = if ($porNumero) { { param($t) $t -and (($t -replace '&', '').Trim() -match ('^' + $num + '\b')) } } else { { param($t) $t -and (($t -replace '&', '') -match ('(?i)' + [regex]::Escape($num))) } }
  $v = Pestana-Visible $doc
  if ($v -and (& $es $v.Text)) { return $v }
  if (-not [Cmx]::Activar($doc)) { Falla $paso 'No pude traer al frente el documento.' }
  if ($porNumero) {
    [System.Windows.Forms.SendKeys]::SendWait('%' + $num)
    Start-Sleep -Milliseconds 700
    $v = Pestana-Visible $doc
    if ($v -and (& $es $v.Text)) { return $v }
  }
  $pc = [Cmx]::Controles($doc) | Where-Object { $_.Cls -match 'PageControl' } | Select-Object -First 1
  if ($pc) {
    for ($i = 0; $i -lt 10; $i++) {
      if (-not [Cmx]::TabClic($pc.H, $i)) { break }
      Start-Sleep -Milliseconds 700
      $v = Pestana-Visible $doc
      if ($v -and (& $es $v.Text)) { return $v }
    }
  }
  Falla $paso ('No pude abrir la pestaña ' + $num + ' del documento.')
}
function Mismo-Texto([string]$a, [string]$b) { return (($a -replace '\s+', ' ').Trim().ToUpperInvariant()) -eq (($b -replace '\s+', ' ').Trim().ToUpperInvariant()) }
function Poner-Dato([IntPtr]$doc, $caja, [string]$valor, [string]$nombre, [string]$paso) {
  if (-not $valor) { return ($nombre + ': (sin dato, no se cambia)') }
  if (-not $caja) { Falla $paso ('No encontré el campo "' + $nombre + '" en el gasto.') }
  if (-not [Cmx]::Activar($doc)) { Falla $paso 'No pude traer al frente el gasto.' }
  $leido = ''
  foreach ($intento in 1..2) {
    if (-not [Cmx]::EnfocarClic($caja.H)) { Falla $paso ('No pude poner el cursor en "' + $nombre + '".') }
    [Cmx]::Borrar($caja.H); Start-Sleep -Milliseconds 150
    [Cmx]::Letras($caja.H, $valor); Start-Sleep -Milliseconds 500
    $leido = [Cmx]::Texto($caja.H)
    if (Mismo-Texto $leido $valor) { return ($nombre + ': ' + $valor) }
  }
  Falla $paso ('"' + $nombre + '" quedó "' + $leido + '" en vez de "' + $valor + '".')
}
# Referencia y Observaciones (pestaña 3); Elaboró, Forma de Pago y Póliza (pestaña 6).
# Los campos se ubican por su lugar en la pestaña (las etiquetas no se leen: son de la base de datos).
function Llenar-DatosAdicionales([IntPtr]$gas, $g, [string]$paso, [string]$tabUsuario = '6') {
  $res = @()
  if ($g.referencia -or $g.observaciones) {
    $t3 = Ir-Pestana $gas '3' $paso
    $dentro = @([Cmx]::Controles($gas) | Where-Object { $_.Y -gt $t3.Y -and $_.Y -lt ($t3.Y + 140) })
    $ref = $dentro | Where-Object { $_.Cls -eq 'TMCCDbEdit' } | Sort-Object Y, X | Select-Object -First 1
    $obs = $dentro | Where-Object { $_.Cls -match 'Memo' } | Sort-Object Y | Select-Object -First 1
    $res += Poner-Dato $gas $ref ([string]$g.referencia) 'Referencia' $paso
    $res += Poner-Dato $gas $obs ([string]$g.observaciones) 'Observaciones' $paso
  }
  if ($g.elaboro -or $g.formaPago -or $g.poliza) {
    $t6 = Ir-Pestana $gas $tabUsuario $paso
    $eds = @([Cmx]::Controles($gas) | Where-Object { $_.Cls -eq 'TMCCDbEdit' -and $_.Y -gt $t6.Y -and $_.W -ge 100 })
    $izq = @($eds | Where-Object { $_.X -lt ($t6.X + 400) } | Sort-Object Y)
    $elab = $izq | Select-Object -First 1
    $pol = if ($izq.Count -ge 2) { $izq[1] } else { $null }
    $fp = if ($elab) { $eds | Where-Object { $_.X -ge ($t6.X + 400) -and [math]::Abs($_.Y - $elab.Y) -le 6 } | Select-Object -First 1 } else { $null }
    $res += Poner-Dato $gas $elab ([string]$g.elaboro) 'Elaboró' $paso
    $res += Poner-Dato $gas $fp ([string]$g.formaPago) 'Forma de pago' $paso
    $res += Poner-Dato $gas $pol ([string]$g.poliza) 'Póliza' $paso
  }
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  Start-Sleep -Milliseconds 400
  $av = Leer-Avisos ([Cmx]::Pid($gas))
  if ($av.Count) { Falla $paso ('Comercial avisó: ' + ($av -join ' ') + ' (el gasto quedó sin guardar).') }
  Write-L ('Datos del gasto: ' + ($res -join ' · '))
  return ($res -join "`n")
}
function Fecha-Ddmmyyyy([string]$iso) { $d = [datetime]::ParseExact($iso, 'yyyy-MM-dd', $INV); return $d.ToString('dd/MM/yyyy', $INV) }
function Mismo-Folio([string]$a, [string]$b) { return (($a -replace '[^0-9]', '') -replace '^0+', '') -eq (($b -replace '[^0-9]', '') -replace '^0+', '') }
function Confirmar-Probar([string]$texto) {
  if (-not $Probar) { return }
  $r = [Cmx]::Preguntar($texto + "`n`n¿Continuar?", 'Prueba: conversión a gasto')
  Write-L ('Pregunta: "' + $texto + '" → ' + $(if ($r -eq 6) { 'Sí' } elseif ($r -eq 7) { 'No' } else { 'sin respuesta (' + $r + ')' }))
  # Si se detiene en la prueba, la OC sigue pendiente (no es error).
  if ($r -ne 6) { Espera 'Prueba' ('Detenido en la prueba (respuesta: ' + $r + ').') }
}

# Abre "Convertir a <destino>" desde la OC abierta. Prueba la tecla aprendida y
# luego Ctrl+2, Ctrl+1, Ctrl+3 (las conversiones del menú Ordenar). Si se abre
# otra conversión, la cierra sin aceptar (= Cancelar). Si una tecla abre otra
# cosa o nada, se detiene.
function Abrir-Conversion([IntPtr]$doc, [string]$dest, [int]$procId, [string]$paso) {
  $ruta = Join-Path (Split-Path -Parent $Trabajo) 'conversion_teclas.json'
  $apr = @{}
  if (Test-Path $ruta) { try { (Get-Content $ruta -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $apr[$_.Name] = [string]$_.Value } } catch { } }
  $teclas = @(); if ($apr.ContainsKey($dest)) { $teclas += $apr[$dest] }
  foreach ($k in @('2', '1', '3')) { if ($teclas -notcontains $k) { $teclas += $k } }
  $vistas = @()
  foreach ($k in $teclas) {
    if (-not [Cmx]::Activar($doc)) { Falla $paso 'No pude traer al frente la OC.' }
    $antes = @([Cmx]::Ventanas($procId))
    [System.Windows.Forms.SendKeys]::SendWait('^' + $k)
    $dlg = Esperar-Ventana $procId '' 'Convertir a *' 6
    if ($dlg -eq [IntPtr]::Zero) {
      $nuevas = @([Cmx]::Ventanas($procId) | Where-Object { $antes -notcontains $_ -and -not (Es-VentanaLibre ([Cmx]::Clase($_))) })
      $av = Leer-Avisos $procId
      [Cmx]::Cerrar($doc)
      Falla $paso ('Ctrl+' + $k + ' no abrió una conversión' + $(if ($nuevas.Count) { ' (abrió "' + (($nuevas | ForEach-Object { [Cmx]::Titulo($_) }) -join '", "') + '")' } else { '' }) + '. ' + ($av -join ' ') + ' Dime qué tecla tiene "Convertir a ' + $dest + '" en el menú Ordenar.')
    }
    $t = [Cmx]::Titulo($dlg)
    if ($t -like ('*' + $dest + '*')) {
      if ($apr[$dest] -ne $k) { $apr[$dest] = $k; try { ($apr | ConvertTo-Json) | Set-Content -Path $ruta -Encoding UTF8 } catch { } }
      Write-L ('"' + $t + '" con Ctrl+' + $k + '.')
      return $dlg
    }
    $vistas += ('Ctrl+' + $k + ' = "' + $t + '"')
    [Cmx]::Cerrar($dlg); Start-Sleep -Seconds 1
  }
  [Cmx]::Cerrar($doc)
  Falla $paso ('No encontré la tecla de "Convertir a ' + $dest + '" (' + ($vistas -join ', ') + ').')
}

# ------------------------------------------------------------------
# Abre la OC serie/folio desde su lista ("Abrir el documento"). Regresa la ventana.
function Abrir-Oc($g, [int]$procId, [string]$lst, [string]$paso) {
  return (Abrir-Documento $procId $lst ([string]$g.ocSerie) ([string]$g.ocFolio) $paso 'la OC')
}
# Abre serie/folio desde la lista $lst ("Abrir el documento"). Regresa la ventana del documento.
function Abrir-Documento([int]$procId, [string]$lst, [string]$serie, [string]$folio, [string]$paso, [string]$que = 'el documento') {
  $lista = [IntPtr]::Zero
  foreach ($w in [Cmx]::Ventanas($procId)) { if ([Cmx]::Clase($w) -eq 'TFrm_Vistas' -and [Cmx]::Titulo($w) -like ('*' + $lst + '*')) { $lista = $w } }
  if ($lista -eq [IntPtr]::Zero) { Espera $paso ('Deja abierta en Comercial la lista de ' + $lst + ' (Todos los Documentos).') }
  # "Abrir el documento": dos campos juntos arriba de la tabla (serie angosto, folio ancho).
  $edits = @([Cmx]::Controles($lista) | Where-Object { $_.Cls -eq 'TMCCEditMascara' -and $_.X -lt 450 -and $_.Y -gt 150 } | Sort-Object Y, X)
  $par = $null
  for ($i = 0; $i -lt $edits.Count - 1; $i++) {
    if ([math]::Abs($edits[$i].Y - $edits[$i + 1].Y) -le 3 -and [math]::Abs(($edits[$i].X + $edits[$i].W) - $edits[$i + 1].X) -le 4) { $par = @($edits[$i], $edits[$i + 1]); break }
  }
  if (-not $par) { Falla $paso 'No encontré los campos "Abrir el documento" en la lista.' }
  Guardar-Cursor
  [void](Escribir-Campo $lista $par[0].H $serie $paso { param($t) $t.Trim() -eq $serie.Trim() })
  [void](Escribir-Campo $lista $par[1].H $folio $paso { param($t) Mismo-Folio $t $folio })
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $doc = Esperar-Ventana $procId 'TDlgDoctoGeneralI' ('*' + $lst + '*') 15
  if ($doc -eq [IntPtr]::Zero) { $av = Leer-Avisos $procId; Falla $paso ('No se abrió ' + $que + ' ' + $serie + ' ' + $folio + '. ' + ($av -join ' ')) }
  # Confirma que es el documento correcto (folio del encabezado).
  $cab = @([Cmx]::Controles($doc) | Where-Object { $_.Cls -eq 'TMCCDbEdit' -and $_.Y -lt 230 })
  if (-not ($cab | Where-Object { Mismo-Folio $_.Text $folio })) { [Cmx]::Cerrar($doc); Falla $paso ('Lo que se abrió no es ' + $que + ' ' + $serie + ' ' + $folio + '.') }
  return $doc
}

# ------------------------------------------------------------------
# Nov-2026 (Edith): a la OC que creó el agente le pone Referencia y Observaciones
# (pestaña 3 Información Adicional) y Elaboró (pestaña Usuario), y la guarda.
# $g: { tipo = 'datosOc', id, empresa, ocConcepto, ocSerie, ocFolio, referencia, observaciones, elaboro, formaPago }
# Nov-2026 (Edith): también la Forma de pago del proveedor (vacía en el proveedor = BAJIO SPEI).
function Completar-DatosOc($g, [int]$procId) {
  $lst = ([string]$g.ocConcepto).Trim().ToUpper()
  $paso = 'Abrir la OC'
  $doc = Abrir-Oc $g $procId $lst $paso
  Revisar-Usuario $paso
  $paso = 'Datos de la OC'
  $gDatos = [pscustomobject]@{ referencia = [string]$g.referencia; observaciones = [string]$g.observaciones; elaboro = [string]$g.elaboro; formaPago = [string]$g.formaPago; poliza = '' }
  $resumen = ''
  try { $resumen = Llenar-DatosAdicionales $doc $gDatos $paso 'Usuario' }
  catch { Cerrar-SinGuardar $doc $procId; throw }
  Revisar-Usuario $paso
  Confirmar-Probar ('OC ' + $g.ocSerie + ' ' + $g.ocFolio + ':' + "`n" + $resumen + "`n`nRevisa las pestañas 3 y Usuario de la OC. Voy a dar GUARDAR.")
  $paso = 'Guardar la OC'
  if (-not [Cmx]::Activar($doc)) { Falla $paso 'No pude traer al frente la OC.' }
  if (-not (Clic-BotonBarra $doc '^\s*Guardar')) { [System.Windows.Forms.SendKeys]::SendWait('{F8}'); Write-L 'Guardar OC con F8.' }
  Start-Sleep -Seconds 2
  $av = Leer-Avisos $procId
  if ($av.Count) { Falla $paso ('Comercial avisó al guardar la OC: ' + ($av -join ' ')) }
  if ([Cmx]::IsWindow($doc) -and [Cmx]::IsWindowVisible($doc)) {
    [Cmx]::Cerrar($doc); Start-Sleep -Milliseconds 800
    if ([Cmx]::IsWindow($doc) -and [Cmx]::IsWindowVisible($doc)) { $av = Leer-Avisos $procId; Falla $paso ('Al cerrar la OC Comercial preguntó algo: ' + ($av -join ' ') + '. Puede que no se haya guardado: revísala.') }
  }
  return ('Datos puestos en la OC ' + $g.ocSerie + ' ' + $g.ocFolio + ': ' + (($resumen -split "`n") -join ' · '))
}
# Si algo falla antes de guardar, cierra la OC sin guardar (Comercial pregunta: se contesta No).
function Cerrar-SinGuardar([IntPtr]$doc, [int]$procId) {
  try {
    [Cmx]::Cerrar($doc); Start-Sleep -Milliseconds 800
    foreach ($w in [Cmx]::Ventanas($procId)) {
      if ([Cmx]::Clase($w) -match 'TMessageForm|#32770') { if (-not (Clic-Boton $w '^&?No$')) { Clic-Boton $w 'No' | Out-Null } }
    }
  } catch { }
}

# ------------------------------------------------------------------
# Nov-2026: abre el documento destino desde su lista y confirma que existe (folio y proveedor del encabezado).
# Si no se puede abrir, la conversión se reporta como ERROR (no ✓): que alguien lo revise en Comercial.
function Comprobar-Documento([int]$procId, [string]$lst, [string]$serie, [string]$folio, [string]$codigoProv, [string]$paso) {
  $c = Buscar-Comercial
  if (-not $c) { Falla $paso ('Guardé ' + $serie + ' ' + $folio + ' pero Comercial se cerró y no pude comprobar que exista. Revísalo en Comercial.') }
  try {
    $lista = Ventana-De $procId { param($cl, $t) $cl -eq 'TFrm_Vistas' -and $t -like ('*' + $lst + '*') }
    if ($lista -eq [IntPtr]::Zero) { Abrir-ListaOc $procId $c.Menu $lst }
    $doc = Abrir-Documento $procId $lst $serie $folio $paso ('el documento de ' + $lst)
  } catch {
    $m = $_.Exception.Message
    Falla $paso ('No encontré ' + $serie + ' ' + $folio + ' en ' + $lst + ' después de guardar (' + $m + '). Probablemente NO se guardó: revísalo en Comercial y conviértela a mano.')
  }
  $cab = @([Cmx]::Controles($doc) | Where-Object { $_.Cls -eq 'TMCCDbEdit' -and $_.Y -lt 230 })
  $okProv = (-not $codigoProv) -or ($cab | Where-Object { $_.Text.Trim() -eq $codigoProv.Trim() })
  [Cmx]::Cerrar($doc); Start-Sleep -Milliseconds 600
  if (-not $okProv) { Falla $paso ($serie + ' ' + $folio + ' en ' + $lst + ' no es de este proveedor (' + $codigoProv + '): revísalo en Comercial.') }
  Write-L ('Comprobado en Comercial: ' + $lst + ' ' + $serie + ' ' + $folio)
}

# ------------------------------------------------------------------
# Una conversión. $g: { id, empresa, ocSerie, ocFolio, facturaSerie, facturaFolio, fechaFactura, fechaRecepcion, total }
function Convertir-Gasto($g, [int]$procId) {
  # Nov-2026: también OC VRZ (refacciones con número de parte) → COMPRA EN PESOS.
  $lst = $(if ($g.ocConcepto) { ([string]$g.ocConcepto).Trim().ToUpper() } else { 'ORDEN DE COMPRA GENERALES' })
  $dest = $(if ($g.destino) { ([string]$g.destino).Trim().ToUpper() } else { 'GASTOS EN PESOS' })
  # 1) Lista de la OC (ORDEN DE COMPRA GENERALES / VRZ) y la OC
  $paso = 'Abrir la OC'
  $doc = Abrir-Oc $g $procId $lst $paso
  Revisar-Usuario $paso

  # 2) Convertir (Ctrl+2 = GASTOS EN PESOS en las OC GENERALES; en las VRZ se busca la tecla de COMPRA EN PESOS)
  $paso = 'Convertir a ' + $dest
  $dlg = Abrir-Conversion $doc $dest $procId $paso

  # 3) Fechas: Fecha (izquierda), Vencimiento (derecha arriba), Recepción (derecha abajo).
  $paso = 'Fechas'
  $ctls = [Cmx]::Controles($dlg)
  $fechas = @($ctls | Where-Object { $_.Cls -match 'Edit|Mascara' -and $_.Text -match '^\d{2}/\d{2}/\d{4}$' } | Sort-Object X, Y)
  if ($fechas.Count -lt 3) { [Cmx]::Cerrar($dlg); Falla $paso ('Esperaba 3 fechas en la ventana de conversión y encontré ' + $fechas.Count + '.') }
  $izq = $fechas | Sort-Object X | Select-Object -First 1
  $der = @($fechas | Where-Object { $_.X -gt $izq.X + 100 } | Sort-Object Y)
  if ($der.Count -lt 2) { [Cmx]::Cerrar($dlg); Falla $paso 'No reconocí las fechas de Vencimiento y Recepción.' }
  $fFact = Fecha-Ddmmyyyy $g.fechaFactura
  $fRec = Fecha-Ddmmyyyy $g.fechaRecepcion
  # Si algo falla aquí, se cancela la conversión (se cierra la ventana) y se cierra la OC: Comercial queda limpio.
  try {
  [void](Escribir-Fecha $dlg $izq $fFact $paso)
  Start-Sleep -Milliseconds 400
  # Días de crédito: el campo numérico de la ventana; vencimiento = fecha + días.
  $dias = 0
  $num = [Cmx]::Controles($dlg) | Where-Object { $_.Cls -match 'Edit|Mascara' -and $_.Text -match '^\s*\d{1,3}\s*$' -and [math]::Abs($_.Y - $der[0].Y) -le 4 -and $_.X -lt $der[0].X } | Select-Object -First 1
  if ($num) { $dias = [int]$num.Text.Trim() }
  $fVen = ([datetime]::ParseExact($g.fechaFactura, 'yyyy-MM-dd', $INV)).AddDays($dias).ToString('dd/MM/yyyy', $INV)
  [void](Escribir-Fecha $dlg $der[0] $fVen $paso)
  [void](Escribir-Fecha $dlg $der[1] $fRec $paso)
  } catch { [Cmx]::Cerrar($dlg); Start-Sleep -Seconds 1; [Cmx]::Cerrar($doc); throw }
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  Start-Sleep -Milliseconds 300
  $ver = [Cmx]::Controles($dlg) | Where-Object { $_.Cls -match 'Edit|Mascara' -and $_.Text -match '^\d{2}/\d{2}/\d{4}$' }
  if (-not ($ver | Where-Object { $_.H -eq $izq.H -and $_.Text -eq $fFact })) { [Cmx]::Cerrar($dlg); Falla $paso ('La fecha no se quedó en ' + $fFact + '.') }
  Revisar-Usuario $paso
  Confirmar-Probar ('Fecha ' + $fFact + ', Vencimiento ' + $fVen + ' (' + $dias + ' días), Recepción ' + $fRec + '. Revisa la ventana de conversión; voy a dar ACEPTAR.')

  # 4) Aceptar y Continuar
  $paso = 'Aceptar conversión'
  if (-not [Cmx]::Activar($dlg)) { Falla $paso 'No pude traer al frente la ventana de conversión.' }
  # La barra de la conversión: Aceptar (1º), Cancelar (2º) y a veces otro más. Sus nombres no se pueden leer.
  $como = 'clic en Aceptar (1er botón de la barra)'
  if (-not (Clic-BotonPosicion $dlg 1 2)) { [System.Windows.Forms.SendKeys]::SendWait('%a'); $como = 'Alt+A' }
  $res = Esperar-Ventana $procId '' 'Resultados del Proceso*' 30
  if ($res -eq [IntPtr]::Zero) {
    $av = Leer-Avisos $procId
    # Después de intentar Aceptar ya no se toca nada: puede que sí se haya convertido (2-nov: pasó con F8).
    $vent = (([Cmx]::Ventanas($procId) | ForEach-Object { [Cmx]::Clase($_) + ' "' + [Cmx]::Titulo($_) + '"' }) -join '; ')
    Write-L ('Después de ' + $como + ' no vi "Resultados del Proceso". Ventanas abiertas: ' + $vent)
    Falla $paso ('Di ' + $como + ' pero no vi "Resultados del Proceso". No toqué nada más: revisa en Comercial si la OC se convirtió. ' + ($av -join ' '))
    Falla $paso ('No salió "Resultados del Proceso". ' + ($av -join ' '))
  }
  $btn = [Cmx]::Controles($res) | Where-Object { $_.Text -match 'Continuar' } | Select-Object -First 1
  if ($btn) { [Cmx]::Clic($btn.H) } else { [void][Cmx]::Activar($res); [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }

  # 5) Gasto: Serie y Folio de la factura
  $paso = 'Serie y folio del gasto'
  $gas = Esperar-Ventana $procId 'TDlgDoctoGeneralI' ($dest + '*') 20
  if ($gas -eq [IntPtr]::Zero) { Falla $paso 'La conversión se hizo, pero no se abrió el gasto. Ponle a mano la serie y folio de la factura.' }
  Start-Sleep -Milliseconds 500
  $cab = @([Cmx]::Controles($gas) | Where-Object { $_.Cls -eq 'TMCCDbEdit' -and $_.Y -lt 230 })
  $cFecha = $cab | Where-Object { $_.Text -match '^\d{2}/\d{2}/\d{4}$' } | Sort-Object X | Select-Object -First 1
  if (-not $cFecha) { Falla $paso 'No reconocí el encabezado del gasto. Ponle a mano la serie y folio de la factura.' }
  $fila = @($cab | Where-Object { [math]::Abs($_.Y - $cFecha.Y) -le 3 -and $_.X -gt $cFecha.X } | Sort-Object X)
  if ($fila.Count -lt 2) { Falla $paso 'No encontré los campos Serie y Folio del gasto. Ponles a mano los de la factura.' }
  $cSerie = $fila[0]; $cFolio = $fila[1]
  if ($cFecha.Text -ne $fFact) { Write-L ('Ojo: el gasto quedó con fecha ' + $cFecha.Text + ' (factura ' + $fFact + ').') }
  Guardar-Cursor
  [void](Escribir-Campo $gas $cSerie.H ([string]$g.facturaSerie) $paso { param($t) $t.Trim() -eq ([string]$g.facturaSerie).Trim() })
  [void](Escribir-Campo $gas $cFolio.H ([string]$g.facturaFolio) $paso { param($t) Mismo-Folio $t ([string]$g.facturaFolio) })
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  Start-Sleep -Milliseconds 400
  $av = Leer-Avisos $procId
  if ($av.Count) { Falla $paso ('Comercial avisó: ' + ($av -join ' ') + ' (el gasto quedó sin guardar).') }
  Revisar-Usuario $paso

  # 5b) Pestañas "3 Información Adicional" y "6 Usuario" (nov-2026)
  $paso = 'Datos adicionales del gasto'
  $resumen = Llenar-DatosAdicionales $gas $g $paso
  Revisar-Usuario $paso
  Confirmar-Probar ('Gasto con Serie ' + $g.facturaSerie + ' Folio ' + $g.facturaFolio + ' y fecha ' + $cFecha.Text + '.' + "`n" + $resumen + "`n`nRevisa las pestañas 3 y 6. Voy a dar GUARDAR.")

  # 6) Guardar (F8 = "Guardar Documento <F8>") y confirmar
  $paso = 'Guardar el gasto'
  $antes = @([Cmx]::Ventanas($procId))
  if (-not [Cmx]::Activar($gas)) { Falla $paso 'No pude traer al frente el gasto.' }
  if (-not (Clic-BotonBarra $gas '^\s*Guardar')) { [System.Windows.Forms.SendKeys]::SendWait('{F8}'); Write-L 'Guardar con F8.' }
  Start-Sleep -Seconds 2
  $av = Leer-Avisos $procId
  if ($av.Count) { Falla $paso ('Comercial avisó al guardar: ' + ($av -join ' ') + ' No se guardó: conviértela a mano.') }
  # Nov-2026 (OF-00025): si al guardar Comercial abre otra ventana (p.ej. captura de lotes/series), no se guardó.
  $nuevas = @([Cmx]::Ventanas($procId) | Where-Object { $antes -notcontains $_ -and -not (Es-VentanaLibre ([Cmx]::Clase($_))) })
  if ($nuevas.Count) { Falla $paso ('Al guardar, Comercial abrió "' + (($nuevas | ForEach-Object { [Cmx]::Titulo($_) }) -join '", "') + '" (¿pide lote o serie?). No se guardó: conviértela a mano.') }
  $despues = [Cmx]::Controles($gas)
  $sOk = $despues | Where-Object { $_.H -eq $cSerie.H -and $_.Text.Trim() -eq ([string]$g.facturaSerie).Trim() }
  $fOk = $despues | Where-Object { $_.H -eq $cFolio.H -and (Mismo-Folio $_.Text ([string]$g.facturaFolio)) }
  if (-not ($sOk -and $fOk)) { Falla $paso 'Después de guardar, la serie/folio no son los de la factura. Revísalo en Comercial.' }
  # Cierra el gasto y la OC (ya guardados).
  [Cmx]::Cerrar($gas); Start-Sleep -Milliseconds 800
  if ([Cmx]::IsWindow($gas) -and [Cmx]::IsWindowVisible($gas)) { $av = Leer-Avisos $procId; Falla $paso ('Al cerrar el gasto Comercial preguntó algo: ' + ($av -join ' ') + '. Puede que no se haya guardado: revísalo.') }
  foreach ($w in [Cmx]::Ventanas($procId)) { if ([Cmx]::Clase($w) -eq 'TDlgDoctoGeneralI' -and [Cmx]::Titulo($w) -like ('*' + $lst + '*')) { [Cmx]::Cerrar($w) } }
  Start-Sleep -Milliseconds 800
  # 7) Nov-2026: se comprueba que el gasto/compra SÍ quedó, abriéndolo desde su lista (OF-00025 salió ✓ y no existía).
  $paso = 'Comprobar en Comercial'
  Comprobar-Documento $procId $dest ([string]$g.facturaSerie) ([string]$g.facturaFolio) ([string]$g.codigoProveedor) $paso
  return ('Convertida por el agente a ' + $dest + ': ' + $g.facturaSerie + ' ' + $g.facturaFolio + ' con fecha ' + $fFact + ' (comprobado en Comercial).')
}

# ------------------------------------------------------------------
# Preparar Comercial: abierto, con sesión, en la empresa y con la lista de OC.
# ------------------------------------------------------------------
# Ventanas que pueden quedarse abiertas sin estorbar (menú, listas, avisos flotantes).
function Es-VentanaLibre([string]$clase) {
  return $clase -in @('TDlgMenuPrincipal', 'TFrm_Vistas', 'THintWindow', 'tooltips_class32', 'MicrosoftWindowsTooltip', 'TDlgAvanceApp', 'TFrmSplash', 'TDlgSplash', 'TDlgAbrirEmpresa', 'TFormaTips', '')
}
function Buscar-Comercial {
  foreach ($p in @(Get-Process -Name 'Comercial' -ErrorAction SilentlyContinue)) {
    foreach ($w in [Cmx]::Ventanas($p.Id)) { if ([Cmx]::Clase($w) -eq 'TDlgMenuPrincipal') { return @{ Pid = $p.Id; Menu = $w } } }
  }
  return $null
}
function Ventana-De([int]$procId, [scriptblock]$filtro) {
  foreach ($w in [Cmx]::Ventanas($procId)) { if (& $filtro ([Cmx]::Clase($w)) ([Cmx]::Titulo($w))) { return $w } }
  return [IntPtr]::Zero
}
function Clic-Boton([IntPtr]$ventana, [string]$patron) {
  $b = [Cmx]::Controles($ventana) | Where-Object { $_.Cls -match 'Button|BitBtn' -and $_.Text -match $patron } | Select-Object -First 1
  if ($b) { [Cmx]::Clic($b.H); return $true }
  return $false
}
# Acceso directo de Comercial (escritorio o menú Inicio), o el de la configuración.
function Buscar-AccesoComercial {
  if ($script:CfgObj -and $script:CfgObj.comercialAcceso -and (Test-Path -LiteralPath ([string]$script:CfgObj.comercialAcceso))) { return [string]$script:CfgObj.comercialAcceso }
  $sh = New-Object -ComObject WScript.Shell
  $carpetas = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
  foreach ($c in $carpetas) {
    if (-not $c -or -not (Test-Path -LiteralPath $c)) { continue }
    foreach ($l in @(Get-ChildItem -LiteralPath $c -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -match 'Comercial' -and $_.BaseName -notmatch 'Start|Factura|Servidor|Monitor|Config|Respald|Desinst|Uninstall|Ayuda|Manual|Novedad' })) {
      try { $t = $sh.CreateShortcut($l.FullName).TargetPath } catch { $t = '' }
      if ($t -match '\.exe$' -and $t -match 'Comercial|Compac|CONTPAQ') { return $l.FullName }
    }
  }
  return $null
}
function Cerrar-Comercial([int]$procId, [string]$motivo) {
  Confirmar-Probar ('Voy a CERRAR Comercial: ' + $motivo + ' Si hay algo sin guardar, se pierde.')
  Write-L ('Cierro Comercial: ' + $motivo)
  $m = Ventana-De $procId { param($c, $t) $c -eq 'TDlgMenuPrincipal' }
  if ($m -ne [IntPtr]::Zero) { [Cmx]::Cerrar($m) }
  $fin = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $fin -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500 }
  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
}
# Tips → Cerrar; "Ingreso a CONTPAQi Contabilidad" → Cancelar. Regresa cuando ya no hay ninguna.
function Atender-Inicio([int]$procId, [int]$segundos) {
  $fin = (Get-Date).AddSeconds($segundos); $quietas = 0
  while ((Get-Date) -lt $fin) {
    $hizo = $false
    foreach ($w in [Cmx]::Ventanas($procId)) {
      $c = [Cmx]::Clase($w); $t = [Cmx]::Titulo($w)
      if ($c -eq 'TFormaTips') { if (Clic-Boton $w 'Cerrar') { Write-L 'Tips → Cerrar'; $hizo = $true } }
      elseif ($t -match '(?i)contabilidad') { if (Clic-Boton $w 'Cancelar') { Write-L 'Contabilidad → Cancelar'; $hizo = $true } }
    }
    if ($hizo) { $quietas = 0 } else { $quietas++ }
    if ($quietas -ge 4) { return }
    Start-Sleep -Milliseconds 500
  }
}
function Leer-Clave {
  if (-not $script:CfgObj -or -not $script:CfgObj.contpaqiClaveCifrada -or -not $script:CfgObj.contpaqiUsuario) { Falla 'Entrar a Comercial' 'No hay usuario/clave de CONTPAQi guardados en esta PC: corre guardar_clave_contpaqi.bat.' }
  $s = ConvertTo-SecureString ([string]$script:CfgObj.contpaqiClaveCifrada)
  return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
function Abrir-Comercial {
  $paso = 'Abrir Comercial'
  $acceso = Buscar-AccesoComercial
  if (-not $acceso) { Falla $paso 'No encontré el acceso directo de CONTPAQi Comercial en el escritorio ni en el menú Inicio.' }
  Confirmar-Probar ('Voy a abrir Comercial (' + $acceso + ') y entrar con tu usuario.')
  Write-L ('Abro Comercial: ' + $acceso)
  Start-Process -FilePath $acceso
  # Espera la ventana de Ingreso (o el menú, si no pide usuario).
  $fin = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $fin) {
    Start-Sleep -Milliseconds 700
    if (Buscar-Comercial) { return }
    foreach ($p in @(Get-Process -Name 'Comercial' -ErrorAction SilentlyContinue)) {
      $login = Ventana-De $p.Id { param($c, $t) $c -eq 'TDlgLoginUsuario' -and $t -notmatch '(?i)contabilidad' }
      if ($login -ne [IntPtr]::Zero) { Start-Sleep -Seconds 1; Entrar-Comercial $p.Id $login; return }
    }
  }
  Falla $paso 'Comercial no abrió la ventana de Ingreso en 2.5 minutos.'
}
function Yo-Elevado { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
# Windows no deja que un programa normal escriba o dé clic en uno abierto "como administrador".
function Revisar-Permisos([int]$procId, [string]$paso) {
  if (-not $script:PermisosAnotados) { $script:PermisosAnotados = $true; Write-L ('Comercial como administrador: ' + $(if ([Cmx]::Elevado($procId)) { 'sí' } else { 'no' }) + ' · agente como administrador: ' + $(if (Yo-Elevado) { 'sí' } else { 'no' })) }
  if ([Cmx]::Elevado($procId) -and -not (Yo-Elevado)) {
    Falla $paso 'Comercial corre como administrador y el agente no: Windows no deja escribir ni dar clic en sus ventanas. Corre probar_conversion_gasto.bat (pide permiso de administrador) o permisos_agente_oc.bat para la tarea automática.'
  }
}
function Entrar-Comercial([int]$procId, [IntPtr]$login) {
  $paso = 'Entrar a Comercial'
  Revisar-Permisos $procId $paso
  $ctls = @([Cmx]::Controles($login))
  $cajaClave = $ctls | Where-Object { $_.Clave } | Select-Object -First 1
  $cajaUsuario = $ctls | Where-Object { $_.Cls -match 'Edit|Mascara' -and -not $_.Clave } | Sort-Object Y | Select-Object -First 1
  if (-not $cajaClave -or -not $cajaUsuario) { Falla $paso 'No reconocí los campos de usuario y clave del Ingreso.' }
  $usuario = [string]$script:CfgObj.contpaqiUsuario
  $clave = Leer-Clave
  # Directo a cada campo (WM_SETTEXT): no se teclea nada, no puede caer en otra ventana.
  [Cmx]::PonerTexto($cajaUsuario.H, $usuario)
  if ([Cmx]::Texto($cajaUsuario.H).Trim() -ne $usuario.Trim()) { Falla $paso 'El usuario no se quedó escrito en el Ingreso.' }
  # Windows no deja leer (ni contar) un campo de contraseña de otro programa: se confirma con el resultado (la ventana se cierra).
  [Cmx]::PonerTexto($cajaClave.H, $clave)
  Start-Sleep -Milliseconds 200
  [void][Cmx]::Activar($login)
  if (-not (Clic-Boton $login 'Aceptar')) { Falla $paso 'No encontré el botón Aceptar del Ingreso.' }
  Write-L ('Ingreso con usuario ' + $usuario + ' (clave directa al campo + Aceptar)')
  Start-Sleep -Seconds 4
  if ([Cmx]::IsWindow($login) -and [Cmx]::IsWindowVisible($login) -and -not @(Leer-Avisos $procId).Count) {
    # Segundo intento: letras mandadas SOLO a ese campo (no al teclado) y Enter en el mismo campo.
    Write-L 'El Ingreso sigue abierto; segundo intento: letras directas al campo de clave y Enter.'
    [Cmx]::PonerTexto($cajaClave.H, '')
    [void][Cmx]::Enfocar($cajaClave.H)
    [Cmx]::Letras($cajaClave.H, $clave)
    Start-Sleep -Milliseconds 600
    [Cmx]::EnterEn($cajaClave.H)
  }
  $clave = $null
  $fin = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $fin) {
    Start-Sleep -Milliseconds 700
    $av = @(Leer-Avisos $procId)
    if ([Cmx]::IsWindow($login) -and [Cmx]::IsWindowVisible($login) -and $av.Count) {
      Cerrar-Comercial $procId 'no pudo entrar.'
      Falla $paso ('CONTPAQi no aceptó el usuario/clave: ' + ($av -join ' ') + ' (si cambiaste la clave, corre guardar_clave_contpaqi.bat). No lo vuelvo a intentar solo.')
    }
    Atender-Inicio $procId 2
    if (Buscar-Comercial) { return }
  }
  Falla $paso 'Después del Ingreso no apareció la ventana principal de Comercial.'
}
# El Catálogo de Empresas es una tabla que no se puede leer desde fuera: se
# recorre renglón por renglón (flechas mandadas a la tabla), se abre con Enter
# y se confirma con el título de Comercial. El renglón bueno se recuerda en
# logs\empresa_filas.json para las siguientes veces.
function Abrir-Catalogo([int]$procId, [IntPtr]$menu) {
  $cat = Ventana-De $procId { param($c, $t) $c -eq 'TDlgAbrirEmpresa' }
  if ($cat -ne [IntPtr]::Zero) { return $cat }
  $id = [Cmx]::BuscarMenu($menu, 'Empresas')
  if (-not $id) { Falla 'Abrir la empresa' 'No encontré la opción Empresa → Empresas en el menú.' }
  [Cmx]::Comando($menu, $id)
  $cat = Esperar-Ventana $procId 'TDlgAbrirEmpresa' '' 15
  if ($cat -eq [IntPtr]::Zero) { Falla 'Abrir la empresa' 'No se abrió el Catálogo de Empresas.' }
  Start-Sleep -Milliseconds 800
  return $cat
}
function Leer-Filas { try { if (Test-Path -LiteralPath $script:FilasPath) { return (Get-Content -LiteralPath $script:FilasPath -Raw -Encoding UTF8 | ConvertFrom-Json) } } catch { }; return $null }
function Orden-Filas([int]$total, $aprendida) {
  $l = @(); if ($aprendida -and [int]$aprendida -ge 1 -and [int]$aprendida -le $total) { $l += [int]$aprendida }
  for ($i = 1; $i -le $total; $i++) { if ($l -notcontains $i) { $l += $i } }
  return $l
}
function Abrir-Empresa([int]$procId, [IntPtr]$menu, [string]$empresa) {
  $paso = 'Abrir la empresa'
  $cat = Abrir-Catalogo $procId $menu
  $grid = [Cmx]::Controles($cat) | Where-Object { $_.Cls -match 'Grid' } | Select-Object -First 1
  if (-not $grid) { Falla $paso 'No encontré la tabla del Catálogo de Empresas.' }
  $num = [Cmx]::Controles($cat) | Where-Object { $_.Text -match '^\s*\d{1,3}\s*$' } | Select-Object -First 1
  $total = if ($num) { [int]$num.Text.Trim() } else { 15 }
  $filas = Leer-Filas
  $clave = Get-NombreNormal $empresa
  $aprendida = if ($filas -and $filas.PSObject.Properties[$clave]) { $filas.$clave } else { $null }
  Write-L ('Catálogo de Empresas: ' + $total + ' empresas; renglón recordado: ' + $(if ($aprendida) { $aprendida } else { 'ninguno' }))
  $primera = $true
  foreach ($fila in (Orden-Filas $total $aprendida)) {
    if (-not $primera) { $cat = Abrir-Catalogo $procId $menu; $grid = [Cmx]::Controles($cat) | Where-Object { $_.Cls -match 'Grid' } | Select-Object -First 1 }
    if ($primera) { Confirmar-Probar ('Voy a buscar ' + $empresa + ' en el Catálogo de Empresas (renglón por renglón) y abrirla con Enter.') }
    $primera = $false
    [Cmx]::Enfocar($grid.H) | Out-Null
    for ($k = 0; $k -lt $total + 3; $k++) { [Cmx]::Tecla($grid.H, 0x26) }          # arriba hasta el primero
    for ($k = 1; $k -lt $fila; $k++) { [Cmx]::Tecla($grid.H, 0x28) }               # abajo hasta el renglón
    Start-Sleep -Milliseconds 500
    [Cmx]::Tecla($grid.H, 0x0D)                                                     # Enter = Abrir empresa
    $inicio = Get-Date; $titulo = ''
    while (((Get-Date) - $inicio).TotalSeconds -lt 90) {
      Start-Sleep -Milliseconds 800
      Atender-Inicio $procId 2
      $titulo = [Cmx]::Titulo($menu)
      $catAbierto = [Cmx]::IsWindow($cat) -and [Cmx]::IsWindowVisible($cat)
      if (-not $catAbierto -and $titulo -match 'Empresa:') { break }
      if ($catAbierto) {
        $av = @(Leer-Avisos $procId)
        if ($av.Count) { Falla $paso ('Comercial avisó al abrir la empresa: ' + ($av -join ' ')) }
        if (((Get-Date) - $inicio).TotalSeconds -gt 45) { Falla $paso ('Enter no abrió la empresa del renglón ' + $fila + ' en 45 s (el catálogo sigue abierto). Revisa que este usuario de Comercial pueda abrir esa empresa a mano.') }
      }
    }
    if (Es-MismaEmpresa $titulo $empresa) {
      Write-L ('Empresa abierta: ' + $titulo + ' (renglón ' + $fila + ')')
      $o = @{}; if ($filas) { $filas.PSObject.Properties | ForEach-Object { $o[$_.Name] = $_.Value } }
      $o[$clave] = $fila
      try { ($o | ConvertTo-Json) | Set-Content -LiteralPath $script:FilasPath -Encoding UTF8 } catch { }
      return
    }
    Write-L ('Renglón ' + $fila + ' abrió "' + $titulo + '"; sigo buscando.')
  }
  Falla $paso ('No encontré ' + $empresa + ' en el Catálogo de Empresas.')
}
function Abrir-ListaOc([int]$procId, [IntPtr]$menu, [string]$lst = 'ORDEN DE COMPRA GENERALES') {
  $paso = 'Abrir la lista de OC'
  $lvs = @(); $fin = (Get-Date).AddSeconds(20)
  do {
    $lvs = @([Cmx]::Controles($menu) | Where-Object { $_.Cls -eq 'TDCOutBarVertListView' })
    $hay = 0; foreach ($lv in $lvs) { $hay += [Cmx]::LvCuenta($lv.H) }
    if ($hay -gt 0) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $fin)
  $vistos = @()
  foreach ($lv in $lvs) {
    $txt = @([Cmx]::LvTextos($lv.H))
    $vistos += ($txt -join ', ')
    for ($i = 0; $i -lt $txt.Count; $i++) {
      if ((Get-NombreNormal $txt[$i]) -eq (Get-NombreNormal $lst)) {
        [void][Cmx]::LvClic($lv.H, $i)
        $l = Esperar-Ventana $procId 'TFrm_Vistas' ('*' + $lst + '*') 45
        if ($l -ne [IntPtr]::Zero) { Write-L ('Lista ' + $lst + ' abierta.'); return }
        Falla $paso ('Di clic en ' + $lst + ' de la barra izquierda pero no se abrió la lista.')
      }
    }
  }
  Write-L ('Barra izquierda: ' + $lvs.Count + ' listas; elementos: ' + ($vistos -join ' | '))
  Espera $paso ('No pude abrir sola la lista ' + $lst + ': déjala abierta en Comercial (barra izquierda).')
}
# Deja Comercial listo para convertir. Regresa el pid.
function Preparar-Comercial([string]$empresa, [string]$lst = 'ORDEN DE COMPRA GENERALES') {
  Guardar-Cursor
  $c = Buscar-Comercial
  if ($c) {
    Atender-Inicio $c.Pid 3
    $otras = @([Cmx]::Ventanas($c.Pid) | Where-Object { -not (Es-VentanaLibre ([Cmx]::Clase($_))) })
    if ($otras.Count) {
      Cerrar-Comercial $c.Pid ('tenía abierto: ' + (($otras | ForEach-Object { [Cmx]::Titulo($_) }) -join ', ') + '.')
      $c = $null
    }
  }
  if (-not $c) {
    # ¿Quedó una ventana de Ingreso de Comercial abierta? Se usa esa.
    foreach ($p in @(Get-Process -Name 'Comercial' -ErrorAction SilentlyContinue)) {
      $login = Ventana-De $p.Id { param($cl, $t) $cl -eq 'TDlgLoginUsuario' -and $t -notmatch '(?i)contabilidad' }
      if ($login -ne [IntPtr]::Zero) { Entrar-Comercial $p.Id $login; break }
    }
    if (-not (Buscar-Comercial)) { Abrir-Comercial }
    $c = Buscar-Comercial
    if (-not $c) { Falla 'Abrir Comercial' 'Comercial no quedó abierto.' }
    Atender-Inicio $c.Pid 6
    $av = @(Leer-Avisos $c.Pid)
    if ($av.Count) { Falla 'Abrir Comercial' ('Al abrir, Comercial mostró un aviso que no conozco: ' + ($av -join ' ')) }
  }
  Revisar-Permisos $c.Pid 'Preparar Comercial'
  Revisar-Usuario 'Preparar Comercial'
  if (-not (Es-MismaEmpresa ([Cmx]::Titulo($c.Menu)) $empresa)) { Abrir-Empresa $c.Pid $c.Menu $empresa }
  $lista = Ventana-De $c.Pid { param($cl, $t) $cl -eq 'TFrm_Vistas' -and $t -like ('*' + $lst + '*') }
  if ($lista -eq [IntPtr]::Zero) { Abrir-ListaOc $c.Pid $c.Menu $lst }
  Revisar-Usuario 'Preparar Comercial'
  return $c.Pid
}

# ------------------------------------------------------------------
if ($SoloFunciones) { return }
$gastos = @((Get-Content $Trabajo -Raw -Encoding UTF8 | ConvertFrom-Json) | Where-Object { $_ })
$salida = @()
$journalPath = Join-Path (Split-Path -Parent $Trabajo) 'gastos_convertidos.json'
$journal = @{}
if (Test-Path $journalPath) { try { (Get-Content $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $journal[$_.Name] = $_.Value } } catch { } }

$motivoEspera = $null
if ([Cmx]::SesionBloqueada()) { $motivoEspera = 'La sesión de Windows está bloqueada.' }
elseif (-not $Forzar -and [Cmx]::SegundosLibre() -lt $MinutosLibre * 60) { $motivoEspera = 'La computadora está en uso; se convierte cuando lleve ' + $MinutosLibre + ' min sin usarse.' }
$script:CfgObj = $null
$script:FilasPath = Join-Path (Split-Path -Parent $Trabajo) 'empresa_filas.json'
if ($Config -and (Test-Path -LiteralPath $Config)) { $script:CfgObj = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json }

foreach ($g in $gastos) {
  $clave = [string]$g.id + '|' + $g.ocSerie + '|' + $g.ocFolio
  $esDatos = ([string]$g.tipo) -eq 'datosOc'
  if ($journal.ContainsKey($clave)) { $salida += @{ id = $g.id; ok = $true; mensaje = $(if ($esDatos) { 'Ya se habían puesto los datos en una vuelta anterior.' } else { 'Ya se había convertido en una vuelta anterior.' }) }; continue }
  if ($motivoEspera) { $salida += @{ id = $g.id; esperar = $true; mensaje = $motivoEspera }; continue }
  if ($esDatos) {
    # Nov-2026: la PRIMERA vez se hace en modo prueba (probar_conversion_gasto.bat), con pregunta antes de Guardar.
    $marcaDatos = Join-Path (Split-Path -Parent $Trabajo) 'datos_oc_probada.txt'
    if (-not $Probar -and -not (Test-Path $marcaDatos)) { $salida += @{ id = $g.id; esperar = $true; mensaje = 'Primera vez: córrelo con probar_conversion_gasto.bat para revisarlo.' }; continue }
    try {
      Write-L ('Datos de la OC ' + $g.ocSerie + ' ' + $g.ocFolio + ' (' + $g.ocConcepto + ')')
      $procId = Preparar-Comercial ([string]$g.empresa) (([string]$g.ocConcepto).Trim().ToUpper())
      $m = Completar-DatosOc $g $procId
      $journal[$clave] = @{ en = (Get-Date -Format 's') }
      ($journal | ConvertTo-Json -Depth 3) | Set-Content -Path $journalPath -Encoding UTF8
      $salida += @{ id = $g.id; ok = $true; mensaje = $m }
      if (-not (Test-Path $marcaDatos)) { Set-Content -Path $marcaDatos -Value ('Probada ' + (Get-Date -Format 's') + ': ' + $m) -Encoding UTF8 }
      Write-L $m
    } catch {
      $e = $_.Exception
      if ($e -is [PasoError]) {
        if ($e.Esperar) { $salida += @{ id = $g.id; esperar = $true; mensaje = $e.Message } }
        else { $salida += @{ id = $g.id; ok = $false; paso = $e.Paso; mensaje = $e.Message } }
        Write-L ('Paso "' + $e.Paso + '": ' + $e.Message)
      } else {
        $salida += @{ id = $g.id; ok = $false; paso = 'inesperado'; mensaje = $e.Message }
        Write-L ('Error: ' + $e.Message)
      }
      $motivoEspera = 'Se detuvo por un problema con otra OC; revisa Comercial.'
    }
    continue
  }
  # Nov-2026: la PRIMERA conversión a COMPRA EN PESOS (OC VRZ) se hace en modo prueba
  # (probar_conversion_gasto.bat), con las preguntas antes de Aceptar y de Guardar.
  $esCompra = ([string]$g.destino).Trim().ToUpper() -eq 'COMPRA EN PESOS'
  $marcaCompra = Join-Path (Split-Path -Parent $Trabajo) 'compra_probada.txt'
  if ($esCompra -and -not $Probar -and -not (Test-Path $marcaCompra)) {
    $salida += @{ id = $g.id; esperar = $true; mensaje = 'Primera conversión a COMPRA EN PESOS: córrela con probar_conversion_gasto.bat para revisarla.' }; continue
  }
  try {
    Write-L ('Convirtiendo OC ' + $g.ocSerie + ' ' + $g.ocFolio + ' → ' + $(if ($g.destino) { $g.destino } else { 'GASTOS EN PESOS' }) + ' ' + $g.facturaSerie + ' ' + $g.facturaFolio)
    $procId = Preparar-Comercial ([string]$g.empresa) $(if ($g.ocConcepto) { ([string]$g.ocConcepto).Trim().ToUpper() } else { 'ORDEN DE COMPRA GENERALES' })
    $m = Convertir-Gasto $g $procId
    $journal[$clave] = @{ en = (Get-Date -Format 's') }
    ($journal | ConvertTo-Json -Depth 3) | Set-Content -Path $journalPath -Encoding UTF8
    $salida += @{ id = $g.id; ok = $true; mensaje = $m }
    if ($esCompra -and -not (Test-Path $marcaCompra)) { Set-Content -Path $marcaCompra -Value ('Probada ' + (Get-Date -Format 's') + ': ' + $m) -Encoding UTF8 }
    Write-L $m
  } catch {
    $e = $_.Exception
    if ($e -is [PasoError]) {
      if ($e.Esperar) { $salida += @{ id = $g.id; esperar = $true; mensaje = $e.Message } }
      else { $salida += @{ id = $g.id; ok = $false; paso = $e.Paso; mensaje = $e.Message } }
      Write-L ('Paso "' + $e.Paso + '": ' + $e.Message)
    } else {
      $salida += @{ id = $g.id; ok = $false; paso = 'inesperado'; mensaje = $e.Message }
      Write-L ('Error: ' + $e.Message)
    }
    # Después de un error no se sigue con las demás: que alguien revise Comercial primero.
    $motivoEspera = 'Se detuvo por un problema con otra OC; revisa Comercial.'
  }
}
# -InputObject conserva el arreglo aunque tenga 1 elemento (PowerShell 5.1 no tiene -AsArray).
(ConvertTo-Json -InputObject @($salida) -Depth 4) | Set-Content -Path $Resultado -Encoding UTF8
