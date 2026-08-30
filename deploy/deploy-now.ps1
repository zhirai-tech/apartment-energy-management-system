$ErrorActionPreference = 'Continue'
Write-Host '=== STOP SERVICE ==='
sc.exe stop zaem-server | Out-Null
Start-Sleep -Seconds 18
Write-Host '=== EXTRACT SERVER ==='
tar.exe -xzf C:\zaem-deploy\server-dist.tar.gz -C C:\zaem\server
Write-Host ('SERVER_EXTRACT=' + $LASTEXITCODE)
Write-Host '=== CLEAN CLIENT DIST ==='
if (Test-Path 'C:\zaem\client\dist') { Remove-Item -Recurse -Force 'C:\zaem\client\dist' }
Write-Host '=== EXTRACT CLIENT ==='
tar.exe -xzf C:\zaem-deploy\client-dist.tar.gz -C C:\zaem\client
Write-Host ('CLIENT_EXTRACT=' + $LASTEXITCODE)
Write-Host '=== OVERWRITE RUNTIME-CONFIG ==='
[System.IO.File]::WriteAllText('C:\zaem\client\dist\runtime-config.js', "window.__ZAEM_RUNTIME_CONFIG__ = {`n  apiBaseUrl: '/api',`n  socketUrl: '',`n  socketPath: '/socket.io',`n};", (New-Object System.Text.UTF8Encoding($false)))
Get-Content 'C:\zaem\client\dist\runtime-config.js'
Write-Host '=== START SERVICE ==='
sc.exe start zaem-server
Start-Sleep -Seconds 6
sc.exe query zaem-server
Write-Host 'DONE'
