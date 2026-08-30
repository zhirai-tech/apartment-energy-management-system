$ErrorActionPreference = 'Continue'
Write-Host '=== SERVICE STATE ==='
sc.exe query zaem-server | Select-String 'STATE' | ForEach-Object { Write-Host $_.Line.Trim() }
Write-Host '=== LOG TAIL (stdout) ==='
Get-Content 'C:\zaem\server\logs\stdout.log' -Tail 8
Write-Host '=== LOG TAIL (stderr) ==='
$sf = Get-ChildItem 'C:\zaem\server\logs\stderr*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($sf) { Get-Content $sf.FullName -Tail 15 }
Write-Host 'DONE'
