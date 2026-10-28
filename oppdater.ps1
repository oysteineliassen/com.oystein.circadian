# Henter siste versjon av Døgnrytmelys fra GitHub og installerer den på Homey.
# Kjør fra PowerShell:  C:\Homeyprojects\com.oystein.circadian\oppdater.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host "Henter siste versjon fra GitHub..." -ForegroundColor Cyan
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "git pull feilet. Har du endret filer lokalt? Sjekk med: git status" }

Write-Host "Installerer avhengigheter..." -ForegroundColor Cyan
npm install --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm install feilet." }

Write-Host "Installerer appen på Homey..." -ForegroundColor Cyan
homey app install
if ($LASTEXITCODE -ne 0) {
  Write-Host "Installasjonen feilet. Sier den at Homey er offline, kjør 'homey logout' og 'homey login' og prøv igjen." -ForegroundColor Yellow
  exit 1
}

Write-Host "Ferdig!" -ForegroundColor Green
