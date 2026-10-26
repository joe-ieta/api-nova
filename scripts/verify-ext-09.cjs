'use strict';
// SEC-EXT-09 Ubuntu full-flow runner. Inside the locally present ubuntu:24.04 image it
// installs Node/npm from the official tarball, copies this repository into a container-local
// workspace, runs npm ci and the non-UI builds, runs migrations, starts the real API on
// sql.js SQLite, verifies /api/health/ready and the boot seed, then exercises the real MCP
// Streamable HTTP publication paths reused from the repository server test scripts.
// Loopback only after install; apt, the Node tarball and the npm registry are contacted
// solely to provision the toolchain and dependencies. Prints EXT_09_VERIFY_OK only when
// every stage passes; failure gates the exit code and the notCovered list stays explicit.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const image = process.env.EXT09_IMAGE || 'ubuntu:24.04';
const containerName = `ext09-verify-${process.pid}`;
const logRoot = process.env.EXT09_LOG_DIR
  || path.join(path.parse(repository).root, 'temp', 'opencode', 'ext-09');
const syntheticJwtSecret = 'ext09-container-synthetic-management-secret-0123456789';

const notCovered = [
  { item: 'bare metal, systemd, host kernel and host glibc',
    reason: 'runs inside the Docker Desktop Linux VM on ubuntu:24.04, so the VM kernel/glibc libc path is used; systemd units, service supervision and the Windows host kernel are not exercised' },
  { item: 'external network and real upstreams',
    reason: 'apt, nodejs.org and the npm registry are contacted only during provisioning; all runtime evidence is loopback-only against in-container synthetic fixtures' },
  { item: 'PostgreSQL deployment lane',
    reason: 'the API runs on the sql.js SQLite lane (DB_TYPE=sqlite, container-local DB_SQLITE_PATH); PostgreSQL migrations and connection behavior are owned by other lanes' },
  { item: 'UI build and packaged UI serving',
    reason: 'only the parser/server/API non-UI builds are required to start the API; the UI build is optional and intentionally skipped to bound runtime' },
  { item: 'long soak, sustained load and performance',
    reason: 'this is a bounded install/build/start/Streamable flow, not a soak or capacity measurement' },
  { item: 'Node archive provenance',
    reason: 'the official Node tarball is downloaded at run time for the recorded version; its sha256 is not compared against a pinned manifest' },
  { item: 'production activation and trusted managed runtime mode',
    reason: 'the managed runtime is exercised in its default controlled test mode; E1-03 trusted/activation evidence stays on its own runner' },
];

function docker(args, options = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...options,
  });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hostCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true });
  if (result.status === 0 && String(result.stdout).trim()) return String(result.stdout).trim();
  try {
    const head = fs.readFileSync(path.join(repository, '.git', 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, '');
    return fs.readFileSync(path.join(repository, '.git', ref), 'utf8').trim();
  } catch {
    return null;
  }
}

