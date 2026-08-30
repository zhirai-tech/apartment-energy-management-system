param(
  [Parameter(Mandatory = $true)][ValidateSet('run', 'upload', 'download')][string]$Action,
  [string]$Command,
  [string]$LocalPath,
  [string]$RemotePath
)
$ErrorActionPreference = 'Stop'

$mod = Get-Module -ListAvailable Posh-SSH | Select-Object -First 1
if (-not $mod) { throw 'Posh-SSH module not found' }
$dll = Get-ChildItem (Split-Path $mod.Path) -Recurse -Filter 'Renci.SshNet.dll' | Select-Object -First 1
if (-not $dll) { throw 'Renci.SshNet.dll not found' }
[System.Reflection.Assembly]::LoadFrom($dll.FullName) | Out-Null

$hostName = '192.168.41.199'
$user = 'Administrator'
$password = '1234'

function New-ZaemConnectionInfo {
  return New-Object Renci.SshNet.PasswordConnectionInfo($hostName, 22, $user, $password)
}

function ConvertTo-SftpPath([string]$p) {
  $p = $p.Replace('\', '/')
  if (($p.Length -ge 2) -and ($p[1] -eq ':')) {
    $drive = $p.Substring(0, 1)
    $rest = $p.Substring(2)
    if ($rest -eq '') { $rest = '/' }
    return ('/' + $drive + ':' + $rest)
  }
  return $p
}

function Ensure-SftpDir($sftp, [string]$p) {
  $trimmed = $p.Trim('/')
  if ($trimmed -eq '') { return }
  $segs = $trimmed.Split('/')
  $cur = ''
  foreach ($s in $segs) {
    $isDrive = (($s.Length -eq 2) -and ($s[1] -eq ':'))
    if (($cur -eq '') -and $isDrive) {
      $cur = '/' + $s
    } else {
      if ($cur -eq '') { $cur = $s } else { $cur = $cur + '/' + $s }
    }
    if (-not $sftp.Exists($cur)) { $sftp.CreateDirectory($cur) | Out-Null }
  }
}

switch ($Action) {
  'run' {
    $ci = New-ZaemConnectionInfo
    $client = New-Object Renci.SshNet.SshClient($ci)
    $client.Connect()
    try {
      $r = $client.CreateCommand($Command)
      $r.CommandTimeout = [TimeSpan]::FromMinutes(60)
      $out = $r.Execute()
      if ($out) { Write-Host $out }
      $err = $r.Error
      if ($err) { Write-Host ("STDERR:`n" + $err) }
      Write-Host ("EXIT_CODE=" + $r.ExitStatus)
      exit $r.ExitStatus
    } finally {
      $client.Disconnect()
      $client.Dispose()
    }
  }
  'upload' {
    $ci = New-ZaemConnectionInfo
    $sftp = New-Object Renci.SshNet.SftpClient($ci)
    $sftp.Connect()
    try {
      $remote = ConvertTo-SftpPath $RemotePath
      $dir = $remote.Substring(0, $remote.LastIndexOf('/'))
      if ($dir -ne '') { Ensure-SftpDir $sftp $dir }
      $fs = [System.IO.File]::OpenRead($LocalPath)
      try {
        $sftp.UploadFile($fs, $remote, $true) | Out-Null
      } finally { $fs.Close() }
      Write-Host ("UPLOADED " + $LocalPath + " -> " + $RemotePath)
    } finally {
      $sftp.Disconnect()
      $sftp.Dispose()
    }
  }
  'download' {
    $ci = New-ZaemConnectionInfo
    $sftp = New-Object Renci.SshNet.SftpClient($ci)
    $sftp.Connect()
    try {
      $remote = ConvertTo-SftpPath $RemotePath
      $dir = [System.IO.Path]::GetDirectoryName($LocalPath)
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $fs = [System.IO.File]::Create($LocalPath)
      try {
        $sftp.DownloadFile($remote, $fs)
      } finally { $fs.Close() }
      Write-Host ("DOWNLOADED " + $RemotePath + " -> " + $LocalPath)
    } finally {
      $sftp.Disconnect()
      $sftp.Dispose()
    }
  }
}
