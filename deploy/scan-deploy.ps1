$ErrorActionPreference = 'Continue'
Set-Location 'd:\ZHIRAI Apartment Energy Manager'
Write-Host '=== ROOT artifacts git state ==='
git check-ignore -v server-dist.tar.gz zaem-dump.sql deploy/server-dist.tar.gz deploy/client-dist.tar.gz deploy/remote.env 2>&1
Write-Host '(no output above = NOT ignored)'
Write-Host ''
Write-Host '=== git status for root artifacts ==='
git status --short server-dist.tar.gz zaem-dump.sql 2>&1
Write-Host ''
Write-Host '=== deploy scripts that reference other deploy files (import/call) ==='
$deployFiles = Get-ChildItem 'deploy' -File | Select-Object -ExpandProperty Name
$deployScripts = Get-ChildItem 'deploy' -File -Include *.ps1,*.js,*.mjs -Recurse -ErrorAction SilentlyContinue
foreach ($f in $deployScripts) {
  $content = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
  $refs = @()
  foreach ($name in $deployFiles) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($name)
    if ($name -ne $f.Name -and $content -match [regex]::Escape($base)) {
      $refs += $name
    }
  }
  if ($refs.Count -gt 0) {
    Write-Host ($f.Name + ' -> ' + ($refs -join ', '))
  }
}
Write-Host ''
Write-Host '=== deploy dir sizes ==='
Get-ChildItem 'deploy' -File | Sort-Object Length -Descending | Select-Object -First 15 | ForEach-Object { Write-Host ($_.Length.ToString().PadLeft(10) + '  ' + $_.Name) }
Write-Host 'DONE'
