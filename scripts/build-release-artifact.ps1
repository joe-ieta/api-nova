param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^v\d+\.\d+\.\d+(?:-rc\.\d+)?$')]
  [string]$VersionTag,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$CommitSha,

  [Parameter(Mandatory = $true)]
  [ValidateSet('win-x64', 'linux-x64', 'linux-arm64')]
  [string]$PlatformId,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [int]$SmokePort = 19001
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$expectedRuntime = @{
  'win-x64' = 'win32-x64'
  'linux-x64' = 'linux-x64'
  'linux-arm64' = 'linux-arm64'
}[$PlatformId]
$actualRuntime = (node -p "process.platform + '-' + process.arch").Trim()
if ($actualRuntime -ne $expectedRuntime) {
  throw "Builder mismatch: $PlatformId requires $expectedRuntime, got $actualRuntime"
}

$normalizedCommit = $CommitSha.ToLowerInvariant()
$actualCommit = (git -C $repoRoot rev-parse HEAD).Trim()
if ($actualCommit -ne $normalizedCommit) {
  throw "Commit mismatch: expected $normalizedCommit, got $actualCommit"
}

$versionDocs = Join-Path $repoRoot "docs/release/versions/$VersionTag"
foreach ($name in @('RELEASE_NOTES.md', 'QUICK_START.md')) {
  if (-not (Test-Path -LiteralPath (Join-Path $versionDocs $name) -PathType Leaf)) {
    throw "Version document is missing: $name"
  }
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$stageRoot = Join-Path $outputPath 'stage'
$extractRoot = Join-Path $outputPath 'extracted'
$packageName = "api-nova-release-$VersionTag-$PlatformId"
$packageDir = Join-Path $stageRoot $packageName

$packageArgs = @{
  Mode = 'OfflineCurrentPlatform'
  OutputDir = $packageDir
  SkipBuild = $true
  IncludeNode = $true
}
& (Join-Path $PSScriptRoot 'package-release.ps1') @packageArgs

$releaseNotes = (Get-Content -LiteralPath (Join-Path $versionDocs 'RELEASE_NOTES.md') -Raw).Replace('@GIT_COMMIT@', $normalizedCommit)
if ($releaseNotes.Contains('@GIT_COMMIT@')) {
  throw 'Release notes still contain the Git commit placeholder'
}
$releaseNotes | Set-Content -LiteralPath (Join-Path $packageDir 'RELEASE_NOTES.md') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $versionDocs 'QUICK_START.md') -Destination (Join-Path $packageDir 'QUICK_START.md') -Force

$packageLockHash = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$bundledNode = if ($PlatformId -eq 'win-x64') {
  Join-Path $packageDir 'runtime\node\node.exe'
} else {
  Join-Path $packageDir 'runtime/node/bin/node'
}
$nodeVersion = (& $bundledNode -v).Trim()
$npmVersion = (npm --version).Trim()
$releaseInfo = [ordered]@{
  product = 'ApiNova'
  version = $VersionTag
  gitCommit = $normalizedCommit
  platformId = $PlatformId
  os = if ($PlatformId -eq 'win-x64') { 'windows' } else { 'linux' }
  architecture = if ($PlatformId -eq 'linux-arm64') { 'arm64' } else { 'x64' }
  packageMode = 'offline'
  bundledNode = $true
  nodeVersion = $nodeVersion
  npmVersion = $npmVersion
  buildTimeUtc = [DateTime]::UtcNow.ToString('o')
  packageLockSha256 = $packageLockHash
  releaseNotes = 'RELEASE_NOTES.md'
  quickStart = 'QUICK_START.md'
}
$releaseInfo | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $packageDir 'RELEASE_INFO.json') -Encoding UTF8

if ($PlatformId -ne 'win-x64') {
  & chmod +x (Join-Path $packageDir 'start.sh') (Join-Path $packageDir 'runtime/node/bin/node')
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to set Linux executable permissions'
  }
}

$smokeArgs = @{
  PackageDir = $packageDir
  PlatformId = $PlatformId
  Port = $SmokePort
}
& (Join-Path $PSScriptRoot 'test-release-package.ps1') @smokeArgs

$archiveName = if ($PlatformId -eq 'win-x64') { "$packageName.zip" } else { "$packageName.tar.gz" }
$archivePath = Join-Path $outputPath $archiveName
if ($PlatformId -eq 'win-x64') {
  Compress-Archive -LiteralPath $packageDir -DestinationPath $archivePath -CompressionLevel Optimal
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
} else {
  & tar -czf $archivePath -C $stageRoot $packageName
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to create Linux tar.gz archive'
  }
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  & tar -xzf $archivePath -C $extractRoot
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to extract Linux tar.gz archive'
  }
}

$extractedPackage = Join-Path $extractRoot $packageName
$freshSmokeArgs = @{
  PackageDir = $extractedPackage
  PlatformId = $PlatformId
  Port = $SmokePort + 10
}
& (Join-Path $PSScriptRoot 'test-release-package.ps1') @freshSmokeArgs

$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$verification = [ordered]@{
  product = 'ApiNova'
  version = $VersionTag
  gitCommit = $normalizedCommit
  platformId = $PlatformId
  runtime = $actualRuntime
  nodeVersion = $nodeVersion
  npmVersion = $npmVersion
  archive = $archiveName
  archiveSizeBytes = (Get-Item -LiteralPath $archivePath).Length
  archiveSha256 = $archiveHash
  nativeDependencies = 'passed'
  stagingSmoke = 'passed'
  freshExtractionSmoke = 'passed'
  verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$verificationPath = Join-Path $outputPath "VERIFICATION-$PlatformId.json"
$verification | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $verificationPath -Encoding UTF8

Remove-Item -LiteralPath $stageRoot, $extractRoot -Recurse -Force
Write-Host "Release artifact created: $archivePath"
Write-Host "SHA-256: $archiveHash"