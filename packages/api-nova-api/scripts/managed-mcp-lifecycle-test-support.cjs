'use strict';
// TEST ONLY. Instrument isolated copies of API modules. No require-cache,
// environment, HTTP or production configuration override is installed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const ts = require('typescript');

function isolatedSource(file, overrides = {}, globals = {}) {
  const sourceRequire = createRequire(file);
  const localRequire = name => Object.hasOwn(overrides, name) ? overrides[name] : sourceRequire(name);
  localRequire.resolve = sourceRequire.resolve;
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true },
  }).outputText;
  new Function('require', 'exports', 'module', '__filename', '__dirname', ...Object.keys(globals), js)(
    localRequire, module.exports, module, file, path.dirname(file), ...Object.values(globals));
  return module.exports;
}

function instrumentedPreparation({ unresponsive = false } = {}) {
  const services = path.resolve(__dirname, '../src/modules/servers/services');
  const wire = require('api-nova-server');
  const productEntry = require.resolve('api-nova-server/dist/managed/entry.js');
  const fixtureEntry = path.resolve(__dirname, 'fixtures/managed-mcp-unresponsive-child.cjs');
  const timers = new Set(), children = [], kills = [], stopMessages = [];
  const nativeClosed = new Map();
  const globals = {
    setTimeout(callback, ms, ...args) {
      const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  };
  const channel = isolatedSource(path.join(services, 'managed-mcp-channel.ts'), {
    'node:child_process': { spawn(executable, args, options) {
      assert.equal(executable, process.execPath);
      assert.deepEqual(args, [productEntry]);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(Object.keys(options.env).some(k => /^NODE_/i.test(k)), false);
      const child = spawn(executable, unresponsive ? [fixtureEntry] : args, options);
      children.push(child);
      nativeClosed.set(child, new Promise(resolve => child.once('close', resolve)));
      const kill = child.kill.bind(child), send = child.send.bind(child);
      child.kill = signal => { kills.push({ pid: child.pid, signal }); return kill(signal); };
      child.send = (message, ...rest) => {
        if (message.type === 'stop') stopMessages.push({ pid: child.pid, time: Date.now() });
        return send(message, ...rest);
      };
      return child;
    } },
  }, globals);
  const Preparation = isolatedSource(path.join(services, 'managed-mcp-handoff-preparation.service.ts'), {
    './managed-mcp-channel': channel,
  }).ManagedMcpHandoffPreparationService;
  return {
    Preparation, children, timers, kills, stopMessages, limits: wire.MANAGED_HANDOFF_LIMITS,
    async assertDrained() {
      // Wait for native stdio/IPC close, not only the earlier process exit event.
      for (const child of children) {
        let timeout;
        try {
          await Promise.race([nativeClosed.get(child), new Promise((_, reject) => {
            timeout = setTimeout(() => reject(Error('test child did not close')), 5000);
          })]);
        } finally { clearTimeout(timeout); }
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.throws(() => process.kill(child.pid, 0), 'owned child must be dead');
        assert.equal(child.connected, false);
        assert.equal(child.stdin.destroyed, true);
        assert.equal(child.stdout.destroyed, true);
        assert.equal(child.stderr.destroyed, true);
        for (const event of ['message', 'error', 'exit', 'close', 'disconnect'])
          assert.equal(child.listenerCount(event), 0, `channel ${event} listener leaked`);
      }
      assert.equal(timers.size, 0, 'channel handshake/force-kill timers leaked');
    },
  };
}

module.exports = { instrumentedPreparation };
