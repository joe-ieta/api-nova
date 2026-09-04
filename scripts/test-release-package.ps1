param(
  [Parameter(Mandatory = $true)]
  [string]$PackageDir,

  [Parameter(Mandatory = $true)]
  [ValidateSet('win-x64', 'linux-x64', 'linux-arm64')]
  [string]$PlatformId,

  [int]$Port = 19001
)

$ErrorActionPreference = 'Stop'
$packagePath = (Resolve-Path -LiteralPath $PackageDir).Path
$expectedRuntime = @{
  'win-x64' = 'win32-x64'
  'linux-x64' = 'linux-x64'
  'linux-arm64' = 'linux-arm64'
}[$PlatformId]
$nodePath = if ($PlatformId -eq 'win-x64') {
  Join-Path $packagePath 'runtime\node\node.exe'
} else {
  Join-Path $packagePath 'runtime/node/bin/node'
}

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Bundled Node was not found: $nodePath"
}

$actualRuntime = (& $nodePath -p "process.platform + '-' + process.arch").Trim()
if ($actualRuntime -ne $expectedRuntime) {
  throw "Runtime mismatch: expected $expectedRuntime, got $actualRuntime"
}

$startScript = if ($PlatformId -eq 'win-x64') { 'start.bat' } else { 'start.sh' }
$startPath = Join-Path $packagePath $startScript
$startContent = Get-Content -LiteralPath $startPath -Raw
if ($startContent -match '(?im)^\s*(call\s+)?npm(\.cmd)?\s+(ci|install|add)\b') {
  throw "$startScript contains a first-run dependency installation command"
}

Push-Location $packagePath
try {
  & $nodePath -e "require('bcrypt'); require('sql.js');"
  if ($LASTEXITCODE -ne 0) {
    throw 'Native runtime dependency loading failed'
  }
} finally {
  Pop-Location
}

$environment = @{
  API_NOVA_NO_BROWSER = '1'
  NODE_ENV = 'production'
  PORT = $Port.ToString()
  MCP_PORT = ($Port + 1).ToString()
  DB_TYPE = 'sqlite'
  DB_SQLITE_PATH = 'data/release-smoke.db'
  DB_SYNCHRONIZE = 'true'
}
$previousEnvironment = @{}
foreach ($name in $environment.Keys) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  Set-Item -LiteralPath "Env:$name" -Value $environment[$name]
}

$runId = [Guid]::NewGuid().ToString('N')
$stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) "api-nova-release-$runId.stdout.log"
$stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "api-nova-release-$runId.stderr.log"
$process = $null
$passed = $false

try {
  if ($PlatformId -eq 'win-x64') {
    $startArgs = @{
      FilePath = 'cmd.exe'
      ArgumentList = @('/d', '/c', 'start.bat')
      WorkingDirectory = $packagePath
      RedirectStandardOutput = $stdoutPath
      RedirectStandardError = $stderrPath
      WindowStyle = 'Hidden'
      PassThru = $true
    }
    $process = Start-Process @startArgs
  } else {
    $setsid = (Get-Command setsid -ErrorAction Stop).Source
    $startArgs = @{
      FilePath = $setsid
      ArgumentList = @('bash', './start.sh')
      WorkingDirectory = $packagePath
      RedirectStandardOutput = $stdoutPath
      RedirectStandardError = $stderrPath
      PassThru = $true
    }
    $process = Start-Process @startArgs
  }

  $healthUri = "http://127.0.0.1:$Port/api/health/live"
  $deadline = (Get-Date).AddSeconds(90)
  do {
    if ($process.HasExited) {
      throw "Release process exited before becoming healthy (exit code $($process.ExitCode))"
    }
    try {
      $health = Invoke-WebRequest -Uri $healthUri -UseBasicParsing -TimeoutSec 3
    } catch {
      $health = $null
      Start-Sleep -Seconds 2
    }
  } until (($health -and $health.StatusCode -eq 200) -or (Get-Date) -ge $deadline)

  if (-not $health -or $health.StatusCode -ne 200) {
    throw "Timed out waiting for $healthUri"
  }

  foreach ($uri in @(
    "http://127.0.0.1:$Port/",
    "http://127.0.0.1:$Port/api/system/initialization"
  )) {
    $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 15
    if ($response.StatusCode -ne 200) {
      throw "$uri returned HTTP $($response.StatusCode)"
    }
  }

  $passed = $true
  Write-Host "Release smoke test passed: $PlatformId ($actualRuntime)"
} finally {
  if ($process -and -not $process.HasExited) {
    if ($PlatformId -eq 'win-x64') {
      & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    } else {
      & /usr/bin/kill -TERM -- "-$($process.Id)" 2>$null
      Start-Sleep -Seconds 2
      if (-not $process.HasExited) {
        & /usr/bin/kill -KILL -- "-$($process.Id)" 2>$null
      }
    }
  }

  foreach ($name in $environment.Keys) {
    $oldValue = $previousEnvironment[$name]
    if ($null -eq $oldValue) {
      Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item -LiteralPath "Env:$name" -Value $oldValue
    }
  }

  if (-not $passed) {
    if (Test-Path -LiteralPath $stdoutPath) {
      Write-Host '--- release stdout ---'
      Get-Content -LiteralPath $stdoutPath
    }
    if (Test-Path -LiteralPath $stderrPath) {
      Write-Host '--- release stderr ---'
      Get-Content -LiteralPath $stderrPath
    }
  }

  foreach ($relativeDir in @('data', 'logs', 'pids')) {
    $runtimeDir = Join-Path $packagePath $relativeDir
    if (Test-Path -LiteralPath $runtimeDir) {
      Get-ChildItem -LiteralPath $runtimeDir -Force | Remove-Item -Recurse -Force
    }
  }
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
}