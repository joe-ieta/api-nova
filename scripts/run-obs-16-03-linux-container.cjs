'use strict';
// OBS-16-03 Stage 3: Linux container subset.
//
// Runs the Stage 1 PostgreSQL multi-process lane and the Stage 2 receiver matrix inside the
// already-present local node:24-alpine image (no pulls). Proven recipe: repo mounted
// read-only, needed sources tarred to an exec tmpfs workspace, workspace packages resolved
// through NODE_PATH, isolated PostgreSQL from Alpine postgresql16 + postgresql16-contrib,
// loopback-only receivers. `--network none` cannot be used while the Alpine package
// mirror is required; the tests themselves never leave loopback except one reserved
// `.invalid` DNS name that must fail resolution.
//
// Prints one OBS_16_03_LINUX_DETAIL JSON line; exit 0 only when no real stage failed.
// Blocked cells carry a concrete prerequisite/reason.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const image = process.env.OBS16_LINUX_IMAGE || 'node:24-alpine';
const tempRoot = process.env.OBS16_TMP_DIR || os.tmpdir();
const logRoot = path.join(tempRoot, 'obs-16-03-linux');
const containerName = `obs16-linux-${process.pid}`;

function docker(args, options = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024, ...options,
  });
}
function tapCounts(output) {
  const count = name => {
    const matches = [...String(output).matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    return matches.length ? Number(matches.pop()[1]) : null;
  };
  return { tests: count('tests'), pass: count('pass'), fail: count('fail') };
}
function detailLine(output, marker) {
  const line = String(output).split('\n').find(value => value.includes(marker));
  if (!line) return null;
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(line.slice(start, end + 1)); } catch { return null; }
}
function section(output, name) {
  const begin = `===OBS16_${name}_BEGIN===`;
  const end = `===OBS16_${name}_END===`;
  const start = output.indexOf(begin);
  const stop = output.indexOf(end);
  if (start < 0 || stop < 0) return null;
  return output.slice(start + begin.length, stop);
}

const inContainerScript = [
  'set +e',
  'if ! apk add --no-cache postgresql16 postgresql16-contrib >/tmp/apk.log 2>&1; then',
  '  echo OBS16_APK_INSTALL_FAILED; cat /tmp/apk.log; exit 90;',
  'fi',
  'if id -u node >/dev/null 2>&1; then RUNNER=node; else adduser -D runner || exit 91; RUNNER=runner; fi',
  'mkdir -p /work/tmp /work/repo /work/obs16-tmp /work/scripts /run/postgresql || exit 92',
  'tar -C /repo/packages/api-nova-api -cf - src scripts dist package.json tsconfig.json 2>/dev/null | tar -C /work/repo -xf - || exit 93',
  'chown -R "$RUNNER" /work /run/postgresql || exit 94',
  "cat > /work/scripts/stage1.sh <<'OBS16_STAGE1'",
  '#!/bin/sh',
  'cd /work/repo || exit 95',
  'export NODE_PATH=/repo/node_modules:/repo/packages',
  'export TMPDIR=/work/tmp TMP=/work/tmp TEMP=/work/tmp',
  'export OBS16_TMP_DIR=/work/obs16-tmp',
  'export API_NOVA_TEST_PG_BIN=/usr/bin',
  'exec node --test --test-reporter=tap scripts/test-obs-16-03-pg-multiprocess.cjs',
  'OBS16_STAGE1',
  "cat > /work/scripts/stage2.sh <<'OBS16_STAGE2'",
  '#!/bin/sh',
  'cd /work/repo || exit 96',
  'export NODE_PATH=/repo/node_modules:/repo/packages',
  'export TMPDIR=/work/tmp TMP=/work/tmp TEMP=/work/tmp',
  'exec node --test --test-reporter=tap scripts/test-obs-16-03-receiver-matrix.cjs',
  'OBS16_STAGE2',
  'chmod 755 /work/scripts/stage1.sh /work/scripts/stage2.sh',
  'echo "OBS16_NODE_VERSION=$(node --version)"',
  'echo "OBS16_INITDB_VERSION=$(initdb --version 2>&1 | head -1)"',
  "echo '===OBS16_STAGE1_BEGIN==='",
  'su -s /bin/sh "$RUNNER" -c /work/scripts/stage1.sh',
  'STATUS1=$?',
  'echo "OBS16_STAGE1_EXIT=$STATUS1"',
  "echo '===OBS16_STAGE1_END==='",
  "echo '===OBS16_STAGE2_BEGIN==='",
  'su -s /bin/sh "$RUNNER" -c /work/scripts/stage2.sh',
  'STATUS2=$?',
  'echo "OBS16_STAGE2_EXIT=$STATUS2"',
  "echo '===OBS16_STAGE2_END==='",
  'exit 0',
].join('\n');

function blocked(cellId, reason) {
  return { cellId, result: 'blocked', reason };
}

