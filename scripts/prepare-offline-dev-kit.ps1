param(
  [string]$OutputDir,

  [switch]$SkipCacheVerify,

  [bool]$IncludeNodeRuntime = $true,

  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$repoRoot = $repoRoot.Path
$repoParent = Split-Path $repoRoot -Parent
$runtimePlatform = node -p "process.platform + '-' + process.arch"
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$npmCommand = if ($env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }

if (-not $OutputDir) {
  $OutputDir = Join-Path $repoParent "api-nova-dev-offline-$runtimePlatform-$timestamp"
}

$outputPath = [System.IO.Path]::GetFullPath($OutputDir)

function Invoke-CopyDirectory {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (-not (Test-Path $Source)) {
    throw "Source directory not found: $Source"
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null

  if ($env:OS -eq 'Windows_NT' -and (Get-Command robocopy.exe -ErrorAction SilentlyContinue)) {
    & robocopy.exe $Source $Destination /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) {
      throw "robocopy failed with exit code $LASTEXITCODE"
    }
    return
  }

  Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
}

function Write-OfflineRestoreScript {
  param(
    [string]$Destination,
    [string]$Platform,
    [bool]$HasNodeRuntime
  )

  $nodePathSetup = if ($HasNodeRuntime -and $Platform.StartsWith('win32-')) {
@'
$nodeDir = Join-Path $kitRoot 'runtime\node'
$npmCmd = Join-Path $nodeDir 'npm.cmd'
$env:PATH = "$nodeDir;$env:PATH"
'@
  } elseif ($HasNodeRuntime) {
@'
$nodeDir = Join-Path $kitRoot 'runtime/node/bin'
$npmCmd = Join-Path $nodeDir 'npm'
$env:PATH = "$nodeDir;$env:PATH"
'@
  } else {
@'
$npmCmd = 'npm'
'@
  }

  @"
param(
  [string]`$WorkspaceDir = (Join-Path `$PSScriptRoot 'api-nova')
)

`$ErrorActionPreference = 'Stop'
`$kitRoot = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$cacheDir = Join-Path `$kitRoot 'npm-cache'
`$bundlePath = Join-Path `$kitRoot 'source\api-nova.bundle'
`$patchPath = Join-Path `$kitRoot 'source\working-tree.patch'
`$stagedPatchPath = Join-Path `$kitRoot 'source\staged.patch'
`$untrackedArchivePath = Join-Path `$kitRoot 'source\untracked-files.zip'

$nodePathSetup

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git is required on the offline machine to restore the repository bundle.'
}

if (-not (Test-Path `$WorkspaceDir)) {
  git clone `$bundlePath `$WorkspaceDir
  if (`$LASTEXITCODE -ne 0) {
    throw "git clone failed with exit code `$LASTEXITCODE"
  }
}

