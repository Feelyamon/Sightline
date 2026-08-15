# Клик по координатам ВНУТРИ окна приложения (не по абсолютным экранным):
# так скрипт не зависит от того, где пользователь держит окно.
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [string]$Title = 'Sightline'
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32Click {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int size);
}
"@

$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1
if (-not $proc) { Write-Output "WINDOW NOT FOUND"; exit 1 }

[void][W32Click]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 300

$r = New-Object W32Click+RECT
[void][W32Click]::DwmGetWindowAttribute($proc.MainWindowHandle, 9, [ref]$r, 16)

[void][W32Click]::SetCursorPos(($r.Left + $X), ($r.Top + $Y))
Start-Sleep -Milliseconds 120
[W32Click]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)  # left down
[W32Click]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)  # left up
Start-Sleep -Milliseconds 400
Write-Output "clicked $X,$Y"
