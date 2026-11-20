#requires -Version 5.1
<#
  One-command installer for the Antigravity UI tweak panel.

    irm https://raw.githubusercontent.com/bai-b/antigravity-ui-tweaks/main/install.ps1 | iex
    .\install.ps1                 install or update
    .\install.ps1 -Verify         read back on-disk state, change nothing
    .\install.ps1 -Uninstall      remove plugin directory and sidecar entry
    .\install.ps1 -Source PATH    use a local checkout instead of downloading

  Messages stay ASCII on purpose: Windows PowerShell 5.1 decodes a BOM-less
  script with the ANSI code page, which mangles non-ASCII text.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Verify,
    [string]$Source
)

# Running from an extracted release package: use the files next to this script
# instead of downloading, so the zip works offline.
if (-not $Source -and $PSScriptRoot) {
    $localManifest = Join-Path $PSScriptRoot 'plugin.json'
    if (Test-Path -LiteralPath $localManifest) { $Source = $PSScriptRoot }
}

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$PluginId  = 'antigravity-ui-tweaks'
$SidecarId = 'antigravity-ui-tweaks/theme'
$AuditKey  = 'antigravity-ui-tweaks-audit'
$RepoZip   = @(
    'https://codeload.github.com/bai-b/antigravity-ui-tweaks/zip/refs/heads/main',
    'https://api.github.com/repos/bai-b/antigravity-ui-tweaks/zipball/main',
    'https://cdn.jsdelivr.net/gh/bai-b/antigravity-ui-tweaks@main/plugin.json'
)
$ConfigDir = Join-Path $env:USERPROFILE '.gemini\config'
$Plugins   = Join-Path $ConfigDir 'plugins'
$Dest      = Join-Path $Plugins $PluginId
$Settings  = Join-Path $ConfigDir 'config.json'
$Backups   = Join-Path $ConfigDir '.ui-tweaks-backups'
$Payload   = @('plugin.json', 'skills', 'sidecars')
$MinNode   = [version]'22.13'

$JsonHelper = @'
const fs = require('fs');
const cfgPath = process.env.AGY_CFG;
const kind = process.env.AGY_KIND;
const id = process.env.AGY_ID;
const on = process.env.AGY_SET === '1';
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')) || {};
} catch (error) {
  if (fs.existsSync(cfgPath)) throw error;
}
if (!cfg.sidecars || typeof cfg.sidecars !== 'object') cfg.sidecars = {};
if (kind === 'sidecar') {
  if (on) cfg.sidecars[id] = Object.assign({}, cfg.sidecars[id] || {}, { enabled: true });
  else delete cfg.sidecars[id];
} else if (!on) {
  delete cfg[kind];
}
fs.mkdirSync(require('path').dirname(cfgPath), { recursive: true });
const temporary = cfgPath + '.ui-tweaks-tmp';
fs.writeFileSync(temporary, JSON.stringify(cfg, null, 2) + '\n');
fs.renameSync(temporary, cfgPath);
'@

