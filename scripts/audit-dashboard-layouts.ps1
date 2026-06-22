param(
  [string]$BaseDashboardUrl = "http://127.0.0.1:3000/dashboard",
  [string]$OutputDir = "layout-audit-shots",
  [string]$EdgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  [int]$VirtualTimeBudgetMs = 5000,
  [switch]$RequireTelemetry
)

$ErrorActionPreference = "Stop"

$layouts = @(
  "race",
  "time-attack",
  "engineer",
  "mobile-race",
  "minimal",
  "gforce",
  "road-car"
)

$viewports = @(
  @{ Name = "desktop"; Width = 1366; Height = 768 },
  @{ Name = "mobile-landscape"; Width = 844; Height = 390 }
)

function Get-DashboardUrl {
  param(
    [string]$BaseUrl,
    [string]$Layout
  )

  $separator = if ($BaseUrl.Contains("?")) { "&" } else { "?" }
  return "${BaseUrl}${separator}layout=${Layout}"
}

function Get-StatusUrl {
  param(
    [string]$BaseUrl
  )

  try {
    $uri = [System.Uri]$BaseUrl
    return "{0}://{1}/api/status" -f $uri.Scheme, $uri.Authority
  } catch {
    return $null
  }
}

function Test-TelemetryStatus {
  param(
    [string]$BaseUrl,
    [switch]$RequireTelemetry
  )

  $statusUrl = Get-StatusUrl -BaseUrl $BaseUrl
  if (-not $statusUrl) {
    Write-Warning "Could not derive /api/status URL from '$BaseUrl'."
    return
  }

  try {
    $status = Invoke-RestMethod -UseBasicParsing -Uri $statusUrl -TimeoutSec 3
  } catch {
    $message = "Failed to read telemetry status from '$statusUrl': $($_.Exception.Message)"
    if ($RequireTelemetry) {
      throw $message
    }
    Write-Warning $message
    return
  }

  if ($status.hasTelemetry -eq $true) {
    Write-Output "Telemetry status: ready ($($status.receivedPacketCount) packets, mock=$($status.mockTelemetry))."
    return
  }

  $message = "Telemetry status: no snapshot yet. Screenshots may show the waiting state."
  if ($RequireTelemetry) {
    throw $message
  }
  Write-Warning $message
}

function Draw-ImageFit {
  param(
    [System.Drawing.Graphics]$Graphics,
    [string]$Path,
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height
  )

  $image = [System.Drawing.Image]::FromFile($Path)
  try {
    $ratio = [Math]::Min($Width / $image.Width, $Height / $image.Height)
    $drawWidth = [int]($image.Width * $ratio)
    $drawHeight = [int]($image.Height * $ratio)
    $drawX = $X + [int](($Width - $drawWidth) / 2)
    $drawY = $Y + [int](($Height - $drawHeight) / 2)
    $Graphics.DrawImage($image, $drawX, $drawY, $drawWidth, $drawHeight)
  } finally {
    $image.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $EdgePath)) {
  throw "Microsoft Edge was not found at '$EdgePath'. Pass -EdgePath to override."
}

Test-TelemetryStatus -BaseUrl $BaseDashboardUrl -RequireTelemetry:$RequireTelemetry

$outputRoot = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
  $OutputDir
} else {
  Join-Path (Get-Location) $OutputDir
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

foreach ($layout in $layouts) {
  foreach ($viewport in $viewports) {
    $fileName = "{0}-{1}.png" -f $layout, $viewport.Name
    $shotPath = Join-Path $outputRoot $fileName
    $url = Get-DashboardUrl -BaseUrl $BaseDashboardUrl -Layout $layout

    & $EdgePath `
      --headless=new `
      --disable-gpu `
      --no-sandbox `
      "--window-size=$($viewport.Width),$($viewport.Height)" `
      "--virtual-time-budget=$VirtualTimeBudgetMs" `
      "--screenshot=$shotPath" `
      $url | Out-Null
  }
}

Add-Type -AssemblyName System.Drawing

$thumbWidth = 420
$thumbHeight = 236
$labelHeight = 30
$columns = $viewports.Count
$rows = $layouts.Count
$sheetWidth = $thumbWidth * $columns
$sheetHeight = ($thumbHeight + $labelHeight) * $rows
$sheet = New-Object System.Drawing.Bitmap $sheetWidth, $sheetHeight
$graphics = [System.Drawing.Graphics]::FromImage($sheet)
$font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)

try {
  $graphics.Clear([System.Drawing.Color]::FromArgb(5, 6, 7))

  for ($row = 0; $row -lt $layouts.Count; $row++) {
    $layout = $layouts[$row]

    for ($column = 0; $column -lt $viewports.Count; $column++) {
      $viewport = $viewports[$column]
      $x = $column * $thumbWidth
      $y = $row * ($thumbHeight + $labelHeight)
      $label = "{0} - {1}" -f $layout, $viewport.Name
      $shotPath = Join-Path $outputRoot ("{0}-{1}.png" -f $layout, $viewport.Name)

      $graphics.DrawString($label, $font, $brush, $x + 8, $y + 5)
      Draw-ImageFit `
        -Graphics $graphics `
        -Path $shotPath `
        -X $x `
        -Y ($y + $labelHeight) `
        -Width $thumbWidth `
        -Height $thumbHeight
    }
  }

  $sheetPath = Join-Path $outputRoot "layout-audit-contact-sheet.png"
  $sheet.Save($sheetPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "Dashboard layout audit screenshots written to: $outputRoot"
  Write-Output "Contact sheet: $sheetPath"
} finally {
  $brush.Dispose()
  $font.Dispose()
  $graphics.Dispose()
  $sheet.Dispose()
}
