param(
  [ValidateSet('Portable', 'OfflineCurrentPlatform')]
  [string]$Mode = 'Portable',

  [string]$OutputDir = 'E:\CodexDev\api-nova-release',

  [switch]$SkipBuild,

  [switch]$IncludeNode
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$repoRoot = $repoRoot.Path
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$runtimePlatform = node -p "process.platform + '-' + process.arch"
$npmCommand = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }

function Copy-IfExists {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (Test-Path $Source) {
    Copy-Item -Path $Source -Destination $Destination -Force
  }
}

function Write-ReleaseEnv {
  param([string]$Path)

  @'
NODE_ENV=production
PORT=9001
MCP_PORT=9022
CORS_ORIGINS=http://localhost:9001,http://127.0.0.1:9001
DB_TYPE=sqlite
DB_SQLITE_PATH=data/api-nova.db
DB_LOGGING=false
DB_SYNCHRONIZE=true
JWT_SECRET=api-nova-local-release-change-me
JWT_REFRESH_SECRET=api-nova-local-release-refresh-change-me
SUPER_ADMIN_USERNAME=admin
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD=admin@123456
SUPER_ADMIN_FIRST_NAME=Super
SUPER_ADMIN_LAST_NAME=Admin
LOG_LEVEL=info
LOG_FORMAT=pretty
PROCESS_LOG_PERSIST_ENABLED=true
PROCESS_LOG_PERSIST_MIN_INTERVAL_MS=1000
PROCESS_LOG_MAX_MESSAGE_LENGTH=4000
PROCESS_LOG_RETENTION_DAYS=7
SYSTEM_LOG_RETENTION_DAYS=14
HEALTH_CHECK_RETENTION_DAYS=7
HEALTH_CHECK_PERSIST_INTERVAL_MS=60000
REQUEST_TIMEOUT=30000
CACHE_TTL=300
MAX_PAYLOAD_SIZE=50mb
THROTTLE_TTL=60
THROTTLE_LIMIT=100
MCP_SERVER_HOST=localhost
MCP_SERVER_PORT=9022
MCP_SERVER_HEALTH_CHECK_INTERVAL=30000
METRICS_ENABLED=true
HEALTH_CHECK_ENABLED=true
HOT_RELOAD=false
WATCH_FILES=false
DEBUG_MODE=false
'@ | Set-Content -Path (Join-Path $Path '.env') -Encoding UTF8
}

function Write-StartScripts {
  param(
    [string]$Path,
    [string]$PackageMode
  )

  $isOffline = $PackageMode -eq 'OfflineCurrentPlatform'

  $windowsInstallBlock = if ($isOffline) {
@'
if not exist "node_modules" (
  echo [ApiNova] Offline dependencies are missing. This package is incomplete.
  pause
  exit /b 1
)
'@
  } else {
@'
set INSTALL_DEPS=0
if not exist "node_modules" set INSTALL_DEPS=1
if not exist ".api-nova-runtime-platform" set INSTALL_DEPS=1
if exist ".api-nova-runtime-platform" (
  set /p INSTALLED_PLATFORM=<.api-nova-runtime-platform
  if not "%INSTALLED_PLATFORM%"=="%RUNTIME_PLATFORM%" set INSTALL_DEPS=1
)

if "%INSTALL_DEPS%"=="1" (
  echo [ApiNova] Installing production dependencies for %RUNTIME_PLATFORM%...
  call npm.cmd ci --omit=dev
  if errorlevel 1 (
    echo [ApiNova] Dependency installation failed.
    pause
    exit /b 1
  )
  > .api-nova-runtime-platform echo %RUNTIME_PLATFORM%
)
'@
  }

  $linuxInstallBlock = if ($isOffline) {
@'
if [ ! -d "node_modules" ]; then
  echo "[ApiNova] Offline dependencies are missing. This package is incomplete."
  exit 1
fi
'@
  } else {
@'
install_deps=0
if [ ! -d "node_modules" ]; then
  install_deps=1
elif [ ! -f ".api-nova-runtime-platform" ]; then
  install_deps=1
elif [ "$(cat .api-nova-runtime-platform)" != "${runtime_platform}" ]; then
  install_deps=1
fi

if [ "${install_deps}" = "1" ]; then
  echo "[ApiNova] Installing production dependencies for ${runtime_platform}..."
  npm ci --omit=dev
  printf '%s\n' "${runtime_platform}" > .api-nova-runtime-platform
fi
'@
  }

  @"
@echo off
setlocal
cd /d "%~dp0"

set NODE_EXE=node
set NODE_IS_BUNDLED=0
if exist "runtime\node\node.exe" (
  set NODE_EXE=runtime\node\node.exe
  set NODE_IS_BUNDLED=1
)

if "%NODE_IS_BUNDLED%"=="0" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ApiNova] Node.js was not found. Install Node.js 20 LTS or use a package with bundled runtime\node\node.exe.
    pause
    exit /b 1
  )
)

