# Persistent OCR worker. Protocol: one JSON object per stdin line -> one JSON object per stdout line.
# Requires Windows PowerShell 5.1 (WinRT projection). Never exits on a bad frame.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
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

function Capture($req) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $rect = Get-GameRect
  if ($null -eq $rect) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $rect = @{ X = $b.X; Y = $b.Y; W = $b.Width; H = $b.Height; Window = $false }
  }
  $ox = 0; $oy = 0; $cw = $rect.W; $ch = $rect.H
  if ($req.region -ne 'full') { $ox = [int]($rect.W * 0.15); $oy = [int]($rect.H * 0.20); $cw = [int]($rect.W * 0.70); $ch = [int]($rect.H * 0.55) }
  $bmp = New-Object System.Drawing.Bitmap $cw, $ch
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.X + $ox, $rect.Y + $oy, 0, 0, $bmp.Size); $g.Dispose()
  if ($req.saveTo) { $bmp.Save([string]$req.saveTo, [System.Drawing.Imaging.ImageFormat]::Png) }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
  $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($ras.GetOutputStreamAt(0))
  $writer.WriteBytes($ms.ToArray())
  $null = Await ($writer.StoreAsync()) ([UInt32]); $null = $writer.DetachStream(); $ras.Seek(0)
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($l in $res.Lines) {
    $ws = @($l.Words); if ($ws.Length -eq 0) { continue }
    $r0 = $ws[0].BoundingRect; $rN = $ws[$ws.Length - 1].BoundingRect
    $lines += @{ text = $l.Text; x = [int]($r0.X + $ox); y = [int]($r0.Y + $oy); w = [int]($rN.X + $rN.Width - $r0.X); h = [int]$r0.Height }
  }
  return @{ ok = $true; w = $rect.W; h = $rect.H; window = $rect.Window; region = @{ x = $ox; y = $oy; w = $cw; h = $ch }; ms = $sw.ElapsedMilliseconds; lines = $lines }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { $req = $line | ConvertFrom-Json } catch { Emit @{ ok = $false; error = "bad request" }; continue }
  switch ($req.cmd) {
    'ping'    { Emit @{ ok = $true; pong = $true } }
    'quit'    { exit 0 }
    'capture' { try { Emit (Capture $req) } catch { Emit @{ ok = $false; error = $_.Exception.Message } } }
    default   { Emit @{ ok = $false; error = "unknown cmd" } }
  }
}