function Get-NodeVersion {
    try { $text = (& node --version 2>$null) } catch { return $null }
    if (-not $text) { return $null }
    if ($text.Trim() -match '^v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    return $null
}

function Test-Prerequisite {
    $node = Get-NodeVersion
    if (-not $node) {
        Write-Host 'node was not found. The panel launches with the node on PATH; install Node.js 22.13 or newer.' -ForegroundColor Yellow
        return $false
    }
    if ($node -lt $MinNode) {
        Write-Host ("node v{0} is too old; 22.13 or newer is required (session store uses node:sqlite)." -f $node) -ForegroundColor Yellow
        return $false
    }
    Write-Host ("node v{0}" -f $node)
    return $true
}

function Read-Settings {
    if (-not (Test-Path $Settings)) { return $null }
    $raw = Get-Content -LiteralPath $Settings -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
}

function Update-Config([string]$kind, [bool]$enabled) {
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    if (Test-Path $Settings) {
        New-Item -ItemType Directory -Force -Path $Backups | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item -LiteralPath $Settings -Destination (Join-Path $Backups ("config-{0}.json" -f $stamp)) -Force
    }
    $helper = Join-Path ([IO.Path]::GetTempPath()) ("agy-ui-tweaks-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cjs')
    [IO.File]::WriteAllText($helper, $JsonHelper, (New-Object Text.UTF8Encoding($false)))
    try {
        $env:AGY_CFG = $Settings
        $env:AGY_KIND = $kind
        $env:AGY_ID = $SidecarId
        $env:AGY_SET = $(if ($enabled) { '1' } else { '0' })
        & node $helper
        if ($LASTEXITCODE -ne 0) { throw "writing config.json failed (node exit code $LASTEXITCODE)." }
    } finally {
        Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue
        Remove-Item Env:\AGY_CFG, Env:\AGY_KIND, Env:\AGY_ID, Env:\AGY_SET -ErrorAction SilentlyContinue
    }
}

function Set-SidecarEnabled([bool]$enabled) {
    Update-Config 'sidecar' $enabled
    if ($enabled) { Write-Host ("sidecar enabled: {0}" -f $SidecarId) }
    else { Write-Host ("sidecar entry removed: {0}" -f $SidecarId) }
}


$NodeHelper = @'
const fs = require('fs');
const target = process.env.AGY_SIDECAR;
const nodeExe = process.env.AGY_NODE;
let data = {};
try {
  data = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')) || {};
} catch (error) {
  if (fs.existsSync(target)) throw error;
}
if (data.command !== nodeExe) {
  data.command = nodeExe;
  const temporary = target + '.ui-tweaks-tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(temporary, target);
}
'@

function Set-NodeCommand([string]$root) {
    # The host launches sidecars by bare name on Windows and fails; pin the absolute node path.
    $manifest = Join-Path $root 'sidecars\theme\sidecar.json'
    if (-not (Test-Path -LiteralPath $manifest)) { return $null }
    $nodeExe = $null
    try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch { return $null }
    if (-not $nodeExe) { return $null }
    $helper = Join-Path ([IO.Path]::GetTempPath()) ("agy-ui-tweaks-node-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cjs')
    [IO.File]::WriteAllText($helper, $NodeHelper, (New-Object Text.UTF8Encoding($false)))
    try {
        $env:AGY_SIDECAR = $manifest
        $env:AGY_NODE = $nodeExe
        & node $helper
        if ($LASTEXITCODE -ne 0) { throw "pinning the node path failed (node exit code $LASTEXITCODE)." }
    } finally {
        Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue
        Remove-Item Env:\AGY_SIDECAR, Env:\AGY_NODE -ErrorAction SilentlyContinue
    }
    return $nodeExe
}

function Get-Package {
    if ($Source) {
        $root = (Resolve-Path -LiteralPath $Source).Path
        foreach ($name in $Payload) {
            if (-not (Test-Path (Join-Path $root $name))) {
                throw "$root has no $name; -Source must point at the plugin checkout."
            }
        }
        Write-Host ("using local checkout {0}" -f $root)
        return $root
    }
    $work = Join-Path ([IO.Path]::GetTempPath()) ("agy-ui-tweaks-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $zip = Join-Path $work 'plugin.zip'
    $fetched = $false
    foreach ($url in $RepoZip) {
        if ($url -like '*plugin.json') { continue }
        Write-Host ('downloading the latest source from ' + $url)
        try {
            Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 120
            if ((Get-Item -LiteralPath $zip).Length -gt 1024) { $fetched = $true; break }
        } catch {
            Write-Host ('  failed: ' + $_.Exception.Message)
        }
    }
    if (-not $fetched) {
        throw 'could not download the source archive; check the network or pass -Source with a local checkout.'
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $work -Force
    $root = Get-ChildItem -LiteralPath $work -Directory | Select-Object -First 1
    if (-not $root) { throw 'the downloaded archive had no top-level directory.' }
    return $root.FullName
}

function Copy-Payload([string]$from, [string]$to) {
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    foreach ($name in $Payload) {
        $src = Join-Path $from $name
        $dst = Join-Path $to $name
        if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue }
        Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
    }
}

function Show-Result {
    $version = 'unknown'
    $manifest = Join-Path $Dest 'plugin.json'
    if (Test-Path $manifest) { $version = (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version }
    Write-Host ("installed {0} {1} -> {2}" -f $PluginId, $version, $Dest)
    if (Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue) {
        Write-Host 'Antigravity is running and does not need to be closed; restart it once and the panel shows up in Customizations and the sidebar.'
    } else {
        Write-Host 'It loads the next time Antigravity starts (Customizations -> Installed).'
    }
    Write-Host 'open the panel from chat: [panel](sidecar://antigravity-ui-tweaks/theme/)'
}

function Install-Plugin {
    if (-not (Test-Prerequisite)) { exit 1 }
    $root = Get-Package
    New-Item -ItemType Directory -Force -Path $Plugins | Out-Null
    $backup = $null
    if (Test-Path $Dest) {
        New-Item -ItemType Directory -Force -Path $Backups | Out-Null
        $backup = Join-Path $Backups ("install-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        try {
            Move-Item -LiteralPath $Dest -Destination $backup
        } catch {
            # The host keeps handles on sidecars/ and skills/; a directory move is denied.
            Write-Host 'plugin directory is held by the running app, updating files in place.'
            Copy-Item -LiteralPath $Dest -Destination $backup -Recurse -Force -ErrorAction SilentlyContinue
            foreach ($name in $Payload) {
                $src = Join-Path $root $name
                $dst = Join-Path $Dest $name
                if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue }
                Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
            }
            Set-SidecarEnabled $true
            $pinned = Set-NodeCommand $Dest
            if ($pinned) { Write-Host ("sidecar launches with {0}" -f $pinned) }
            Write-Host ("previous version copied to {0}" -f $backup)
            Show-Result
            return
        }
    }
    try {
        Copy-Payload $root $Dest
        Set-SidecarEnabled $true
        $pinned = Set-NodeCommand $Dest
        if ($pinned) { Write-Host ("sidecar launches with {0}" -f $pinned) }
    } catch {
        if ($backup -and (Test-Path $backup)) {
            if (Test-Path $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
            Move-Item -LiteralPath $backup -Destination $Dest
        }
        throw
    }
    if ($backup) { Write-Host ("previous version moved to {0}" -f $backup) }
    Show-Result
}

function Uninstall-Plugin {
    Set-SidecarEnabled $false
    if (Test-Path $Settings) {
        $data = Read-Settings
        if ($data -and $data.PSObject.Properties[$AuditKey]) {
            Update-Config $AuditKey $false
            Write-Host 'global audit hook removed.'
        }
    }
    if (Test-Path $Dest) {
        Remove-Item -LiteralPath $Dest -Recurse -Force
        Write-Host ("deleted {0}" -f $Dest)
    } else {
        Write-Host 'plugin directory was not installed.'
    }
    Write-Host 'restart Antigravity once to apply.'
}

function Test-Install {
    $problems = @()
    $version = $null
    $manifest = Join-Path $Dest 'plugin.json'
    if (Test-Path $manifest) { $version = (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version }
    else { $problems += "plugin is not deployed to $Dest" }
    foreach ($name in $Payload) {
        if (-not (Test-Path (Join-Path $Dest $name))) { $problems += "missing $name" }
    }
    $enabled = $false
    if (Test-Path $Settings) {
        try {
            $data = Read-Settings
            if ($data -and $data.sidecars -and $data.sidecars.PSObject.Properties[$SidecarId]) {
                $enabled = ($data.sidecars.PSObject.Properties[$SidecarId].Value.enabled -eq $true)
            }
        } catch { $problems += 'config.json is not readable' }
    } else { $problems += 'config.json is missing' }
    $command = $null
    $sidecarManifest = Join-Path $Dest 'sidecars\theme\sidecar.json'
    if (Test-Path -LiteralPath $sidecarManifest) {
        try { $command = (Get-Content -LiteralPath $sidecarManifest -Raw -Encoding UTF8 | ConvertFrom-Json).command } catch { }
    } else { $problems += 'sidecars/theme/sidecar.json is missing' }
    if ($command -and -not [IO.Path]::IsPathRooted($command)) {
        $problems += "sidecar command is the bare name '$command'; the host cannot resolve it on Windows - rerun install.ps1 to pin the absolute path"
    }
    $label = $(if ($version) { 'present' } else { 'missing' })
    Write-Host ("plugin directory {0} | {1}" -f $Dest, $label)
    Write-Host ("version {0}" -f $(if ($version) { $version } else { 'unknown' }))
    Write-Host ("sidecar entry {0} | {1}" -f $SidecarId, $(if ($enabled) { 'enabled' } else { 'not enabled' }))
    Write-Host ("sidecar command {0}" -f $(if ($command) { $command } else { 'unknown' }))
    $running = [bool](Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue)
    Write-Host ("Antigravity {0}" -f $(if ($running) { 'is running' } else { 'is not running' }))
    if ($problems.Count -gt 0) {
        foreach ($problem in $problems) { Write-Host ("problem: " + $problem) -ForegroundColor Yellow }
        return $false
    }
    if ($running) { Write-Host 'files and config are in place; restart Antigravity once to load the panel.' }
    return $true
}

if ($Verify) {
    if (Test-Install) { exit 0 } else { exit 1 }
}
if ($Uninstall) {
    Uninstall-Plugin
    exit 0
}
Install-Plugin
exit 0