for /f "tokens=*" %%v in ('%NODE_EXE% -v') do set NODE_VERSION=%%v
for /f "tokens=*" %%p in ('%NODE_EXE% -p "process.platform + '-' + process.arch"') do set RUNTIME_PLATFORM=%%p
echo [ApiNova] Node %NODE_VERSION% (%RUNTIME_PLATFORM%)

$windowsInstallBlock

echo [ApiNova] Starting at http://127.0.0.1:9001/
start "" "http://127.0.0.1:9001/"
%NODE_EXE% packages\api-nova-api\dist\src\main.js
pause
"@ | Set-Content -Path (Join-Path $Path 'start.bat') -Encoding ASCII

  @"
#!/usr/bin/env bash
set -euo pipefail
cd "`$(dirname "`$0")"

NODE_EXE="node"
if [ -x "runtime/node/bin/node" ]; then
  NODE_EXE="runtime/node/bin/node"
elif [ -x "runtime/node/node" ]; then
  NODE_EXE="runtime/node/node"
fi

if ! command -v "`$NODE_EXE" >/dev/null 2>&1; then
  echo "[ApiNova] Node.js was not found. Install Node.js 20 LTS or use a package with bundled runtime/node/bin/node."
  exit 1
fi

runtime_platform="`$(`$NODE_EXE -p "process.platform + '-' + process.arch")"
echo "[ApiNova] `$(`$NODE_EXE -v) (`${runtime_platform})"

$linuxInstallBlock

echo "[ApiNova] Starting at http://127.0.0.1:9001/"
if command -v xdg-open >/dev/null 2>&1; then
  (xdg-open "http://127.0.0.1:9001/" >/dev/null 2>&1 || true) &
fi
"`$NODE_EXE" packages/api-nova-api/dist/src/main.js
"@ | Set-Content -Path (Join-Path $Path 'start.sh') -Encoding ASCII
}

function Write-Readme {
  param(
    [string]$Path,
    [string]$PackageMode,
    [string]$Platform
  )

  $offlineText = if ($PackageMode -eq 'OfflineCurrentPlatform') {
    "This is an offline package for $Platform. First run must not download dependencies. Do not move it across OS/CPU architectures."
  } else {
    "This is a portable source-runtime package. First run installs production dependencies for the current OS/CPU."
  }

  @"
# ApiNova Release Package

$offlineText

## Run

Windows:

    start.bat

Linux / Ubuntu:

    chmod +x ./start.sh
    ./start.sh

Open:

    http://127.0.0.1:9001/

Default account:

    admin / admin@123456

Data stays inside this directory:

- SQLite database: data/api-nova.db
- logs: logs/
- pids: pids/

Change .env before startup for ports, secrets, or database settings.
"@ | Set-Content -Path (Join-Path $Path 'README_RUN.md') -Encoding UTF8
}