Push-Location `$WorkspaceDir
try {
  if ((Test-Path `$patchPath) -and (Get-Item `$patchPath).Length -gt 0) {
    git apply --check `$patchPath
    if (`$LASTEXITCODE -ne 0) {
      throw "git apply --check failed for `$patchPath"
    }
    git apply `$patchPath
    if (`$LASTEXITCODE -ne 0) {
      throw "git apply failed for `$patchPath"
    }
  }

  if ((Test-Path `$stagedPatchPath) -and (Get-Item `$stagedPatchPath).Length -gt 0) {
    git apply --check `$stagedPatchPath
    if (`$LASTEXITCODE -ne 0) {
      throw "git apply --check failed for `$stagedPatchPath"
    }
    git apply --cached `$stagedPatchPath
    if (`$LASTEXITCODE -ne 0) {
      throw "git apply --cached failed for `$stagedPatchPath"
    }
  }

  if (Test-Path `$untrackedArchivePath) {
    Expand-Archive -Path `$untrackedArchivePath -DestinationPath `$WorkspaceDir -Force
  }

  & `$npmCmd --version
  if (`$LASTEXITCODE -ne 0) {
    throw "npm --version failed with exit code `$LASTEXITCODE"
  }

  & `$npmCmd ci --offline --cache `$cacheDir
  if (`$LASTEXITCODE -ne 0) {
    throw "npm ci failed with exit code `$LASTEXITCODE"
  }

  & `$npmCmd run build:packages
  if (`$LASTEXITCODE -ne 0) {
    throw "npm build:packages failed with exit code `$LASTEXITCODE"
  }

  & `$npmCmd run type-check
  if (`$LASTEXITCODE -ne 0) {
    throw "npm type-check failed with exit code `$LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Write-Host "Offline development workspace is ready: `$WorkspaceDir"
Write-Host 'Use these commands to start development:'
Write-Host '  npm run dev --workspace api-nova-server'
Write-Host '  npm run start:dev --workspace api-nova-api'
Write-Host '  npm run dev --workspace api-nova-ui'
"@ | Set-Content -Path (Join-Path $Destination 'restore-offline-dev.ps1') -Encoding UTF8
}

if (Test-Path $outputPath) {
  if (-not $Force) {
    throw "Output directory already exists: $outputPath. Use -Force to replace it."
  }
  Remove-Item -Path $outputPath -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $outputPath 'source'), (Join-Path $outputPath 'runtime') | Out-Null

if (-not $SkipCacheVerify) {
  Push-Location $repoRoot
  try {
    & $npmCommand cache verify
  } finally {
    Pop-Location
  }
}

$npmVersion = & $npmCommand --version
$nodeVersion = node -p "process.version"
$nodeExecPath = node -p "process.execPath"
$cachePath = & $npmCommand config get cache

Invoke-CopyDirectory -Source $cachePath -Destination (Join-Path $outputPath 'npm-cache')

if ($IncludeNodeRuntime) {
  if ($env:OS -eq 'Windows_NT') {
    $nodeRoot = Split-Path $nodeExecPath -Parent
    Invoke-CopyDirectory -Source $nodeRoot -Destination (Join-Path $outputPath 'runtime\node')
  } else {
    $nodeRoot = Split-Path (Split-Path $nodeExecPath -Parent) -Parent
    Invoke-CopyDirectory -Source $nodeRoot -Destination (Join-Path $outputPath 'runtime/node')
  }
}

Push-Location $repoRoot
try {
  git -c safe.directory=$repoRoot bundle create (Join-Path $outputPath 'source\api-nova.bundle') --all
  $workingTreePatch = Join-Path $outputPath 'source\working-tree.patch'
  $stagedPatch = Join-Path $outputPath 'source\staged.patch'
  git -c safe.directory=$repoRoot diff --binary "--output=$workingTreePatch"
  git -c safe.directory=$repoRoot diff --cached --binary "--output=$stagedPatch"
  $untrackedFiles = git -c safe.directory=$repoRoot ls-files --others --exclude-standard |
    Where-Object {
      $_ -and
      $_ -notmatch '^(data|logs|pids|node_modules)/' -and
      $_ -notmatch '(^|/)node_modules/' -and
      $_ -notmatch '(^|/)dist/' -and
      $_ -notmatch '(^|/)coverage/'
    }
  $untrackedFiles |
    Set-Content -Path (Join-Path $outputPath 'source\untracked-files.txt') -Encoding UTF8

  if ($untrackedFiles.Count -gt 0) {
    $untrackedStage = Join-Path $outputPath 'source\untracked-stage'
    New-Item -ItemType Directory -Force -Path $untrackedStage | Out-Null

    foreach ($file in $untrackedFiles) {
      $sourceFile = Join-Path $repoRoot $file
      $destinationFile = Join-Path $untrackedStage $file
      New-Item -ItemType Directory -Force -Path (Split-Path $destinationFile -Parent) | Out-Null
      Copy-Item -Path $sourceFile -Destination $destinationFile -Force
    }

    Compress-Archive -Path (Join-Path $untrackedStage '*') -DestinationPath (Join-Path $outputPath 'source\untracked-files.zip') -Force
    Remove-Item -Path $untrackedStage -Recurse -Force
  }

  git -c safe.directory=$repoRoot status --short --branch |
    Set-Content -Path (Join-Path $outputPath 'source\source-status.txt') -Encoding UTF8
} finally {
  Pop-Location
}

$metadata = [ordered]@{
  createdAt = (Get-Date).ToString('o')
  repository = $repoRoot
  platform = $runtimePlatform
  nodeVersion = $nodeVersion
  nodeExecPath = $nodeExecPath
  npmVersion = $npmVersion
  npmCachePath = $cachePath
  includeNodeRuntime = [bool]$IncludeNodeRuntime
}

$metadata | ConvertTo-Json -Depth 4 |
  Set-Content -Path (Join-Path $outputPath 'offline-dev-kit.json') -Encoding UTF8

Write-OfflineRestoreScript -Destination $outputPath -Platform $runtimePlatform -HasNodeRuntime ([bool]$IncludeNodeRuntime)

Copy-Item -Path (Join-Path $repoRoot 'docs\development\offline-dev-migration.md') -Destination (Join-Path $outputPath 'README_OFFLINE_DEV.md') -Force

Write-Host "Offline development kit created: $outputPath"
Write-Host "Platform: $runtimePlatform"
Write-Host "npm cache copied from: $cachePath"
