$ErrorActionPreference = 'Continue'
$psql = 'C:\pgsql\bin\psql.exe'
$env:PGPASSWORD = 'zaem_password'
$sqlFile = 'C:\zaem-deploy\cleanup.sql'
[System.IO.File]::WriteAllText($sqlFile, "DELETE FROM _prisma_migrations WHERE migration_name = '20260829000000_add_energy_limit_enabled' AND finished_at IS NULL;", (New-Object System.Text.UTF8Encoding($false)))
& $psql -U zaem -h localhost -p 5432 -d zaem_db -f $sqlFile 2>&1
Write-Host ("CLEANUP_EXIT=" + $LASTEXITCODE)
$c = & $psql -U zaem -h localhost -p 5432 -d zaem_db -tAc 'SELECT count(*) FROM _prisma_migrations;' 2>&1
Write-Host ("MIGRATIONS_NOW=" + ($c -join ''))
