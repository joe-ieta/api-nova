param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseSetDir,

  [Parameter(Mandatory = $true)]
  [string]$ArchiveRoot,

  [Parameter(Mandatory = $true)]
  [string]$LatestRoot,

  [switch]$BackupExistingLatest
)

$ErrorActionPreference = 'Stop'
$releaseSetPath = (Resolve-Path -LiteralPath $ReleaseSetDir).Path
$archiveRootPath = [System.IO.Path]::GetFullPath($ArchiveRoot)
$latestRootPath = [System.IO.Path]::GetFullPath($LatestRoot)
if ($archiveRootPath -eq $latestRootPath) {
  throw 'ArchiveRoot and LatestRoot must be different directories'
}

$manifestPath = Join-Path $releaseSetPath 'RELEASE_MANIFEST.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$commit = [string]$manifest.gitCommit
if ($version -notmatch '^v\d+\.\d+\.\d+(?:-rc\.\d+)?$' -or $commit -notmatch '^[0-9a-f]{40}$') {
  throw 'Release manifest contains an invalid version or commit'
}
if ((Get-Content -LiteralPath (Join-Path $releaseSetPath 'RELEASE_NOTES.md') -Raw).Contains('@GIT_COMMIT@')) {
  throw 'Release notes still contain the Git commit placeholder'
}

$expectedPlatforms = @('win-x64', 'linux-x64', 'linux-arm64')
if (@($manifest.artifacts).Count -ne $expectedPlatforms.Count) {
  throw 'Release manifest must contain exactly three platform artifacts'
}
foreach ($platformId in $expectedPlatforms) {
  $artifact = @($manifest.artifacts | Where-Object platformId -eq $platformId)
  if ($artifact.Count -ne 1) {
    throw "Manifest must contain exactly one $platformId artifact"
  }
  $archivePath = Join-Path $releaseSetPath $artifact[0].filename
  $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $artifact[0].sha256) {
    throw "SHA-256 mismatch for $($artifact[0].filename)"
  }
}

$archiveVersionPath = Join-Path $archiveRootPath $version
if (Test-Path -LiteralPath $archiveVersionPath) {
  throw "Immutable archive already exists: $archiveVersionPath"
}
New-Item -ItemType Directory -Force -Path $archiveRootPath | Out-Null
$archiveStage = Join-Path $archiveRootPath ".$version-stage-$([Guid]::NewGuid().ToString('N'))"
$latestParent = Split-Path -Parent $latestRootPath
New-Item -ItemType Directory -Force -Path $latestParent | Out-Null
$latestStage = Join-Path $latestParent ".$([IO.Path]::GetFileName($latestRootPath))-next-$version-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $archiveStage, $latestStage | Out-Null

$archiveFiles = @(
  'RELEASE_NOTES.md',
  'QUICK_START.md',
  'RELEASE_MANIFEST.json',
  'SHA256SUMS.txt'
) + @($manifest.artifacts | ForEach-Object filename)
foreach ($name in $archiveFiles) {
  Copy-Item -LiteralPath (Join-Path $releaseSetPath $name) -Destination (Join-Path $archiveStage $name) -Force
}

try {
  foreach ($platformId in $expectedPlatforms) {
    $artifact = @($manifest.artifacts | Where-Object platformId -eq $platformId)[0]
    $extractRoot = Join-Path $latestStage ".extract-$platformId"
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    $archivePath = Join-Path $releaseSetPath $artifact.filename
    if ($artifact.archiveFormat -eq 'zip') {
      Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
    } elseif ($artifact.archiveFormat -eq 'tar.gz') {
      & tar -xzf $archivePath -C $extractRoot
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to extract $($artifact.filename)"
      }
    } else {
      throw "Unsupported archive format: $($artifact.archiveFormat)"
    }

    $packageName = "api-nova-release-$version-$platformId"
    $packagePath = Join-Path $extractRoot $packageName
    if (-not (Test-Path -LiteralPath $packagePath -PathType Container)) {
      throw "Archive top-level directory is invalid for $platformId"
    }
    $siblings = @(Get-ChildItem -LiteralPath $extractRoot -Force)
    if ($siblings.Count -ne 1) {
      throw "$($artifact.filename) must contain exactly one top-level directory"
    }

    $releaseInfo = Get-Content -LiteralPath (Join-Path $packagePath 'RELEASE_INFO.json') -Raw | ConvertFrom-Json
    if (
      $releaseInfo.version -ne $version -or
      $releaseInfo.gitCommit -ne $commit -or
      $releaseInfo.platformId -ne $platformId -or
      $releaseInfo.packageMode -ne 'offline' -or
      -not $releaseInfo.bundledNode
    ) {
      throw "RELEASE_INFO.json is inconsistent for $platformId"
    }
    foreach ($runtimeDirName in @('data', 'logs', 'pids')) {
      $runtimeDir = Join-Path $packagePath $runtimeDirName
      if (@(Get-ChildItem -LiteralPath $runtimeDir -Force).Count -ne 0) {
        throw "$platformId contains non-empty $runtimeDirName runtime data"
      }
    }

    Move-Item -LiteralPath $packagePath -Destination (Join-Path $latestStage $platformId)
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }

  $currentRelease = [ordered]@{
    product = 'ApiNova'
    version = $version
    gitCommit = $commit
    promotedAtUtc = [DateTime]::UtcNow.ToString('o')
    platforms = [ordered]@{
      'win-x64' = [ordered]@{ path = 'win-x64'; releaseInfo = 'win-x64/RELEASE_INFO.json' }
      'linux-x64' = [ordered]@{ path = 'linux-x64'; releaseInfo = 'linux-x64/RELEASE_INFO.json' }
      'linux-arm64' = [ordered]@{ path = 'linux-arm64'; releaseInfo = 'linux-arm64/RELEASE_INFO.json' }
    }
  }
  $currentRelease | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $latestStage 'CURRENT_RELEASE.json') -Encoding UTF8

  Move-Item -LiteralPath $archiveStage -Destination $archiveVersionPath

  $backupPath = $null
  if (Test-Path -LiteralPath $latestRootPath) {
    if (-not $BackupExistingLatest) {
      throw "LatestRoot already exists. Re-run with -BackupExistingLatest after reviewing its contents."
    }
    $suffix = if (Test-Path -LiteralPath (Join-Path $latestRootPath 'CURRENT_RELEASE.json')) { 'previous' } else { 'legacy' }
    $backupPath = "$latestRootPath-$suffix-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
    if (Test-Path -LiteralPath $backupPath) {
      throw "Latest backup path already exists: $backupPath"
    }
    Move-Item -LiteralPath $latestRootPath -Destination $backupPath
  }

  try {
    Move-Item -LiteralPath $latestStage -Destination $latestRootPath
  } catch {
    if ($backupPath -and -not (Test-Path -LiteralPath $latestRootPath) -and (Test-Path -LiteralPath $backupPath)) {
      Move-Item -LiteralPath $backupPath -Destination $latestRootPath
    }
    throw
  }

  Write-Host "Immutable archive: $archiveVersionPath"
  Write-Host "Latest release: $latestRootPath"
  if ($backupPath) {
    Write-Host "Previous latest backup: $backupPath"
  }
} finally {
  if (Test-Path -LiteralPath $archiveStage) {
    Remove-Item -LiteralPath $archiveStage -Recurse -Force
  }
  if (Test-Path -LiteralPath $latestStage) {
    Remove-Item -LiteralPath $latestStage -Recurse -Force
  }
}