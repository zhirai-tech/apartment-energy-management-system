$ErrorActionPreference = 'Continue'
Set-Location 'd:\ZHIRAI Apartment Energy Manager'
Write-Host '=== GIT STATUS (short) ==='
git status --short 2>&1 | Select-Object -First 80
Write-Host ''
Write-Host '=== GIT REMOTE ==='
git remote -v 2>&1
Write-Host ''
Write-Host '=== GIT BRANCH ==='
git branch -vv 2>&1
Write-Host ''
Write-Host '=== GIT LOG (last 5) ==='
git log --oneline -5 2>&1
Write-Host 'DONE'
