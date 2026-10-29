<#
.SYNOPSIS
  Converts every .otf font in a folder to .woff2.
.EXAMPLE
  .\Convert-OtfToWoff2.ps1
  .\Convert-OtfToWoff2.ps1 -DashboardNames
  .\Convert-OtfToWoff2.ps1 -Path "C:\Fonts\GT" -OutDir "C:\repo\public\fonts" -DashboardNames
#>
param(
    [string]$Path = ".",
    [string]$OutDir = "",
    # Name the outputs GTWalsheim-Regular/Medium/Bold.woff2 to match styles.css
    [switch]$DashboardNames
)
$ErrorActionPreference = 'Stop'

# 1. Find Python
$py = $null; $pyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) { $py = 'py'; $pyArgs = @('-3') }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $py = 'python' }
if (-not $py) {
    throw "Python 3 not found. Install it (e.g. 'winget install Python.Python.3.12') and run this again."
}

# Run Python without letting stderr output trip $ErrorActionPreference = 'Stop'.
# Callers check $LASTEXITCODE instead.
function Invoke-Py {
    param([switch]$Quiet, [Parameter(ValueFromRemainingArguments)][string[]]$PyCmd)
    $ErrorActionPreference = 'Continue'   # local to this function
    if ($Quiet) { & $py @pyArgs @PyCmd *> $null }
    else        { & $py @pyArgs @PyCmd 2>&1 | ForEach-Object { "$_" } }
}

# 2. Make sure fontTools + brotli (needed for woff2) are installed
Invoke-Py -Quiet -c "import fontTools, brotli"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing fonttools and brotli..." -ForegroundColor Cyan
    Invoke-Py -m pip install --user --quiet fonttools brotli
    if ($LASTEXITCODE -ne 0) { throw "pip install failed. Try: $py -m pip install fonttools brotli" }
}

# 3. Convert
$src = (Resolve-Path $Path).Path
$dst = if ($OutDir) { New-Item -ItemType Directory -Force -Path $OutDir | Select-Object -ExpandProperty FullName } else { $src }
$fonts = Get-ChildItem -Path $src -Filter *.otf -File
if (-not $fonts) { Write-Warning "No .otf files found in $src"; return }

# Single quotes inside the Python code: PS 5.1 strips embedded double quotes when calling native exes
$convert = "import sys; from fontTools.ttLib import TTFont; f = TTFont(sys.argv[1]); f.flavor = 'woff2'; f.save(sys.argv[2])"

foreach ($font in $fonts) {
    $name = $font.BaseName
    if ($DashboardNames -and $name -match '(?i)(?<!extra|semi|ultra|demi)(Regular|Medium|Bold)$' -and $name -notmatch '(?i)italic|oblique') {
        $weight = (Get-Culture).TextInfo.ToTitleCase($Matches[1].ToLower())
        $name = "GTWalsheim-$weight"
    }
    $out = Join-Path $dst "$name.woff2"
    Invoke-Py -c $convert $font.FullName $out
    if ($LASTEXITCODE -ne 0) { Write-Warning "Failed: $($font.Name)"; continue }
    $before = [math]::Round($font.Length / 1KB, 1)
    $after  = [math]::Round((Get-Item $out).Length / 1KB, 1)
    Write-Host ("{0,-40} -> {1,-30} {2,7} KB -> {3,6} KB" -f $font.Name, "$name.woff2", $before, $after) -ForegroundColor Green
}
Write-Host "`nDone. Output: $dst"