# Smart Watt v2 - one-command start on Windows.
#   .\run.ps1              synthetic data (no hardware)
#   .\run.ps1 -Source both simulator + real ESP32 over MQTT
#   .\run.ps1 -Source mqtt real hardware only
param(
    [ValidateSet("sim", "mqtt", "both")] [string]$Source = "sim",
    [int]$Port = 8000
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

Write-Host "Checking Python packages..."
python -m pip install --quiet -r requirements.txt

if (-not (Test-Path "frontend\dist\index.html")) {
    Write-Host "Building dashboard (first run)..."
    Push-Location frontend
    if (-not (Test-Path "node_modules")) { npm install --no-audit --no-fund }
    npm run build
    Pop-Location
}

$env:SW_SOURCE = $Source
$env:SW_PORT = "$Port"
Write-Host ""
Write-Host "Smart Watt v2 -> http://localhost:$Port   (source: $Source)"
Write-Host "Sign in as home / home123 (homeowner) or utility / utility123 (read-only)."
python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $Port
