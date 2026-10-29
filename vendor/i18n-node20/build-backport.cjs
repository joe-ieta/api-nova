'use strict';
// Build-time only. No install hooks or runtime monkey patches.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const input = path.resolve(process.argv[2] || '.tmp/vue-i18n-candidate');
const npmCli = process.argv[3] || process.env.npm_execpath;
const checkOnly = process.argv.includes('--check');
assert(npmCli && fs.existsSync(npmCli), 'Pass the npm CLI path as the second argument');
const work = fs.mkdtempSync(path.join(input, 'backport-build-'));
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  crypto.createHash(algorithm).update(bytes).digest(encoding);
const inputs = {
  'vue-i18n-9.14.5': 'sha512-0jQ9Em3ymWngyiIkj0+c/k7WgaPO+TNzjKSNq9BvBQaKJECqn9cd9fL4tkDhB5G1QBskGl9YxxbDAhgbFtpe2g==',
  'intlify-shared-9.14.5': 'sha512-9gB+E53BYuAEMhbCAxVgG38EZrk59sxBtv3jSizNL2hEWlgjBjAw1AwpLHtNaeda12pe6W20OGEa0TwuMSRbyQ==',
  'intlify-core-base-9.14.5': 'sha512-5ah5FqZG4pOoHjkvs8mjtv+gPKYU0zCISaYNjBNNqYiaITxW8ZtVih3GS/oTOqN8d9/mDLyrjD46GBApNxmlsA==',
  'intlify-shared-11.4.16': 'sha512-xehmkbEgbbNh/V+d8r3hFup0ViaN29YTJSAfRr28C54rxjyZEO0RNQKqW7VVajj16gLdglotNjiq+sIVNtHGzw==',
  'intlify-core-base-11.4.16': 'sha512-xB8nMdMRLNx7b0zPvrHy0+N9uq9Vfi1aUxHqWgn2e2/TbjCKy8HfoFpnUXXxVP8I0p1ccd6LFSC3XsFjZ3vweA=='
};
for (const [name, integrity] of Object.entries(inputs)) {
  const archive = path.join(input, name + '.tgz');
  assert.equal('sha512-' + digest(fs.readFileSync(archive), 'sha512', 'base64'), integrity, name);
  const dest = path.join(work, name);
  fs.mkdirSync(dest);
  cp.execFileSync('tar', ['-xf', archive, '-C', dest]);
}
const donorShared = fs.readFileSync(path.join(work, 'intlify-shared-11.4.16/package/dist/shared.prod.cjs'), 'utf8');
const donorCore = fs.readFileSync(path.join(work, 'intlify-core-base-11.4.16/package/dist/core-base.cjs'), 'utf8');
// Take the complete official sanitizer, including its URL-normalization helpers.
const sanitizer = donorShared.slice(donorShared.indexOf('function escapeAttributeValue('), donorShared.indexOf('\n/**', donorShared.indexOf('function sanitizeTranslatedHtml('))).trim();
assert(sanitizer.includes('srcdocAttributePattern') && sanitizer.includes('hasJavascriptScheme'));
const escapeStart = donorCore.indexOf('function escapeParams(');
const escapeParams = donorCore.slice(escapeStart, donorCore.indexOf('\nfunction resolveMessageFormat', escapeStart)).trim();
const escapeHtmlStart = donorShared.indexOf('function escapeHtml(');
const escapeHtml = donorShared.slice(escapeHtmlStart, donorShared.indexOf('\nfunction escapeAttributeValue', escapeHtmlStart)).trim();
const sanitizerNames = [...sanitizer.matchAll(/(?:function|const) (\w+)/g)].map(match => match[1]);
const renamedSanitizer = sanitizerNames.reduce((text, name) => name === 'sanitizeTranslatedHtml' ? text :
  text.replace(new RegExp('\\b' + name + '\\b', 'g'), 'apiNovaI18n_' + name), sanitizer);
const portableEscapeParams = escapeParams
  .replaceAll('shared.isArray(', 'Array.isArray(')
  .replaceAll('shared.isObject(options.named)', '(options.named !== null && typeof options.named === "object")')
  .replaceAll('shared.isString(item)', '(typeof item === "string")')
  .replaceAll('shared.isString(value)', '(typeof value === "string")')
  .replaceAll('shared.create()', 'Object.create(null)')
  .replaceAll('shared.escapeHtml(', 'apiNovaI18n_escapeHtml(');
