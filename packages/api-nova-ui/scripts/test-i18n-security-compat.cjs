'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
// An isolated candidate can be tested without replacing the shared installation.
const packageRoot = path.resolve(process.env.I18N_PACKAGE_ROOT || path.join(root, 'packages/api-nova-ui'));
const resolved = createRequire(path.join(packageRoot, 'package.json'));
const Vue = resolved('vue');
const compiler = resolved('@intlify/message-compiler');
const base = resolved('@intlify/core-base');
const library = resolved('vue-i18n');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'vendor/i18n-node20/provenance.json'), 'utf8'));
const quiet = { ...console, warn() {} };

function loadTs(file, cache = new Map()) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const loaded = { exports: {} };
  cache.set(file, loaded);
  const localRequire = request => {
    if (request === 'vue-i18n') return library;
    if (request.startsWith('.')) {
      const prefix = path.resolve(path.dirname(file), request);
      const target = [prefix + '.ts', path.join(prefix, 'index.ts')].find(candidate => fs.existsSync(candidate));
      assert(target, request);
      return loadTs(target, cache);
    }
    return resolved(request);
  };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
  } }).outputText;
  new Function('require', 'module', 'exports', code)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
const application = loadTs(path.join(root, 'packages/api-nova-ui/src/locales/index.ts'));
const messages = application.i18n.global.messages.value;
const compile = message => new Function('return ' + compiler.baseCompile(message, {
  mode: 'arrow', onError(error) { throw error; }
}).code)();
const fixture = {
  srcdoc: '<iframe srcdoc="{content}"></iframe>',
  embedded: '<iframe srcdoc="<b>x</b>"></iframe>',
  mixed: '{0} {name}', named: '{name}',
  event: '<img src="x" onerror="alert(1)">',
  url: '<a href="java&#x73;cript:alert(1)">x</a>',
  clean: 'Hello {name}', plural: 'none | one | {count} items',
};
function exerciseTranslation(t) {
  assert.match(t('srcdoc', { content: '<b>x</b>' }), /&#115;rcdoc=/);
  assert.match(t('embedded'), /&#115;rcdoc=/);
  assert.doesNotMatch(t('embedded'), /[\s/]srcdoc\s*=/i);
  const named = Object.freeze({ name: '<b>x</b>' });
  const list = Object.freeze(['<i>list</i>']);
  assert.equal(t('mixed', list, { named }), '&lt;i&gt;list&lt;&#x2F;i&gt; &lt;b&gt;x&lt;&#x2F;b&gt;');
  const once = t('named', named);
  assert.equal(t('named', named), once, 'reusing values must not double escape them');
  assert.deepEqual(named, { name: '<b>x</b>' });
  assert.doesNotMatch(t('event'), /\sonerror\s*=/i);
  assert.match(t('url'), /href="about:blank"/);
  assert.equal(t('clean', { name: 'ApiNova' }), 'Hello ApiNova');
  assert.equal(t('plural', { count: 2 }, 2), '2 items');
}
async function loadEntry(row) {
  const packageDir = path.dirname(resolved.resolve(row.package === 'vue-i18n-9.14.5' ? 'vue-i18n/package.json' :
    row.package === 'intlify-shared-9.14.5' ? '@intlify/shared/package.json' : '@intlify/core-base/package.json'));
  const file = path.join(packageDir, row.file);
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(digest(source), row.patchedSha256, 'Installed bytes must match reviewed backport: ' + row.file);
  if (row.file.endsWith('.cjs')) return resolved(file);
  if (row.file.includes('.global.')) {
    const sandbox = { Vue, Object, console: quiet };
    vm.runInNewContext(source, sandbox, { filename: file });
    return sandbox.VueI18n || sandbox.IntlifyCoreBase;
  }
  if (row.file.endsWith('.mjs')) return await import(pathToFileURL(file).href);
  // Browser ESM builds only import Vue. Supply that exact dependency while
  // retaining native ESM evaluation for the complete production/development file.
  const key = '__apiNovaI18nTestVue';
  globalThis[key] = Vue;
  try {
    const esm = source.replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/g,
      (_match, names) => 'const {' + names.replace(/\bas\b/g, ':') + '} = globalThis.' + key + ';');
    return await import('data:text/javascript;base64,' + Buffer.from(esm).toString('base64'));
  } finally {
    delete globalThis[key];
  }
}

for (const row of provenance.files) {
  test('security and actual bytes: ' + row.package + '/' + row.file, async () => {
    const entry = await loadEntry(row);
    if (entry.sanitizeTranslatedHtml && !entry.createCoreContext) {
      assert.match(entry.sanitizeTranslatedHtml(fixture.embedded), /&#115;rcdoc=/);
      assert.match(entry.sanitizeTranslatedHtml(fixture.url), /href="about:blank"/);
      assert.doesNotMatch(entry.sanitizeTranslatedHtml(fixture.event), /\sonerror\s*=/i);
      return;
    }
    const runtimeOnly = row.file.includes('.runtime.');
    const catalog = runtimeOnly ? Object.fromEntries(Object.entries(fixture).map(([key, value]) => [key, compile(value)])) : fixture;
    if (entry.createI18n) {
      const instance = entry.createI18n({ legacy: false, locale: 'en-US', escapeParameter: true,
        warnHtmlMessage: false, messages: { 'en-US': catalog } });
      try { exerciseTranslation(instance.global.t); } finally { instance.dispose(); }
    } else {
      const context = entry.createCoreContext({ locale: 'en-US', escapeParameter: true,
        warnHtmlMessage: false, messageCompiler: compile, messages: { 'en-US': catalog } });
      exerciseTranslation((...args) => entry.translate(context, ...args));
    }
  });
}

function flatten(value, prefix = '', rows = []) {
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? prefix + '.' + key : key;
    if (typeof child === 'string') rows.push([name, child]);
    else if (child && typeof child === 'object') flatten(child, name, rows);
  }
  return rows;
}
test('all actual zh-CN/en-US messages compile, render and match precompiled output', () => {
  const sizes = [];
  const composer = application.i18n.global;
  for (const locale of ['zh-CN', 'en-US']) {
    const rows = flatten(messages[locale]);
    sizes.push(rows.length);
    assert.equal(rows.length, 1963, locale + ' message count changed');
    composer.locale.value = locale;
    for (const [key, text] of rows) {
      const fn = compile(text);
      const named = Object.fromEntries([...text.matchAll(/\{([A-Za-z_][\w]*)\}/g)].map(match => [match[1], 'ApiNova']));
      const actual = composer.t(key, named);
      const reference = fn(base.createMessageContext({ locale, named, messages: name => composer.tm(name) }));
      assert.equal(typeof actual, 'string', locale + '/' + key);
      assert.equal(actual, reference, locale + '/' + key);
    }
  }
  console.log(JSON.stringify({ marker: 'I18N_ACTUAL_MESSAGES_OK', locales: 2, messages: sizes, node: process.version }));
});

test('locale switching, storage, document language, preference validation and browser fallback', t => {
  const saved = new Map();
  const old = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  t.after(() => {
    for (const [key, descriptor] of Object.entries(old)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: '' } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-GB', languages: ['en-GB'] } });
  application.setLocale('zh-CN');
  const zh = application.i18n.global.t('common.confirm');
  application.setLocale('en-US');
  assert.equal(document.documentElement.lang, 'en-US');
  assert.equal(saved.get('api-nova-locale'), 'en-US');
  assert.notEqual(application.i18n.global.t('common.confirm'), zh);
  assert.equal(application.loadLocalePreference(), 'en-US');
  saved.set('api-nova-locale', 'unsupported');
  assert.equal(application.loadLocalePreference(), 'en-US');
  navigator.language = 'fr-FR';
  assert.equal(application.getBrowserLocale(), 'zh-CN');
  navigator.language = 'zh-TW';
  assert.equal(application.getBrowserLocale(), 'zh-CN');
  const fallback = library.createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'en-US',
    missingWarn: false, fallbackWarn: false, messages: { 'zh-CN': {}, 'en-US': { fallback: 'English fallback' } } });
  try { assert.equal(fallback.global.t('fallback'), 'English fallback'); } finally { fallback.dispose(); }
});

test('Vue text rendering keeps untrusted interpolated markup inert', async () => {
  const { renderToString } = resolved('@vue/server-renderer');
  const app = library.createI18n({ legacy: false, locale: 'en-US', messages: { 'en-US': { message: 'Value: {value}' } } });
  try {
    const html = await renderToString(Vue.createSSRApp({ render() {
      return Vue.h('div', app.global.t('message', { value: '<img src=x onerror=alert(1)>' }));
    } }));
    assert.equal(html, '<div>Value: &lt;img src=x onerror=alert(1)&gt;</div>');
  } finally { app.dispose(); }
});

test('vendor archives retain Node baseline and MIT license and match provenance', () => {
  for (const row of provenance.archives) {
    const name = row.package;
    const pkg = resolved(name + '/package.json');
    assert.equal(pkg.version, '9.14.5');
    assert.equal(pkg.engines.node, '>= 16');
    assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.apiNovaSecurityBackport.revision, 1);
    assert.equal(digest(fs.readFileSync(path.join(root, row.archive))), row.sha256);
    assert(fs.readFileSync(path.join(path.dirname(resolved.resolve(name + '/package.json')), 'LICENSE'), 'utf8').includes('MIT'));
  }
});
