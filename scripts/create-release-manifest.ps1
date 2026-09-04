param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^v\d+\.\d+\.\d+(?:-rc\.\d+)?$')]
  [string]$VersionTag,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$CommitSha,

  [Parameter(Mandatory = $true)]
  [string]$ArtifactDir,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$artifactPath = (Resolve-Path -LiteralPath $ArtifactDir).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$normalizedCommit = $CommitSha.ToLowerInvariant()
$platforms = @(
  [ordered]@{ platformId = 'win-x64'; extension = 'zip'; archiveFormat = 'zip' },
  [ordered]@{ platformId = 'linux-x64'; extension = 'tar.gz'; archiveFormat = 'tar.gz' },
  [ordered]@{ platformId = 'linux-arm64'; extension = 'tar.gz'; archiveFormat = 'tar.gz' }
)

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

$manifestArtifacts = @()
$nodeVersions = [Collections.Generic.HashSet[string]]::new()
foreach ($platform in $platforms) {
  $filename = "api-nova-release-$VersionTag-$($platform.platformId).$($platform.extension)"
  $matches = @(Get-ChildItem -LiteralPath $artifactPath -Recurse -File -Filter $filename)
  if ($matches.Count -ne 1) {
    throw "Expected one $filename, found $($matches.Count)"
  }

  $verificationName = "VERIFICATION-$($platform.platformId).json"
  $verificationMatches = @(Get-ChildItem -LiteralPath $artifactPath -Recurse -File -Filter $verificationName)
  if ($verificationMatches.Count -ne 1) {
    throw "Expected one $verificationName, found $($verificationMatches.Count)"
  }

  $verification = Get-Content -LiteralPath $verificationMatches[0].FullName -Raw | ConvertFrom-Json
  $actualHash = (Get-FileHash -LiteralPath $matches[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if (
    $verification.version -ne $VersionTag -or
    $verification.gitCommit -ne $normalizedCommit -or
    $verification.platformId -ne $platform.platformId -or
    $verification.archive -ne $filename -or
    $verification.archiveSha256 -ne $actualHash -or
    $verification.stagingSmoke -ne 'passed' -or
    $verification.freshExtractionSmoke -ne 'passed'
  ) {
    throw "Verification evidence is inconsistent for $($platform.platformId)"
  }

  [void]$nodeVersions.Add($verification.nodeVersion)
  Copy-Item -LiteralPath $matches[0].FullName -Destination (Join-Path $outputPath $filename) -Force

  $manifestArtifacts += [ordered]@{
    platformId = $platform.platformId
    filename = $filename
    archiveFormat = $platform.archiveFormat
    sizeBytes = $matches[0].Length
    sha256 = $actualHash
  }
}

if ($nodeVersions.Count -ne 1) {
  throw "Platform artifacts do not use one exact Node version: $($nodeVersions -join ', ')"
}

$versionDocs = Join-Path $repoRoot "docs/release/versions/$VersionTag"
$releaseNotes = (Get-Content -LiteralPath (Join-Path $versionDocs 'RELEASE_NOTES.md') -Raw).Replace('@GIT_COMMIT@', $normalizedCommit)
if ($releaseNotes.Contains('@GIT_COMMIT@')) {
  throw 'Final release notes still contain the Git commit placeholder'
}
$releaseNotes | Set-Content -LiteralPath (Join-Path $outputPath 'RELEASE_NOTES.md') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $versionDocs 'QUICK_START.md') -Destination (Join-Path $outputPath 'QUICK_START.md') -Force

$manifest = [ordered]@{
  product = 'ApiNova'
  version = $VersionTag
  gitCommit = $normalizedCommit
  releaseStatus = if ($VersionTag.Contains('-')) { 'prerelease' } else { 'stable' }
  releaseDate = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
  nodeVersion = @($nodeVersions)[0]
  artifacts = $manifestArtifacts
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $outputPath 'RELEASE_MANIFEST.json') -Encoding UTF8

$checksumLines = foreach ($artifact in $manifestArtifacts) {
  "$($artifact.sha256)  $($artifact.filename)"
}
$checksumLines | Set-Content -LiteralPath (Join-Path $outputPath 'SHA256SUMS.txt') -Encoding ASCII
Write-Host "Complete release set created: $outputPath"