assert(!portableEscapeParams.includes('shared.'));
const changed = [];
for (const name of ['vue-i18n-9.14.5', 'intlify-shared-9.14.5', 'intlify-core-base-9.14.5']) {
  const pkg = path.join(work, name, 'package');
  for (const entry of fs.readdirSync(path.join(pkg, 'dist')).sort()) {
    if (!/\.(?:js|mjs|cjs)$/.test(entry)) continue;
    const file = path.join(pkg, 'dist', entry);
    const source = fs.readFileSync(file, 'utf8');
    assert(!source.includes('apiNovaI18n_'));
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const replacements = [];
    const kinds = [];
    function visit(node) {
      // Minifiers inline these helpers as function expressions inside translate().
      // Patch the innermost implementation, never its enclosing caller/IIFE.
      ts.forEachChild(node, visit);
      if (ts.isParenthesizedExpression(node)) {
        const text = source.slice(node.getStart(tree), node.end);
        // The three global production builds inline the entire sanitizer as a
        // comma expression. Preserve translate(), replacing only that expression.
        const result = text.match(/,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\)$/);
        if (text.length < 1200 && result && text.includes('javascript&#58;')) {
          kinds.push('sanitizer');
          replacements.push({ start: node.getStart(tree), end: node.end,
            text: '(' + result[1] + '=(function () {\n' + renamedSanitizer +
              '\nreturn sanitizeTranslatedHtml;\n})()(' + result[1] + '))' });
          return;
        }
      }
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.body) {
        if (replacements.some(item => item.start > node.getStart(tree) && item.end <= node.end)) return;
        const text = source.slice(node.getStart(tree), node.end);
        if (text.length < 5000 && text.includes('javascript&#58;')) {
          kinds.push('sanitizer');
          replacements.push({ start: node.getStart(tree), end: node.end,
            text: ts.isFunctionExpression(node)
              ? '(function () {\n' + renamedSanitizer + '\nreturn sanitizeTranslatedHtml;\n})()'
              : renamedSanitizer.replace('function sanitizeTranslatedHtml(', 'function ' + node.name.text + '(') });
          return;
        }
        if (text.length < 1500 && /Object\.keys\(\w+\.named\)\.forEach/.test(text) && text.includes('.list')) {
          kinds.push('escapeParams');
          replacements.push({ start: node.getStart(tree), end: node.end,
            text: portableEscapeParams.replace('function escapeParams(options) {',
              'function ' + (node.name?.text || '') + '(options) {\n' +
              escapeHtml.replace('function escapeHtml(', 'function apiNovaI18n_escapeHtml(')) });
          return;
        }
      }
    }
    visit(tree);
    assert(kinds.filter(kind => kind === 'sanitizer').length <= 1, entry);
    assert(kinds.filter(kind => kind === 'escapeParams').length <= 1, entry);
    if (!replacements.length) continue;
    let output = source;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
    }
    const parsed = ts.createSourceFile(file, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(parsed.parseDiagnostics.length, 0, entry + ' must parse after patching');
    fs.writeFileSync(file, output);
    changed.push({ package: name, file: 'dist/' + entry, patches: kinds,
      upstreamSha256: digest(source), patchedSha256: digest(output) });
  }
  const manifestPath = path.join(pkg, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.engines.node, '>= 16', 'Do not relax or raise upstream engines');
  manifest.apiNovaSecurityBackport = { revision: 1, donor: 'intlify/vue-i18n@11.4.16',
    advisories: ['GHSA-83rm-6c8r-g728', 'GHSA-8rc2-428q-7ww3'] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
// Expected coverage: shared 5, core 7, Vue full/runtime browser+global 8.
assert.equal(changed.length, 20, 'Every bundled/exported vulnerable implementation must be patched');
assert.equal(changed.filter(row => row.patches.includes('sanitizer')).length, 17);
assert.equal(changed.filter(row => row.patches.includes('escapeParams')).length, 15);
const archives = [];
let identicalGzipBytes = true;
for (const name of ['vue-i18n-9.14.5', 'intlify-shared-9.14.5', 'intlify-core-base-9.14.5']) {
  const pkg = path.join(work, name, 'package');
  const result = JSON.parse(cp.execFileSync(process.execPath, [npmCli, 'pack', pkg, '--ignore-scripts', '--json', '--pack-destination', work], { encoding: 'utf8' }))[0];
  const archiveName = name + '-apinova-security.1.tgz';
  const archiveBytes = fs.readFileSync(path.join(work, result.filename));
  if (checkOnly) {
    const reviewedBytes = fs.readFileSync(path.join(__dirname, archiveName));
    identicalGzipBytes = identicalGzipBytes && reviewedBytes.equals(archiveBytes);
    // Node 20 and 24 embed different zlib releases: compressed bytes can differ
    // even when the complete tar (payload, paths, modes, order, dates) is identical.
    assert(zlib.gunzipSync(reviewedBytes).equals(zlib.gunzipSync(archiveBytes)), archiveName + ' tar payload is not reproducible');
  }
  else fs.writeFileSync(path.join(__dirname, archiveName), archiveBytes);
  archives.push({ package: JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).name,
    version: '9.14.5', archive: 'vendor/i18n-node20/' + archiveName,
    integrity: 'sha512-' + digest(fs.readFileSync(path.join(__dirname, archiveName)), 'sha512', 'base64'),
    sha256: digest(fs.readFileSync(path.join(__dirname, archiveName))) });
}
const provenance = { localPatch: 'apinova-i18n-security.1', nodeEngineUnchanged: '>= 16',
  projectNodeBaselineUnchanged: '>=20.0.0', upstreamInputs: inputs,
  sanitizerDonorSha256: digest(sanitizer), escapeParamsDonorSha256: digest(escapeParams),
  source: ['https://github.com/intlify/vue-i18n/commit/43391d20e7c85403cb59bdb21b5d542819f54042',
    'https://github.com/intlify/vue-i18n/pull/2680', 'https://github.com/intlify/vue-i18n/releases/tag/v11.4.16'],
  archives, files: changed };
if (checkOnly) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, 'provenance.json'), 'utf8')), provenance);
else fs.writeFileSync(path.join(__dirname, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ marker: checkOnly ? 'I18N_BACKPORT_REPRODUCIBLE' : 'I18N_BACKPORT_BUILT', files: changed.length, identicalGzipBytes, archives }));
