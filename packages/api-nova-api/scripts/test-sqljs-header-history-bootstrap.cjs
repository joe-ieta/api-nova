'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-bootstrap-'));
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
  Object.assign(env, { NODE_ENV: 'test', DB_TYPE: 'sqlite', DB_SQLITE_PATH: path.join(root, 'db.sqlite'), API_NOVA_AUDIT_DIR: path.join(root, 'audit'), JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex') });
  const child = spawnSync(process.execPath, [path.join(__dirname, 'test-postgres-header-history-bootstrap.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 100000 });
  assert.equal(child.status, 0, child.stderr); const line = child.stdout.split(/\r?\n/).find(line => line.startsWith('{"marker":'));
  const report = JSON.parse(line); assert.equal(report.dialect, 'sqljs');
  console.log(JSON.stringify({ ...report, marker: 'SQLJS_HEADER_HISTORY_BOOTSTRAP_OK' }));
} finally { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('history-bootstrap-')); fs.rmSync(root, { recursive: true, force: true }); }