if (-not $SkipBuild) {
  Push-Location $repoRoot
  try {
    & $npmCommand run build
  } finally {
    Pop-Location
  }
}

if (Test-Path $outputPath) {
  Remove-Item -Path $outputPath -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $outputPath 'packages') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $outputPath 'public') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $outputPath 'data'), (Join-Path $outputPath 'logs'), (Join-Path $outputPath 'pids') | Out-Null

Copy-Item -Path (Join-Path $repoRoot 'package.json') -Destination (Join-Path $outputPath 'package.json') -Force
Copy-Item -Path (Join-Path $repoRoot 'package-lock.json') -Destination (Join-Path $outputPath 'package-lock.json') -Force
Copy-IfExists (Join-Path $repoRoot '.npmrc') (Join-Path $outputPath '.npmrc')
Copy-IfExists (Join-Path $repoRoot 'README.md') (Join-Path $outputPath 'README_PROJECT.md')

foreach ($pkg in @('api-nova-api', 'api-nova-parser', 'api-nova-server')) {
  $srcPkg = Join-Path $repoRoot "packages\$pkg"
  $dstPkg = Join-Path $outputPath "packages\$pkg"
  New-Item -ItemType Directory -Force -Path $dstPkg | Out-Null
  Copy-Item -Path (Join-Path $srcPkg 'package.json') -Destination (Join-Path $dstPkg 'package.json') -Force
  Copy-Item -Path (Join-Path $srcPkg 'dist') -Destination (Join-Path $dstPkg 'dist') -Recurse -Force
  foreach ($optional in @('README.md', 'README_EN.md', 'LICENSE', 'CHANGELOG.md', 'ARCHITECTURE.md', 'config-example.json', '.env.example')) {
    Copy-IfExists (Join-Path $srcPkg $optional) (Join-Path $dstPkg $optional)
  }
}

$uiPackageDir = Join-Path $outputPath 'packages\api-nova-ui'
New-Item -ItemType Directory -Force -Path $uiPackageDir | Out-Null
Copy-Item -Path (Join-Path $repoRoot 'packages\api-nova-ui\package.json') -Destination (Join-Path $uiPackageDir 'package.json') -Force

Copy-Item -Path (Join-Path $repoRoot 'packages\api-nova-ui\dist\*') -Destination (Join-Path $outputPath 'public') -Recurse -Force
if (Test-Path (Join-Path $repoRoot 'packages\api-nova-api\public')) {
  Copy-Item -Path (Join-Path $repoRoot 'packages\api-nova-api\public\*') -Destination (Join-Path $outputPath 'public') -Recurse -Force
}

Write-ReleaseEnv $outputPath
Write-StartScripts -Path $outputPath -PackageMode $Mode
Write-Readme -Path $outputPath -PackageMode $Mode -Platform $runtimePlatform

if ($Mode -eq 'OfflineCurrentPlatform') {
  Push-Location $outputPath
  try {
    & $npmCommand ci --omit=dev
    $runtimePlatform | Set-Content -Path (Join-Path $outputPath '.api-nova-runtime-platform') -Encoding ASCII
  } finally {
    Pop-Location
  }

  if ($IncludeNode) {
    $nodePath = node -p "process.execPath"
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
      $nodeOut = Join-Path $outputPath 'runtime\node'
      New-Item -ItemType Directory -Force -Path $nodeOut | Out-Null
      Copy-Item -Path $nodePath -Destination (Join-Path $nodeOut 'node.exe') -Force
    } else {
      $nodeOut = Join-Path $outputPath 'runtime/node/bin'
      New-Item -ItemType Directory -Force -Path $nodeOut | Out-Null
      Copy-Item -Path $nodePath -Destination (Join-Path $nodeOut 'node') -Force
    }
  }
}

Write-Host "Release package created: $outputPath"
Write-Host "Mode: $Mode"
Write-Host "Platform: $runtimePlatform"
