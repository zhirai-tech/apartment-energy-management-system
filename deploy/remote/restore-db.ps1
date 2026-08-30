$ErrorActionPreference = 'Continue'
Start-Transcript -Path 'C:\zaem-deploy\restore-db.log' -Force
$psql = 'C:\pgsql\bin\psql.exe'

# 停止应用服务避免连接占用
$svc = Get-Service 'zaem-server' -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { Stop-Service 'zaem-server' -Force; Start-Sleep 2 }

Write-Host 'DROP_CREATE_DB...'
& $psql -U postgres -h localhost -p 5432 -c 'DROP DATABASE IF EXISTS zaem_db WITH (FORCE);' 2>&1
& $psql -U postgres -h localhost -p 5432 -c "CREATE DATABASE zaem_db OWNER zaem ENCODING 'UTF8';" 2>&1

Write-Host 'RESTORING_DUMP...'
& $psql -U zaem -h localhost -p 5432 -d zaem_db -f 'C:\zaem-deploy\zaem-dump.sql' 2>&1
Write-Host ("RESTORE_EXIT=" + $LASTEXITCODE)

$c = & $psql -U zaem -h localhost -p 5432 -d zaem_db -tAc 'SELECT (SELECT count(*) FROM "User")::text || chr(124) || (SELECT count(*) FROM "Device")::text || chr(124) || (SELECT count(*) FROM "DailyEnergy")::text || chr(124) || (SELECT count(*) FROM "HourlyEnergy")::text || chr(124) || (SELECT count(*) FROM "Room")::text;' 2>&1
Write-Host ("COUNTS_USER_DEVICE_DAILY_HOURLY_ROOM=" + ($c -join ''))

$mig = & $psql -U zaem -h localhost -p 5432 -d zaem_db -tAc 'SELECT count(*) FROM _prisma_migrations;' 2>&1
Write-Host ("MIGRATIONS=" + ($mig -join ''))

Stop-Transcript
Write-Host 'RESTORE_DONE'
