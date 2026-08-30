$ErrorActionPreference = 'Continue'
$psql = 'C:\pgsql\bin\psql.exe'
$env:PGPASSWORD = 'zaem_password'
$sql = @"
SELECT 'MIGRATIONS', count(*)::text FROM _prisma_migrations;
SELECT 'USERS', string_agg(username, ',') FROM "User";
SELECT 'ROOMS', count(*)::text FROM "Room";
SELECT 'DEVICES', count(*)::text FROM "Device";
SELECT 'DAILY_ENERGY', count(*)::text FROM "DailyEnergy";
SELECT 'HOURLY_ENERGY', count(*)::text FROM "HourlyEnergy";
SELECT 'SETTINGS', count(*)::text FROM "SystemSettings";
SELECT 'OPERATION_LOGS', count(*)::text FROM "OperationLog";
SELECT 'ALARMS', count(*)::text FROM "AlarmLog";
SELECT 'ENERGY_LIMITS', count(*)::text FROM "EnergyLimit";
"@
$sqlFile = 'C:\zaem-deploy\verify.sql'
[System.IO.File]::WriteAllText($sqlFile, $sql, (New-Object System.Text.UTF8Encoding($false)))
& $psql -U zaem -h localhost -p 5432 -d zaem_db -f $sqlFile 2>&1

Write-Host '=== migrations list ==='
& $psql -U zaem -h localhost -p 5432 -d zaem_db -f 'C:\zaem-deploy\verify-mig.sql' 2>&1

Write-Host '=== start zaem-server ==='
$svc = Get-Service 'zaem-server' -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') {
  Start-Service 'zaem-server'
  Start-Sleep 4
}
Write-Host ("ZAEM_SERVICE=" + (Get-Service 'zaem-server').Status)
