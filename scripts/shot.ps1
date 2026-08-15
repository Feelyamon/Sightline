# Снимок ТОЛЬКО окна приложения, а не всего экрана: на экране может быть
# что угодно постороннее. Ищем окно по заголовку и снимаем его прямоугольник.
param(
  [string]$Title = 'Sightline',
  [string]$Out = "$env:TEMP\wtvh-shot.png"
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int size);
}
"@

$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1
if (-not $proc) { Write-Output "WINDOW NOT FOUND: $Title"; exit 1 }

$h = $proc.MainWindowHandle
[void][Win32]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400

# DWMWA_EXTENDED_FRAME_BOUNDS = 9 — без невидимых полей тени.
$r = New-Object Win32+RECT
if ([Win32]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) {
  [void][Win32]::GetWindowRect($h, [ref]$r)
}

$w = $r.Right - $r.Left
$hgt = $r.Bottom - $r.Top
if ($w -le 0 -or $hgt -le 0) { Write-Output "BAD RECT"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $hgt))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $Out
