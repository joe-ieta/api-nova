// MAIL-02 controlled mail delivery evidence runner. Runs the mail Jest specs
// from packages/api-nova-api against the local sink and prints one JSON line.
// No external SMTP host, no real recipient and no network beyond loopback.
'use strict';
const { spawnSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const apiCwd = path.join(repository, 'packages', 'api-nova-api');
const SPECS = Object.freeze([
  'src/modules/mail/services/mail-template.service.spec.ts',
  'src/modules/mail/services/mail.service.spec.ts',
  'src/modules/mail/transports/smtp.mail-transport.spec.ts',
  'src/modules/security/services/auth-mail-delivery.spec.ts',
  'src/modules/websocket/services/notification.service.spec.ts',
  'src/database/user-email-verification-expiry-migration.spec.ts',
]);

for (const spec of SPECS) {
  if (!fs.existsSync(path.join(apiCwd, spec))) {
    throw new Error(`Missing ${spec}. Run from the repository root.`);
  }
}

const jestPackage = path.dirname(
  require.resolve('jest/package.json', { paths: [apiCwd] }),
);
const jestCli = path.join(jestPackage, 'bin', 'jest.js');
if (!fs.existsSync(jestCli)) {
  throw new Error(`Jest CLI was not found at ${jestCli}`);
}
const sinkDir = path.join(os.tmpdir(), `api-nova-mail-02-sink-${process.pid}`);
fs.rmSync(sinkDir, { recursive: true, force: true });
fs.mkdirSync(sinkDir, { recursive: true });
const reportFile = path.join(sinkDir, 'jest-report.json');

const environment = {
  ...process.env,
  NODE_ENV: 'test',
  MAIL_SINK_DIR: sinkDir,
  JWT_SECRET: 'mail-02-local-verification-secret',
  JWT_REFRESH_SECRET: 'mail-02-local-verification-refresh-secret',
  JWT_EXPIRES_IN: '15m',
};

const started = Date.now();
const run = spawnSync(
  process.execPath,
  [jestCli, '--runInBand', '--json', '--outputFile', reportFile, ...SPECS],
  {
    cwd: apiCwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: environment,
    timeout: 15 * 60 * 1000,
  },
);
if (run.error) throw run.error;

let jestReport = null;
if (fs.existsSync(reportFile)) {
  jestReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
}

const suites = (jestReport?.testResults ?? []).map((result) => {
  const assertions = result.assertionResults ?? [];
  return {
    name: path.relative(apiCwd, result.name).replace(/\\/g, '/'),
    status: result.status,
    tests: assertions.length,
    pass: assertions.filter((assertion) => assertion.status === 'passed').length,
    fail: assertions.filter((assertion) => assertion.status === 'failed').length,
  };
});

const failures = [];
if (run.status !== 0 || !jestReport?.success) failures.push('jest');
for (const suite of suites) {
  if (suite.fail > 0 || suite.status === 'failed') failures.push(suite.name);
}

const outcome = {
  marker: failures.length ? 'MAIL_02_FAILED' : 'MAIL_02_OK',
  status: failures.length ? 'failed' : 'pass',
  workPackage: 'MAIL-02',
  environment: {
    commit: execSync('git rev-parse HEAD', { cwd: repository, encoding: 'utf8' }).trim(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cwd: apiCwd,
  },
  sinkDir,
  suites,
  totals: {
    suites: jestReport?.numTotalTestSuites ?? 0,
    tests: jestReport?.numTotalTests ?? 0,
    pass: jestReport?.numPassedTests ?? 0,
    fail: jestReport?.numFailedTests ?? 0,
  },
  failures,
  notCovered: [
    'real external SMTP delivery and third-party providers (loopback fake SMTP and local sink only)',
    'PostgreSQL runtime execution of the new migration (SQLite is exercised end-to-end; PostgreSQL DDL is asserted by spec)',
    'persistent/multi-process delivery queue, bounce handling and durable delivery records',
    'UI preference toggle for users.preferences.notifications.email (no settings UI exists)',
    'browser-level UI automation (views compile and build; no e2e runner)',
  ],
  durationMs: Date.now() - started,
};

console.log(JSON.stringify(outcome));
if (failures.length) {
  if (run.stdout) console.error(run.stdout.slice(-6000));
  if (run.stderr) console.error(run.stderr.slice(-6000));
  process.exit(1);
}
