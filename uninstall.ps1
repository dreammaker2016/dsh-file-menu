# dsh-file-menu uninstaller (ASCII-only messages, see install.ps1 note).
param([string]$Profile = 'desktop')

$ErrorActionPreference = 'Stop'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

if (Test-Path $patchPath) {
    $text = [System.IO.File]::ReadAllText($patchPath)
    $next = [regex]::Replace($text, '(?ms)^- insert:\s*\r?\n\s+- id: file-menu\r?\n\s+name: dsh-file-menu\r?\n', '')
    if ($next -ne $text) {
        [System.IO.File]::WriteAllText($patchPath, $next, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[uninstall] patch row removed: $patchPath"
    } else {
        Write-Host "[uninstall] patch row not found (already removed?)"
    }
}

$target = Join-Path $profileDir 'node_modules\dsh-file-menu'
if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
    Write-Host "[uninstall] package removed: $target"
} else {
    Write-Host "[uninstall] package not installed"
}

Write-Host "[uninstall] restart DSH Desktop to unload the plugin"
