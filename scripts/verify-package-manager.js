const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const failures = [];
const forbiddenArtifacts = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
];

function fail(message) {
  failures.push(message);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.packageManager !== 'npm@10.9.2') {
  fail(`packageManager must be npm@10.9.2, received ${manifest.packageManager || '<missing>'}`);
}
if (JSON.stringify(manifest.workspaces) !== JSON.stringify(['packages/*'])) {
  fail('root workspaces must be exactly ["packages/*"]');
}
if (!fs.existsSync(path.join(root, 'package-lock.json'))) {
  fail('package-lock.json is required');
}
for (const artifact of forbiddenArtifacts) {
  if (fs.existsSync(path.join(root, artifact))) fail(`${artifact} is not allowed`);
}

const userAgent = process.env.npm_config_user_agent || '';
if (userAgent && !userAgent.startsWith('npm/')) {
  fail(`repository lifecycle commands require npm; received ${userAgent}`);
}

const scanRoots = ['scripts', '.github', '.codex'];
const commandPattern = /\b(?:pnpm(?:\.cmd)?|yarn)\b/i;
for (const relativeRoot of scanRoots) {
  const directory = path.join(root, relativeRoot);
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else if (target !== __filename) {
        const content = fs.readFileSync(target, 'utf8');
        if (commandPattern.test(content)) fail(`non-npm command found in ${path.relative(root, target)}`);
      }
    }
  };
  visit(directory);
}

const manifestPaths = [
  'package.json',
  ...fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join('packages', entry.name, 'package.json'))
    .filter(relative => fs.existsSync(path.join(root, relative))),
];
for (const relative of manifestPaths) {
  const content = fs.readFileSync(path.join(root, relative), 'utf8');
  if (commandPattern.test(content)) fail(`non-npm command found in ${relative}`);
}

const documentationCommandPattern = /\b(?:pnpm(?:\.cmd)?|yarn)\s+(?:install|ci|run|build|test|lint|type-check|add|pack|publish|changeset|--filter|global|dev|start)\b/i;
const documentationRoots = ['docs/guides', 'docs/reference', 'docs/testing', 'packages'];
const documentationFiles = ['README.md', 'README_EN.md', 'PRODUCT_CONSTRAINTS.md', 'PROJECT_BASELINE.md', 'RELEASE_BASELINE_V1.md'];
const checkDocumentation = target => {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) checkDocumentation(path.join(target, entry));
  } else if (path.extname(target).toLowerCase() === '.md') {
    const content = fs.readFileSync(target, 'utf8');
    if (documentationCommandPattern.test(content)) {
      fail(`non-npm repository command found in ${path.relative(root, target)}`);
    }
  }
};
documentationRoots.forEach(relative => checkDocumentation(path.join(root, relative)));
documentationFiles
  .map(relative => path.join(root, relative))
  .filter(target => fs.existsSync(target))
  .forEach(checkDocumentation);

if (failures.length) {
  console.error('[package-manager] npm baseline verification failed:');
  failures.forEach(message => console.error(`- ${message}`));
  process.exit(1);
}
console.log('[package-manager] npm workspace baseline verified');
