param(
  [string]$PackageName = "sim-telemetry-server-windows-x64"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ReleaseRoot = Join-Path $RepoRoot "release"
$PackageDir = Join-Path $ReleaseRoot $PackageName
$ZipPath = Join-Path $ReleaseRoot "$PackageName.zip"
$DashboardDist = Join-Path $RepoRoot "apps\dashboard\dist"
$ExePath = Join-Path $RepoRoot "target\release\sim-telemetry-server.exe"

$ReleaseRootFull = [System.IO.Path]::GetFullPath($ReleaseRoot)
$PackageDirFull = [System.IO.Path]::GetFullPath($PackageDir)
$ZipPathFull = [System.IO.Path]::GetFullPath($ZipPath)

if (-not $PackageDirFull.StartsWith($ReleaseRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to package outside release directory: $PackageDirFull"
}

Write-Host "Building dashboard..."
& npm.cmd run build:dashboard

Write-Host "Building Rust release binary..."
& cargo build -p forza-telemetry-server --release

if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "Expected executable was not found: $ExePath"
}

Write-Host "Preparing release directory..."
if (Test-Path -LiteralPath $PackageDirFull) {
  Remove-Item -LiteralPath $PackageDirFull -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPathFull) {
  Remove-Item -LiteralPath $ZipPathFull -Force
}

New-Item -ItemType Directory -Path $PackageDirFull | Out-Null

Copy-Item -LiteralPath $ExePath -Destination (Join-Path $PackageDirFull "sim-telemetry-server.exe")
Copy-Item -LiteralPath (Join-Path $RepoRoot "config.example.json") -Destination $PackageDirFull
Copy-Item -LiteralPath (Join-Path $RepoRoot "README-WINDOWS.md") -Destination $PackageDirFull

$LicensePath = Join-Path $RepoRoot "LICENSE"
if (Test-Path -LiteralPath $LicensePath) {
  Copy-Item -LiteralPath $LicensePath -Destination $PackageDirFull
}

if (-not (Test-Path -LiteralPath $DashboardDist)) {
  throw "Dashboard dist was not found after build: $DashboardDist"
}

Copy-Item -LiteralPath $DashboardDist -Destination (Join-Path $PackageDirFull "static") -Recurse

Write-Host "Creating zip artifact..."
Compress-Archive -LiteralPath $PackageDirFull -DestinationPath $ZipPathFull -Force

Write-Host ""
Write-Host "Windows package created:"
Write-Host "  $PackageDirFull"
Write-Host "  $ZipPathFull"
