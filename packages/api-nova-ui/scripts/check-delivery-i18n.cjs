'use strict';
// Bounded MAINT-02 check: encoding and visible-text sanity for the current
// delivery UI surfaces only. It is not a full-application i18n audit and does
// not drive automatic micro-fixes; non-comment raw CJK lines are reported for
// maintenance visibility.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scope = [
  'src/modules/runtime-assets/McpPublicationDialog.vue',
  'src/modules/runtime-assets/TemporaryAnonymousEditor.vue',
  'src/modules/runtime-assets/UpstreamCredentialPanel.vue',
  'src/modules/runtime-assets/RuntimeAssetDetail.vue',
  'src/modules/endpoint-registry/RuntimeUpstreamBindingDialog.vue',
  'src/modules/endpoint-registry/gateway-route-auth.ts',
  'src/services/mcp-publication.ts',
  'src/services/upstream-credentials.ts',
];
const decoder = new TextDecoder('utf-8', { fatal: true });
let failures = 0;
const report = [];
for (const file of scope) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    failures += 1;
    report.push({ file, status: 'missing' });
    continue;
  }
  let text;
  try {
    text = decoder.decode(fs.readFileSync(full));
  } catch {
    failures += 1;
    report.push({ file, status: 'invalid-utf8' });
    continue;
  }
  const mojibake = (text.match(/\uFFFD/g) || []).length;
  const visibleCjkLines = text.split(/\r?\n/)
    .filter(line => /[\u4e00-\u9fff]/.test(line) && !/^\s*(\/\/|\/\*|\*|<!--)/.test(line)).length;
  if (mojibake > 0) failures += 1;
  report.push({ file, mojibake, visibleCjkLines, status: mojibake > 0 ? 'mojibake' : 'ok' });
}
for (const row of report) console.log(JSON.stringify({ marker: 'DELIVERY_I18N_FILE', ...row }));
if (failures) {
  console.error(JSON.stringify({ marker: 'DELIVERY_I18N_CHECK_FAILED', failures }));
  process.exit(1);
}
console.log(JSON.stringify({
  marker: 'DELIVERY_I18N_CHECK_OK',
  files: report.length,
  mojibake: 0,
  visibleCjkLines: report.reduce((sum, row) => sum + reg(row.visibleCjkLines), 0),
  scope,
  note: 'visible raw CJK lines are reported for maintenance visibility only',
}));

function reg(value) {
  return Number(value) || 0;
}
