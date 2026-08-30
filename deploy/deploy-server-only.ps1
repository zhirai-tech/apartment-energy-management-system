$ErrorActionPreference = 'Continue'
Write-Host '=== STOP SERVICE ==='
sc.exe stop zaem-server | Out-Null
Start-Sleep -Seconds 18
Write-Host '=== EXTRACT SERVER ==='
tar.exe -xzf C:\zaem-deploy\server-dist.tar.gz -C C:\zaem\server
Write-Host ('SERVER_EXTRACT=' + $LASTEXITCODE)
Write-Host '=== START SERVICE ==='
sc.exe start zaem-server | Out-Null
Start-Sleep -Seconds 6
sc.exe query zaem-server | Out-String
Write-Host '=== KILL LEFTOVER FFMPEG ==='
Get-Process ffmpeg -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('killing ' + $_.Id); Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Write-Host 'DONE'
