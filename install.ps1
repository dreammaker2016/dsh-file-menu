# dsh-file-menu installer.
# ASCII-only on purpose: Windows PowerShell reads BOM-less UTF-8 .ps1 as GBK,
# so Chinese literals here would silently corrupt.
param([string]$Profile = 'desktop')

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if (-not (Test-Path $dshHome)) { throw "DSH home not found: $dshHome" }
$profileDir = Join-Path $dshHome "profiles\$Profile"
if (-not (Test-Path $profileDir)) { throw "DSH profile not found: $profileDir" }

$target = Join-Path $profileDir 'node_modules\dsh-file-menu'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $src 'lib') $target -Recurse -Force
Copy-Item (Join-Path $src 'package.json') $target -Force
Copy-Item (Join-Path $src 'cordis.patch.yml') $target -Force

$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$text = if (Test-Path $patchPath) { [System.IO.File]::ReadAllText($patchPath) } else { '' }
if ($text -notmatch 'id:\s*file-menu') {
    if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += "`n" }
    $text += "- insert:`n    - id: file-menu`n      name: dsh-file-menu`n"
    [System.IO.File]::WriteAllText($patchPath, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[install] patch row added: $patchPath"
} else {
    Write-Host "[install] patch row already present"
}

Write-Host "[install] package installed: $target"
Write-Host "[install] now restart DSH Desktop (tray -> Quit -> reopen) to load it"
