# Persistent OCR worker. Protocol: one JSON object per stdin line -> one JSON object per stdout line.
# Requires Windows PowerShell 5.1 (WinRT projection). Never exits on a bad frame.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -Path "$PSScriptRoot/display-capture.cs" -ReferencedAssemblies System.Drawing
# Client rectangles and desktop pixels must share physical coordinates at any DPI.
$null = [AmoDisplayCapture]::SetThreadDpiAwarenessContext([IntPtr](-4))
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class AmoWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Emit @{ ok = $false; ready = $false; error = 'no OCR language pack installed' }; exit 1 }
Emit @{ ok = $true; ready = $true; lang = $engine.RecognizerLanguage.LanguageTag }

function Get-GameRect {
  $p = Get-Process -Name 'League of Legends' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($null -eq $p -or [AmoWin32]::IsIconic($p.MainWindowHandle)) { return $null }
  $r = New-Object AmoWin32+RECT
  if (-not [AmoWin32]::GetClientRect($p.MainWindowHandle, [ref]$r)) { return $null }
  $pt = New-Object AmoWin32+POINT
  [AmoWin32]::ClientToScreen($p.MainWindowHandle, [ref]$pt) | Out-Null
  if ($r.Right -lt 200 -or $r.Bottom -lt 200) { return $null }
  return @{ X = $pt.X; Y = $pt.Y; W = $r.Right; H = $r.Bottom; Window = $true }
}

function Read-OcrBitmap($bmp, [int]$ox, [int]$oy, [double]$scale = 1) {
  $ms = $null; $ras = $null; $writer = $null; $sb = $null
  try {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($ras.GetOutputStreamAt(0))
    $writer.WriteBytes($ms.ToArray())
    $null = Await ($writer.StoreAsync()) ([UInt32]); $null = $writer.DetachStream(); $ras.Seek(0)
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
    foreach ($l in $res.Lines) {
      $ws = @($l.Words); if ($ws.Length -eq 0) { continue }
      # Use the union of ALL word boxes; the first word may be short or punctuation.
      $xs = @($ws | ForEach-Object { $_.BoundingRect.X })
      $ys = @($ws | ForEach-Object { $_.BoundingRect.Y })
      $rs = @($ws | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width })
      $bs = @($ws | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height })
      $x = ($xs | Measure-Object -Minimum).Minimum; $y = ($ys | Measure-Object -Minimum).Minimum
      $right = ($rs | Measure-Object -Maximum).Maximum; $bottom = ($bs | Measure-Object -Maximum).Maximum
      @{ text = $l.Text; x = [int]($x / $scale + $ox); y = [int]($y / $scale + $oy); w = [int](($right - $x) / $scale); h = [int](($bottom - $y) / $scale) }
    }
  } finally {
    if ($sb) { $sb.Dispose() }; if ($writer) { $writer.Dispose() }
    if ($ras) { $ras.Dispose() }; if ($ms) { $ms.Dispose() }
  }
}

