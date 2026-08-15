# Раскладывает исходное лого по размерам, которые нужны приложению и сайту.
#
# Лежит в репозитории, чтобы картинки не приходилось пересобирать вручную и
# наугад: меняется исходник — прогоняется скрипт, и все производные сходятся.
#
#   powershell -File scripts/make-icons.ps1 -Source C:\путь\sightline_logo.jpeg
#
# Исходник должен быть квадратным: непропорциональное сжатие тут не делается
# намеренно — кривое лого лучше заметить сразу, чем найти его потом в трее.

param(
  [string]$Source = "$env:USERPROFILE\Downloads\sightline_logo.jpeg"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$site = Join-Path (Split-Path -Parent $root) 'Sightline-Backend\site'

if (-not (Test-Path $Source)) { throw "не найден исходник: $Source" }

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
try {
  if ($src.Width -ne $src.Height) {
    throw "исходник не квадратный ($($src.Width)x$($src.Height)) — обрежьте его до квадрата"
  }

  # Куда и в каком размере. 512 для иконки приложения: electron-builder сам
  # соберёт из неё .ico, но требует не меньше 256.
  $targets = @(
    @{ Path = (Join-Path $root 'assets\logo.png');    Size = 1024 },
    @{ Path = (Join-Path $root 'assets\icon.png');    Size = 512  },
    @{ Path = (Join-Path $root 'assets\favicon.png'); Size = 256  },
    @{ Path = (Join-Path $site 'favicon.png');        Size = 256  }
  )

  foreach ($t in $targets) {
    $dir = Split-Path -Parent $t.Path
    if (-not (Test-Path $dir)) { Write-Warning "нет каталога $dir — пропускаю"; continue }

    $bmp = New-Object System.Drawing.Bitmap($t.Size, $t.Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      # Тонкие линии лого при обычном уменьшении рвутся; бикубическое сглаживание
      # с качественным режимом даёт ровный контур даже на 256 пикселях.
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($src, 0, 0, $t.Size, $t.Size)
    } finally {
      $g.Dispose()
    }
    $bmp.Save($t.Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("{0}  {1}x{1}" -f $t.Path, $t.Size)
  }

} finally {
  $src.Dispose()
}
