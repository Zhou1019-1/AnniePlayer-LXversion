# Plus 版图标：在 icon-source.jpg 基础上叠加金色圆环（与普通版区分）
# 输出 icon.png (256x256) 与多尺寸 icon.ico（PNG-in-ICO）
Add-Type -AssemblyName System.Drawing

$buildDir = $PSScriptRoot
$srcPath = Join-Path $buildDir 'icon-source.jpg'
$pngPath = Join-Path $buildDir 'icon.png'
$icoPath = Join-Path $buildDir 'icon.ico'
$tmpDir  = Join-Path $buildDir '_icon_tmp'
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

$src = [System.Drawing.Image]::FromFile($srcPath)

# 居中裁剪为正方形
$side = [Math]::Min($src.Width, $src.Height)
$x = [int](($src.Width - $side) / 2)
$y = [int](($src.Height - $side) / 2)
$square = New-Object System.Drawing.Bitmap $side, $side
$g0 = [System.Drawing.Graphics]::FromImage($square)
$g0.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $side, $side), (New-Object System.Drawing.Rectangle $x, $y, $side, $side), [System.Drawing.GraphicsUnit]::Pixel)
$g0.Dispose()
$src.Dispose()

function Save-PlusIcon($img, $size, $outPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # 内圈内容：为金环留出空间（环宽 + 1px 间隙）
    $ringW = [Math]::Max(2.0, $size / 16.0)
    $inset = [int]([Math]::Ceiling($ringW + 1))
    $inner = $size - 2 * $inset
    if ($inner -lt 8) { $inset = 0; $inner = $size }
    $g.DrawImage($img, $inset, $inset, $inner, $inner)

    # 金环：外层暗金描边 + 主亮金环（小尺寸下也可辨）
    $rect = [System.Drawing.RectangleF]::new($ringW / 2.0, $ringW / 2.0, $size - $ringW, $size - $ringW)
    $penDark = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 176, 128, 0)), ($ringW + 1.5)
    $penGold = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 210, 63)), $ringW
    $g.DrawEllipse($penDark, $rect)
    $g.DrawEllipse($penGold, $rect)
    $penDark.Dispose(); $penGold.Dispose()
    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# 1) 各尺寸 PNG 落盘
$sizes = @(16, 24, 32, 48, 64, 128, 256)
foreach ($s in $sizes) { Save-PlusIcon $square $s (Join-Path $tmpDir "$s.png") }
$square.Dispose()

# 2) icon.png = 256x256 副本
Copy-Item (Join-Path $tmpDir '256.png') $pngPath -Force

# 3) icon.ico = PNG 容器（Vista+ 支持 PNG-in-ICO）
$pngBytes = @{}
foreach ($s in $sizes) {
    $pngBytes[$s] = [System.IO.File]::ReadAllBytes((Join-Path $tmpDir "$s.png"))
}

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
    $b = $pngBytes[$s]
    $dim = [byte]($(if ($s -ge 256) { 0 } else { $s }))
    $bw.Write($dim)
    $bw.Write($dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$b.Length)
    $bw.Write([uint32]$offset)
    $offset += $b.Length
}
foreach ($s in $sizes) { $bw.Write($pngBytes[$s]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

Remove-Item -Recurse -Force $tmpDir

Write-Host "PLUS icon.png: $((Get-Item $pngPath).Length) bytes"
Write-Host "PLUS icon.ico: $((Get-Item $icoPath).Length) bytes ($($sizes.Count) sizes)"
