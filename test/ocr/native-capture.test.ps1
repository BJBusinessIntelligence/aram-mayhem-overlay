# Run on Windows: powershell -NoProfile -File test/ocr/native-capture.test.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Path "$PSScriptRoot/../../src/ocr/display-capture.cs" -ReferencedAssemblies System.Drawing
function Assert($condition, $message) { if (-not $condition) { throw $message } }
Assert ([AmoDisplayCapture]::ToneMapHalf(0) -eq 0) 'black stays black'
Assert ([AmoDisplayCapture]::ToneMapHalf(0x3c00) -eq 188) 'linear SDR white maps to sRGB 188 with Reinhard'
Assert ([AmoDisplayCapture]::ToneMapHalf(0x4000) -gt 188) '2x SDR white must retain detail above SDR white'
Assert ([AmoDisplayCapture]::ToneMapHalf(0x4400) -gt [AmoDisplayCapture]::ToneMapHalf(0x4000)) '4x white must not clip to 2x white'
Assert ([AmoDisplayCapture]::ToneMapHalf(0xbc00) -eq 0) 'negative scRGB clamps to black'
Assert ([AmoDisplayCapture]::ToneMapHalf(0x7e00) -eq 0) 'NaN is deterministic black'
Assert ([AmoDisplayCapture]::ToneMapHalf(0x7c00) -eq 255) 'infinity saturates safely'
$sdr = [AmoDisplayCapture]::ConvertRow([byte[]](99,99,99,0, 10,20,30,0, 77,77,77,77), 1, 1, 87)
Assert (($sdr -join ',') -eq '10,20,30,255') 'SDR crop preserves BGR and makes alpha opaque'
$hdr = [AmoDisplayCapture]::ConvertRow([byte[]](0,0,0,0,0,0,0,0, 0,60,0,0,0,64,0,60, 99,99), 1, 1, 10)
Assert (($hdr -join ',') -eq '213,0,188,255') 'FP16 RGBA converts to BGRA with crop and row padding'
Write-Output 'PASS: HDR tone mapping and pixel conversion'
