$ErrorActionPreference = 'Continue'
$roots = @(
  'd:\ZHIRAI Apartment Energy Manager\server\src',
  'd:\ZHIRAI Apartment Energy Manager\client\src',
  'd:\ZHIRAI Apartment Energy Manager\shared'
)
$rows = @()
foreach ($r in $roots) {
  Get-ChildItem -Path $r -Recurse -Include *.ts,*.tsx -File -ErrorAction SilentlyContinue | ForEach-Object {
    $lines = (Get-Content $_.FullName | Measure-Object -Line).Lines
    $rows += [PSCustomObject]@{ Lines = $lines; File = $_.FullName.Replace('d:\ZHIRAI Apartment Energy Manager\','') }
  }
}
Write-Host '=== TOP 45 SOURCE FILES BY LINES ==='
$rows | Sort-Object Lines -Descending | Select-Object -First 45 | ForEach-Object { Write-Host ($_.Lines.ToString().PadLeft(6) + '  ' + $_.File) }
Write-Host ''
Write-Host ('TOTAL_TS_FILES=' + $rows.Count)
Write-Host 'DONE'
