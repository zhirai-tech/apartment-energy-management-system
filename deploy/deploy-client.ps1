$ErrorActionPreference = 'Continue'
Write-Host '=== CLEAN OLD DIST ==='
if (Test-Path 'C:\zaem\client\dist') { Remove-Item -Recurse -Force 'C:\zaem\client\dist' }
Write-Host '=== EXTRACT ==='
tar.exe -xzf 'C:\zaem-deploy\client-dist.tar.gz' -C 'C:\zaem\client'
Write-Host ('EXTRACT_EXIT=' + $LASTEXITCODE)
Write-Host '=== OVERWRITE RUNTIME-CONFIG ==='
$cfg = @"
window.__ZAEM_RUNTIME_CONFIG__ = {
  apiBaseUrl: "/api",
  socketUrl: "",
  socketPath: "/socket.io",
};
"@
[System.IO.File]::WriteAllText('C:\zaem\client\dist\runtime-config.js', $cfg, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '=== VERIFY FILES ==='
Get-ChildItem 'C:\zaem\client\dist' -Recurse -File | ForEach-Object { Write-Host ($_.FullName.Replace('C:\zaem\client\dist\', '')) }
Write-Host '=== RUNTIME-CONFIG ==='
Get-Content 'C:\zaem\client\dist\runtime-config.js'
Write-Host 'DONE'