function hostNpmVersion() {
  const agent = process.env.npm_config_user_agent || '';
  const match = agent.match(/^npm\/(\S+)/);
  if (match) return match[1];
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function valueOf(output, name) {
  const match = String(output).match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

function section(output, name) {
  const begin = `EXT09_${name}_BEGIN`;
  const end = `EXT09_${name}_END`;
  const start = String(output).indexOf(begin);
  const stop = String(output).indexOf(end);
  if (start < 0 || stop < 0) return null;
  return String(output).slice(start + begin.length, stop);
}

function tapCounts(text) {
  const count = name => {
    const matches = [...String(text || '').matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    return matches.length ? Number(matches.pop()[1]) : null;
  };
  return { tests: count('tests'), pass: count('pass'), fail: count('fail') };
}

function fail(reason, details) {
  console.error(`[verify-ext-09] ${reason}`);
  const payload = { marker: 'EXT_09_VERIFY_FAILED', workPackage: 'SEC-EXT-09', reason };
  if (details !== undefined) payload.details = details;
  console.error(JSON.stringify(payload));
  process.exit(1);
}

const inContainerScript = `
set -eu
export DEBIAN_FRONTEND=noninteractive
apt_ok=0
for attempt in 1 2 3 4; do
  if apt-get -o Acquire::Retries=5 update -qq > /work-apt.log 2>&1 && apt-get -o Acquire::Retries=5 install -y -qq --no-install-recommends curl ca-certificates xz-utils git procps python3 make g++ >> /work-apt.log 2>&1; then
    apt_ok=1
    break
  fi
  echo "EXT09_APT_RETRY attempt=$attempt"
  sleep 5
done
if [ "$apt_ok" -ne 1 ]; then echo EXT09_FAIL apt-install; tail -60 /work-apt.log; exit 1; fi
echo "EXT09_UBUNTU_RELEASE=$(grep ^PRETTY_NAME= /etc/os-release | cut -d= -f2- | tr -d '\\"')"
echo "EXT09_UBUNTU_VERSION=$(grep ^VERSION_ID= /etc/os-release | cut -d= -f2- | tr -d '\\"')"
echo "EXT09_KERNEL=$(uname -r)"
echo "EXT09_GLIBC=$(ldd --version | head -1)"
mkdir -p /opt/node /work/cache /work/repo /work/logs /work/data
cd /work/cache
curl -fsSL --retry 3 -o node.tar.xz "https://nodejs.org/dist/$EXT09_NODE_VERSION/node-$EXT09_NODE_VERSION-linux-x64.tar.xz" || { echo EXT09_FAIL node-download; exit 1; }
tar -xJf node.tar.xz -C /opt/node --strip-components=1 || { echo EXT09_FAIL node-extract; exit 1; }
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm
ln -sf /opt/node/bin/npx /usr/local/bin/npx
echo "EXT09_NODE=$(node --version)"
echo "EXT09_NPM=$(npm --version)"
echo "EXT09_NPM_REGISTRY=$(npm config get registry)"
echo EXT09_STAGE node done
tar -C /repo -cf - --exclude=node_modules --exclude=dist --exclude=./.tmp --exclude=./tmp --exclude=./logs --exclude=./pids --exclude=./data --exclude=./packages/api-nova-api/data --exclude=./coverage --exclude=./packages/api-nova-server/.tmp --exclude=./packages/api-nova-server/.mcp-swagger --exclude=./*.log . | tar -C /work/repo -xf - || { echo EXT09_FAIL repo-copy; exit 1; }
echo "EXT09_GIT_COMMIT=$(git -C /work/repo rev-parse HEAD)"
echo "EXT09_LOCK_SHA256=$(sha256sum /work/repo/package-lock.json | cut -d' ' -f1)"
echo EXT09_STAGE copy done
cd /work/repo
export npm_config_cache=/work/cache/npm
npm_ci_start=$(date +%s)
npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000 > /work/npm-ci.log 2>&1 || { echo EXT09_FAIL npm-ci; tail -80 /work/npm-ci.log; exit 1; }
echo "EXT09_NPM_CI_SECONDS=$(( $(date +%s) - npm_ci_start ))"
echo EXT09_STAGE npm-ci done
build_start=$(date +%s)
node scripts/build.js --non-ui > /work/build.log 2>&1 || { echo EXT09_FAIL build; tail -100 /work/build.log; exit 1; }
echo "EXT09_BUILD_SECONDS=$(( $(date +%s) - build_start ))"
for artifact in packages/api-nova-parser/dist/index.js packages/api-nova-server/dist/index.js packages/api-nova-api/dist/src/main.js; do
  if [ ! -f "$artifact" ]; then echo "EXT09_FAIL artifact-$artifact"; exit 1; fi
done
echo EXT09_STAGE build done
cd /work/repo/packages/api-nova-api
export DB_TYPE=sqlite
export DB_SQLITE_PATH=/work/data/ext09.sqlite
export JWT_SECRET=${syntheticJwtSecret}
export PORT=9010
export NODE_ENV=development
export MCP_SERVER_HOST=127.0.0.1
export MCP_SERVER_PORT=19022
npm run migration:run > /work/migration.log 2>&1 || { echo EXT09_FAIL migration; tail -80 /work/migration.log; exit 1; }
echo EXT09_MIGRATION_OK
nohup node dist/src/main.js > /work/logs/api.log 2>&1 &
EXT09_API_PID=$!
ready=0
attempt=0
while [ "$attempt" -lt 60 ]; do
  attempt=$((attempt+1))
  sleep 2
  body=$(curl -sS -m 3 http://127.0.0.1:9010/api/health/ready 2>/dev/null || true)
  if printf '%s' "$body" | grep -q "\\"status\\":\\"ready\\""; then ready=1; break; fi
done
if [ "$ready" -ne 1 ]; then echo EXT09_FAIL start-not-ready; tail -80 /work/logs/api.log; exit 1; fi
echo "EXT09_READY attempt=$attempt body=$body"
if grep -q "Database seed initialization completed" /work/logs/api.log; then echo EXT09_SEED_OK; else echo EXT09_FAIL seed-log; tail -80 /work/logs/api.log; exit 1; fi
if grep -q "${syntheticJwtSecret}" /work/logs/api.log; then echo EXT09_FAIL secret-leak; fi
echo EXT09_STAGE start done
cd /work/repo/packages/api-nova-server
export NO_PROXY=127.0.0.1,localhost
export no_proxy=127.0.0.1,localhost
e2e_start=$(date +%s)
node --test --test-reporter=tap scripts/test-managed-runtime.cjs > /work/logs/managed-runtime.tap 2>&1 || { echo EXT09_FAIL e2e-managed-runtime; tail -100 /work/logs/managed-runtime.tap; exit 1; }
node --test --test-reporter=tap scripts/test-publication-endpoints.cjs > /work/logs/publication-endpoints.tap 2>&1 || { echo EXT09_FAIL e2e-publication-endpoints; tail -100 /work/logs/publication-endpoints.tap; exit 1; }
echo "EXT09_E2E_SECONDS=$(( $(date +%s) - e2e_start ))"
echo EXT09_MANAGED_RUNTIME_TAP_BEGIN
grep -E "^# (tests|pass|fail)" /work/logs/managed-runtime.tap
echo EXT09_MANAGED_RUNTIME_TAP_END
echo EXT09_PUBLICATION_ENDPOINTS_TAP_BEGIN
grep -E "^# (tests|pass|fail)" /work/logs/publication-endpoints.tap
echo EXT09_PUBLICATION_ENDPOINTS_TAP_END
echo EXT09_STAGE e2e done
kill -TERM "$EXT09_API_PID" 2>/dev/null || true
shutdown=graceful
for i in $(seq 1 20); do
  if ! kill -0 "$EXT09_API_PID" 2>/dev/null; then break; fi
  sleep 1
  if [ "$i" -eq 20 ]; then shutdown=forced; kill -KILL "$EXT09_API_PID" 2>/dev/null || true; fi
done
echo "EXT09_SHUTDOWN=$shutdown"
echo EXT09_API_LOG_BEGIN
sed -e 's/\\x1b\\[[0-9;]*m//g' /work/logs/api.log | grep -aE "Nest application successfully started|Application is running|Health check available|MCP Server running|Database seed initialization completed|SIGTERM|shutting down" | tail -10
echo EXT09_API_LOG_END
echo EXT09_FLOW_OK
`;

function main() {
  fs.mkdirSync(logRoot, { recursive: true });
  const engine = docker(['version', '--format', '{{.Server.Version}}']);
  if (engine.status !== 0) {
    fail('Docker Linux engine is unavailable: ' + String(engine.stderr || '').trim());
  }
  const dockerServer = String(engine.stdout || '').trim();
  const inspect = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  if (inspect.status !== 0) {
    fail(`Local image ${image} is not present; no pulls are performed. Load the image or set EXT09_IMAGE.`,
      String(inspect.stderr || '').trim());
  }
  const imageId = String(inspect.stdout || '').trim();

  const lockSha = sha256File(path.join(repository, 'package-lock.json'));
  const commit = hostCommit();
  const hostNode = process.version;
  const nodeVersion = process.env.EXT09_NODE_VERSION
    || (/^v24\./.test(hostNode) ? hostNode : 'v24.15.0');

  console.log(`[verify-ext-09] ubuntu full flow on ${image} (node ${nodeVersion}) commit ${commit || 'unknown'}`);
  const started = Date.now();
  let run;
  try {
    run = docker(['run', '--rm', '--name', containerName,
      '--mount', `type=bind,source=${repository},target=/repo,readonly`,
      '-e', `EXT09_NODE_VERSION=${nodeVersion}`,
      image, 'bash', '-lc', inContainerScript], { timeout: 2700000 });
  } finally {
    docker(['rm', '-f', containerName]);
  }
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  const hostLog = path.join(logRoot, `ext09-ubuntu-${Date.now()}.log`);
  fs.writeFileSync(hostLog, output);

  const stageFailed = valueOf(output, 'EXT09_FAIL');
  const flowOk = output.includes('EXT09_FLOW_OK');
  const containerCommit = valueOf(output, 'EXT09_GIT_COMMIT');
  const containerLockSha = valueOf(output, 'EXT09_LOCK_SHA256');
  const managedTap = tapCounts(section(output, 'MANAGED_RUNTIME_TAP'));
  const publicationTap = tapCounts(section(output, 'PUBLICATION_ENDPOINTS_TAP'));

  const failures = [];
  if (run.error) failures.push(`docker run did not complete: ${run.error.message}`);
  if (stageFailed) failures.push(`container stage failed: ${stageFailed}`);
  if (run.status !== 0 && !stageFailed) failures.push(`docker run exited ${run.status}`);
  if (!flowOk) failures.push('EXT09_FLOW_OK marker missing');
  if (commit && containerCommit !== commit) failures.push(`commit mismatch: host ${commit} container ${containerCommit}`);
  if (containerLockSha !== lockSha) failures.push('package-lock.json sha256 mismatch between host and container');
  if (!output.includes('EXT09_MIGRATION_OK')) failures.push('migration:run did not report success');
  if (!output.includes('EXT09_SEED_OK')) failures.push('boot seed completion was not observed in the API log');
  if (output.includes('EXT09_FAIL secret-leak')) failures.push('synthetic JWT secret leaked into the API log');
  if (!managedTap || managedTap.tests === null || managedTap.fail !== 0 || !(managedTap.tests > 0)) {
    failures.push('managed runtime Streamable TAP did not pass');
  }
  if (!publicationTap || publicationTap.tests === null || publicationTap.fail !== 0 || !(publicationTap.tests > 0)) {
    failures.push('publication endpoint Streamable TAP did not pass');
  }

  const report = {
    workPackage: 'SEC-EXT-09',
    status: failures.length ? 'failed' : 'pass',
    environment: {
      host: {
        platform: process.platform, arch: process.arch, node: hostNode, npm: hostNpmVersion(),
        commit, packageLockSha256: lockSha, dockerServer, image, imageId,
      },
      container: {
        ubuntuRelease: valueOf(output, 'EXT09_UBUNTU_RELEASE'),
        ubuntuVersion: valueOf(output, 'EXT09_UBUNTU_VERSION'),
        kernel: valueOf(output, 'EXT09_KERNEL'),
        glibc: valueOf(output, 'EXT09_GLIBC'),
        node: valueOf(output, 'EXT09_NODE'),
        npm: valueOf(output, 'EXT09_NPM'),
        npmRegistry: valueOf(output, 'EXT09_NPM_REGISTRY'),
        commit: containerCommit,
        packageLockSha256: containerLockSha,
        database: 'sql.js SQLite (DB_TYPE=sqlite)',
        databasePath: '/work/data/ext09.sqlite',
      },
      sameVersionIdentity: {
        nodeMatchesHost: valueOf(output, 'EXT09_NODE') === hostNode,
        commitMatchesHost: containerCommit === commit,
        packageLockMatchesHost: containerLockSha === lockSha,
      },
    },
    flow: {
      npmCiSeconds: Number(valueOf(output, 'EXT09_NPM_CI_SECONDS')),
      buildSeconds: Number(valueOf(output, 'EXT09_BUILD_SECONDS')),
      e2eSeconds: Number(valueOf(output, 'EXT09_E2E_SECONDS')),
      migration: output.includes('EXT09_MIGRATION_OK') ? 'pass' : 'fail',
      start: {
        readyPath: '/api/health/ready',
        readyAttempt: Number((output.match(/^EXT09_READY attempt=(\d+)/m) || [])[1] ?? null),
        seed: output.includes('EXT09_SEED_OK') ? 'pass' : 'fail',
        shutdown: valueOf(output, 'EXT09_SHUTDOWN'),
      },
      streamable: {
        managedRuntime: managedTap,
        publicationEndpoints: publicationTap,
        scripts: [
          'packages/api-nova-server/scripts/test-managed-runtime.cjs',
          'packages/api-nova-server/scripts/test-publication-endpoints.cjs',
        ],
      },
      startupLogTail: (section(output, 'API_LOG') || '').trim().split('\n').filter(Boolean),
    },
    commands: {
      run: `docker run --rm --name ${containerName} --mount type=bind,source=<repo>,target=/repo,readonly -e EXT09_NODE_VERSION=${nodeVersion} ${image} bash -lc "<ubuntu-flow recipe>"`,
      api: 'DB_TYPE=sqlite DB_SQLITE_PATH=/work/data/ext09.sqlite PORT=9010 node dist/src/main.js (after npm run migration:run)',
      streamable: 'node --test --test-reporter=tap <managed-runtime|publication-endpoints>.cjs (cwd packages/api-nova-server)',
    },
    notCovered,
    durationMs: Date.now() - started,
    log: hostLog,
  };

  if (failures.length) {
    console.error('--- container output (tail) ---');
    console.error(output.slice(-12000));
    console.error(`[verify-ext-09] evidence: ${hostLog}`);
    fail(failures.join('; '));
  }

  console.log(JSON.stringify(report, null, 1));
  console.log('EXT_09_VERIFY_OK');
}

main();
