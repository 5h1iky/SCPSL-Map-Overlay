$src = @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szDevice; }
public static class W {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect([In] ref RECT r, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
  public static string MonitorOfTitle(string title) {
    IntPtr h = FindWindow(null, title);
    if (h == IntPtr.Zero) return "NOTFOUND";
    RECT r;
    if (!GetWindowRect(h, out r)) return "NORECT";
    IntPtr m = MonitorFromRect(ref r, 2);
    MONITORINFO i = new MONITORINFO();
    i.cbSize = Marshal.SizeOf(i);
    if (!GetMonitorInfo(m, ref i)) return "NOINFO";
    return i.szDevice + "|" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop
[W]::MonitorOfTitle('SCP: Secret Laboratory')