function Capture($req) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $frame = $null; $bmp = $null
  try {
    if ($req.imagePath) {
      $bmp = [System.Drawing.Bitmap]::new([string]$req.imagePath)
      $ox = [int]$req.offsetX; $oy = [int]$req.offsetY; $cw = $bmp.Width; $ch = $bmp.Height
      $fw = $cw; $fh = $ch
      if ($req.frameW) { $fw = [int]$req.frameW }; if ($req.frameH) { $fh = [int]$req.frameH }
      if ($ox -lt 0 -or $oy -lt 0 -or $ox + $cw -gt $fw -or $oy + $ch -gt $fh) { throw 'Replay image is outside the specified frame' }
      $rect = @{ W = $fw; H = $fh; Window = $false }
      $color = @{ backend = 'replay'; pixelFormat = 'B8G8R8A8_UNORM'; hdr = $null; toneMap = 'none'; warning = 'Saved PNG cannot recover previously clipped HDR pixels' }
    } else {
      $rect = Get-GameRect
      if ($null -eq $rect) {
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $rect = @{ X = $b.X; Y = $b.Y; W = $b.Width; H = $b.Height; Window = $false }
      }
      $ox = 0; $oy = 0; $cw = $rect.W; $ch = $rect.H
      if ($req.region -ne 'full') { $ox = [int]($rect.W * 0.15); $oy = [int]($rect.H * 0.20); $cw = [int]($rect.W * 0.70); $ch = [int]($rect.H * 0.55) }
      $frame = [AmoDisplayCapture]::Capture(($rect.X + $ox), ($rect.Y + $oy), $cw, $ch)
      $bmp = $frame.Bitmap
      $color = @{ backend = $frame.Backend; pixelFormat = $frame.PixelFormat; hdr = $frame.Hdr; toneMap = $frame.ToneMap; warning = $frame.Warning }
    }
    $lines = @(); $passes = @()
    # League's centred cards scale with height, including on ultrawide displays.
    # Isolating each title avoids the zero-lines result seen with the complete band.
    foreach ($column in @(-1, 0, 1)) {
      $cx = $rect.W / 2 + $column * $rect.H * 0.34
      $left = [Math]::Max(0, [int]($cx - $rect.H * 0.145) - $ox)
      $top = [Math]::Max(0, [int]($rect.H * 0.35) - $oy)
      $right = [Math]::Min($cw, [int]($cx + $rect.H * 0.145) - $ox)
      $bottom = [Math]::Min($ch, [int]($rect.H * 0.45) - $oy)
      if ($right -le $left -or $bottom -le $top) { continue }
      $crop = $null; $scaled = $null; $g = $null
      try {
        $crop = $bmp.Clone([System.Drawing.Rectangle]::new($left, $top, ($right - $left), ($bottom - $top)), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $scale = [Math]::Min(2, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [Math]::Max($crop.Width, $crop.Height))
        $scaled = [System.Drawing.Bitmap]::new([int]($crop.Width * $scale), [int]($crop.Height * $scale))
        $g = [System.Drawing.Graphics]::FromImage($scaled)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($crop, 0, 0, $scaled.Width, $scaled.Height); $g.Dispose(); $g = $null
        $lines += @(Read-OcrBitmap $scaled ($left + $ox) ($top + $oy) $scale)
      } finally { if ($g) { $g.Dispose() }; if ($scaled) { $scaled.Dispose() }; if ($crop) { $crop.Dispose() } }
    }
    $passes += 'titles-2x'
    # Keep broad-band evidence for alternate layouts, wrapped titles and diagnosis.
    $scale = [Math]::Min(1, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [Math]::Max($cw, $ch))
    if ($scale -lt 1) {
      $small = [System.Drawing.Bitmap]::new($bmp, [int]($cw * $scale), [int]($ch * $scale))
      try { $lines += @(Read-OcrBitmap $small $ox $oy $scale) } finally { $small.Dispose() }
    } else { $lines += @(Read-OcrBitmap $bmp $ox $oy) }
    $passes += 'band'
    # Screenshot persistence must never discard otherwise usable OCR results.
    $saveError = $null
    if ($req.saveTo) {
      try { $bmp.Save([string]$req.saveTo, [System.Drawing.Imaging.ImageFormat]::Png) }
      catch { $saveError = $_.Exception.Message }
    }
    return @{ ok = $true; w = $rect.W; h = $rect.H; window = $rect.Window; region = @{ x = $ox; y = $oy; w = $cw; h = $ch }; color = $color; passes = $passes; saveError = $saveError; ms = $sw.ElapsedMilliseconds; lines = $lines }
  } finally {
    if ($frame) { $frame.Dispose() } elseif ($bmp) { $bmp.Dispose() }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { $req = $line | ConvertFrom-Json } catch { Emit @{ ok = $false; error = "bad request" }; continue }
  if (-not $req.cmd) { Emit @{ ok = $false; error = 'no cmd' }; continue }
  switch ($req.cmd) {
    'ping'    { Emit @{ ok = $true; pong = $true } }
    'quit'    { exit 0 }
    'capture' { try { Emit (Capture $req) } catch { Emit @{ ok = $false; error = $_.Exception.Message } } }
    default   { Emit @{ ok = $false; error = "unknown cmd" } }
  }
}