function main() {
  fs.mkdirSync(logRoot, { recursive: true });
  const cells = [];
  const blockedCells = [];

  const probe = docker(['version', '--format', '{{.Server.Version}}']);
  if (probe.status !== 0) {
    blockedCells.push(blocked('linux-container-stage1-pg-multiprocess',
      'Docker engine unavailable: ' + String(probe.stderr || '').trim()));
    blockedCells.push(blocked('linux-container-stage2-receiver-matrix',
      'Docker engine unavailable: ' + String(probe.stderr || '').trim()));
  } else if (docker(['image', 'inspect', image, '--format', '{{.Id}}']).status !== 0) {
    blockedCells.push(blocked('linux-container-stage1-pg-multiprocess',
      `Local image ${image} not present; no pulls are permitted. Preload the image or set OBS16_LINUX_IMAGE.`));
    blockedCells.push(blocked('linux-container-stage2-receiver-matrix',
      `Local image ${image} not present; no pulls are permitted. Preload the image or set OBS16_LINUX_IMAGE.`));
  }

  if (blockedCells.length) {
    console.log('OBS_16_03_LINUX_DETAIL ' + JSON.stringify({
      marker: 'OBS_16_03_LINUX_DETAIL', status: 'blocked', cells, blocked: blockedCells,
      environment: { platform: process.platform, docker: null, image },
    }));
    process.exit(0);
  }

  const imageId = String(docker(['image', 'inspect', image, '--format', '{{.Id}}']).stdout || '').trim();
  const started = Date.now();
  const run = docker(['run', '--rm', '--name', containerName,
    '--mount', `type=bind,source=${repository},target=/repo,readonly`,
    '--tmpfs', '/work:exec,size=1024m',
    image, 'sh', '-c', inContainerScript], { timeout: 1500000 });
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  const hostLog = path.join(logRoot, `linux-container-${Date.now()}.log`);
  fs.writeFileSync(hostLog, output);
  docker(['rm', '-f', containerName]);

  const stage1Output = section(output, 'STAGE1');
  const stage2Output = section(output, 'STAGE2');
  const nodeVersion = (output.match(/OBS16_NODE_VERSION=(.+)/) || [])[1] || null;
  const initdbVersion = (output.match(/OBS16_INITDB_VERSION=(.+)/) || [])[1] || null;
  const stage1Exit = Number((output.match(/OBS16_STAGE1_EXIT=(\d+)/) || [])[1]);
  const stage2Exit = Number((output.match(/OBS16_STAGE2_EXIT=(\d+)/) || [])[1]);
  const stage1Env = stage1Output ? detailLine(stage1Output, 'OBS_16_03_STAGE1_ENV') : null;
  const stage1Tap = stage1Output ? tapCounts(stage1Output) : null;
  const stage2Detail = stage2Output ? detailLine(stage2Output, 'OBS_16_03_RECEIVER_DETAIL') : null;
  const stage2Tap = stage2Output ? tapCounts(stage2Output) : null;
  const apkFailed = output.includes('OBS16_APK_INSTALL_FAILED');

  if (apkFailed) {
    blockedCells.push(blocked('linux-container-stage1-pg-multiprocess',
      'Alpine postgresql16 install failed; the isolated in-container PostgreSQL prerequisite is missing.'));
    blockedCells.push(blocked('linux-container-stage2-receiver-matrix',
      'The container could not be prepared (Alpine package install failed) for this run.'));
  } else {
    const stage1Pass = stage1Exit === 0 && stage1Tap && stage1Tap.fail === 0 && stage1Tap.tests > 0;
    cells.push({
      cellId: 'linux-container-stage1-pg-multiprocess',
      result: stage1Pass ? 'pass' : 'fail',
      command: `docker run --rm --mount type=bind,source=<repo>,target=/repo,readonly --tmpfs /work:exec,size=1024m ${image} sh -c "<stage1 recipe>"`,
      tap: stage1Tap, exitCode: Number.isFinite(stage1Exit) ? stage1Exit : null,
      postgres: stage1Env ? stage1Env.postgresVersion : null,
      evidence: hostLog,
    });
    if (!stage1Pass) {
      console.error('--- Linux container stage 1 output (tail) ---');
      console.error(String(stage1Output || output).slice(-12000));
    }

    const stage2Pass = stage2Exit === 0 && stage2Tap && stage2Tap.fail === 0 && stage2Tap.tests > 0;
    cells.push({
      cellId: 'linux-container-stage2-receiver-matrix',
      result: stage2Pass ? 'pass' : 'fail',
      command: `docker run --rm --mount type=bind,source=<repo>,target=/repo,readonly --tmpfs /work:exec,size=1024m ${image} sh -c "<stage2 recipe>"`,
      tap: stage2Tap, exitCode: Number.isFinite(stage2Exit) ? stage2Exit : null,
      tlsSuccess: stage2Detail ? stage2Detail.tlsSuccess : null,
      evidence: hostLog,
    });
    if (!stage2Pass) {
      console.error('--- Linux container stage 2 output (tail) ---');
      console.error(String(stage2Output || output).slice(-12000));
    }
  }

  blockedCells.push(blocked('linux-container-network-none',
    'Alpine postgresql16 + postgresql16-contrib require the package mirror before the run, '
    + 'so the test phase cannot use --network none. Only loopback and one reserved .invalid '
    + 'DNS name are exercised by the tests.'));

  const failed = cells.some(cell => cell.result === 'fail');
  const detail = {
    marker: 'OBS_16_03_LINUX_DETAIL',
    status: failed ? 'failed' : 'pass',
    cells,
    blocked: blockedCells,
    environment: {
      hostPlatform: process.platform, hostArch: process.arch,
      dockerServer: String(probe.stdout || '').trim(),
      image, imageId,
      containerNode: nodeVersion, containerPostgres: initdbVersion,
      recipe: 'repo read-only bind mount; packages/api-nova-api tarred to /work tmpfs (exec); '
        + 'NODE_PATH=/repo/node_modules:/repo/packages; isolated PostgreSQL 16 from Alpine '
        + 'postgresql16+contrib; PG data under /work tmpfs; loopback receivers only',
      networkMode: 'default bridge (Alpine package mirror install only; tests use loopback '
        + 'and one reserved .invalid DNS name)',
      rootDiskFreeBytes: null,
    },
    durationMs: Date.now() - started,
    log: hostLog,
  };
  console.log('OBS_16_03_LINUX_DETAIL ' + JSON.stringify(detail));
  process.exit(failed ? 1 : 0);
}

main();
