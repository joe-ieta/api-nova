// OBS-13-02 local long-transport and slow-consumer matrix. Covers both streams:
// invocation facts (node:test realtime script) and server_state_v1 (jest real
// Socket.IO spec). Windows local only; no soak/load, cross-platform or
// multi-instance claims.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const apiCwd = path.resolve(__dirname, '../packages/api-nova-api');
const strip = value => String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');
const count = (output, name) => Number([...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].pop()?.[1] ?? NaN);

const tap = spawnSync(process.execPath,
  ['--test', '--test-reporter=tap', path.join(apiCwd, 'scripts', 'test-call-observability-realtime.cjs')],
  { cwd: apiCwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
if (tap.error) throw tap.error;
const tapOutput = strip(`${tap.stdout || ''}\n${tap.stderr || ''}`);
if (tap.status !== 0) { console.error(tapOutput.slice(-8000)); throw new Error('invocation facts realtime script failed'); }
const invocationFacts = { script: 'test-call-observability-realtime.cjs', tests: count(tapOutput, 'tests'), pass: count(tapOutput, 'pass'), fail: count(tapOutput, 'fail') };

const jest = require.resolve('jest/bin/jest', { paths: [apiCwd] });
const state = spawnSync(process.execPath, [jest, 'call-observability-server-state-realtime', '--runInBand', '--silent'],
  { cwd: apiCwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
if (state.error) throw state.error;
const stateOutput = strip(`${state.stdout || ''}\n${state.stderr || ''}`);
if (state.status !== 0) { console.error(stateOutput.slice(-8000)); throw new Error('server_state_v1 realtime spec failed'); }
const stateStream = { suite: 'call-observability-server-state-realtime.spec.ts', tests: [...stateOutput.matchAll(/^Tests:\s+(.+)$/gm)].pop()?.[1]?.trim() ?? 'unknown' };

console.log(JSON.stringify({
  marker: 'OBS_13_02_OK',
  workPackage: 'OBS-13-02',
  environment: { commit: require('node:child_process').execSync('git rev-parse HEAD', { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim(),
    platform: process.platform, arch: process.arch, node: process.version },
  streams: {
    invocationFacts: { ...invocationFacts, slowConsumer: 'one in-flight page while ACK pending; resumes from the acknowledged cursor after ACK', recovery: 'unacknowledged pages replay from the last fully processed signed cursor' },
    serverStateV1: { ...stateStream, slowConsumer: 'one in-flight page per subscription; another subscriber pages unaffected; disconnect cleans the pending reader', recovery: 'replay unacknowledged pages, resume from fully processed cursor, ACK timeout/wrong cursor -> SLOW_CONSUMER' },
  },
  notCovered: ['long-duration soak and sustained load', 'Linux/multi-instance/cross-deployment recovery', 'real external receivers'],
  scope: 'local loopback Windows run; no production deployment claims',
}));
