param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# 单实例：已经有宿主在跑就直接退出，避免重启后残留多个会话（壁纸读到的是旧会话 → 封面/标题不刷新）
$createdNew = $false
try {
  $script:mutex = New-Object System.Threading.Mutex($true, 'Global\AnniePlayerSMTC', [ref]$createdNew)
  if (-not $createdNew) { [Console]::Out.WriteLine('{"ok":false,"msg":"already-running"}'); exit 0 }
}
catch { }

# 父进程（播放器）退出就跟着退：Electron 被强杀时 stdin 不一定收到 EOF
if ($ParentPid -gt 0) {
  try {
    # 注意：定时器回调在别的线程/作用域里跑，$script: 变量读不到，直接把 pid 写进脚本块字面量
    $body = "try { `$null = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { [Environment]::Exit(0) }"
    $sb = [scriptblock]::Create($body)
    $timer = New-Object System.Timers.Timer 5000
    $timer.AutoReset = $true
    $timer.add_Elapsed($sb)
    $timer.Start()
  }
  catch { }
}

$null = [Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]
$null = [Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaPlaybackStatus, Windows.Media, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaPlaybackType, Windows.Media, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, $t) {
  $m = $asTaskGeneric.MakeGenericMethod($t)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

try {
  $sig = @'
using System;
using System.Runtime.InteropServices;
public static class AnnieAumid {
  [DllImport("shell32.dll", SetLastError = true)]
  public static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string appid);
}
'@
  Add-Type -TypeDefinition $sig -ErrorAction Stop
  [void][AnnieAumid]::SetCurrentProcessExplicitAppUserModelID('AnniePlayer.Fusion.SMTC')
}
catch { }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here 'silent.wav'

function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

try {
  $player = New-Object Windows.Media.Playback.MediaPlayer
  $player.IsLoopingEnabled = $true
  $player.Volume = 0.01
  $player.Source = [Windows.Media.Core.MediaSource]::CreateFromUri([Uri]$src)
  $script:smtc = $player.SystemMediaTransportControls
  $smtc.IsEnabled = $true
  $smtc.IsPlayEnabled = $false
  $smtc.IsPauseEnabled = $false
  $smtc.IsNextEnabled = $false
  $smtc.IsPreviousEnabled = $false
  $script:du = $smtc.DisplayUpdater
  $du.Type = [Windows.Media.MediaPlaybackType]::Music
  $player.Play()
  Say @{ ok = $true; msg = 'smtc-ready' }
}
catch {
  Say @{ ok = $false; msg = $_.Exception.Message }
  exit 1
}

$coverTmp = Join-Path $env:TEMP 'annie-smtc-cover.jpg'
$lastCoverKey = ''

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  try {
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $o = $json | ConvertFrom-Json
    if ($o.cmd -eq 'quit') { break }

    $mp = $du.MusicProperties
    if ($null -ne $o.title) { $mp.Title = [string]$o.title }
    if ($null -ne $o.artist) { $mp.Artist = [string]$o.artist }
    if ($null -ne $o.album) { $mp.AlbumTitle = [string]$o.album }

    if ($o.cover -and $o.cover -ne $lastCoverKey) {
      try {
        $bytes = [Convert]::FromBase64String([string]$o.cover)
        [IO.File]::WriteAllBytes($coverTmp, $bytes)
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($coverTmp)) ([Windows.Storage.StorageFile])
        $du.Thumbnail = [Windows.Storage.Streams.RandomAccessStreamReference]::CreateFromFile($file)
        $lastCoverKey = $o.cover
      }
      catch { }
    }
    $du.Update()

    if ($null -ne $o.playing) {
      if ($o.playing) { $smtc.PlaybackStatus = [Windows.Media.MediaPlaybackStatus]::Playing; $player.Play() }
      else { $smtc.PlaybackStatus = [Windows.Media.MediaPlaybackStatus]::Paused; $player.Pause() }
    }
    Say @{ ok = $true; msg = 'updated'; title = [string]$mp.Title; artist = [string]$mp.Artist }
  }
  catch {
    Say @{ ok = $false; msg = $_.Exception.Message }
  }
}

try { $player.Dispose() } catch { }
