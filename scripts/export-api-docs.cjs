'use strict';

// Documentation only: instantiate current controllers with a new, owned SQLite
// database. Never read a user's .env, listen publicly, or enable background loops.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const check = process.argv.includes('--check');
const tempParent = path.join(root, '.tmp');
fs.mkdirSync(tempParent, { recursive: true });
const owned = fs.mkdtempSync(path.join(tempParent, 'api-docs-'));
for (const key of Object.keys(process.env)) {
  if (/^(API_NOVA_|DB_|SUPER_ADMIN_|JWT_|MAIL_|MCP_)/i.test(key)
    || key.toLowerCase().startsWith('managedmcp.')) delete process.env[key];
}
const password = `Docs!${crypto.randomBytes(20).toString('hex')}`;
Object.assign(process.env, {
  NODE_ENV: 'test', DB_TYPE: 'sqlite', DB_SQLITE_PATH: path.join(owned, 'docs.sqlite'),
  DB_SYNCHRONIZE: 'false', DB_LOGGING: 'false',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
  SUPER_ADMIN_USERNAME: 'docsadmin', SUPER_ADMIN_EMAIL: 'docs@example.invalid',
  SUPER_ADMIN_PASSWORD: password, MAIL_ENABLED: 'false',
  API_NOVA_AUDIT_DIR: path.join(owned, 'audit'),
  LOG_DIRECTORY: path.join(owned, 'logs'), PID_DIRECTORY: path.join(owned, 'pids'),
  API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED: 'false',
  API_NOVA_OBSERVABILITY_OUTBOX_ENABLED: 'false',
  API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED: 'false',
});
const api = path.join(root, 'packages/api-nova-api/dist/src');
let app;
async function main() {
  require('reflect-metadata');
  const { AppDataSource } = require(path.join(api, 'database/data-source.js'));
  try {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
  const { NestFactory, ModulesContainer, MetadataScanner } = require('@nestjs/core');
  const { ValidationPipe } = require('@nestjs/common');
  const { GUARDS_METADATA } = require('@nestjs/common/constants');
  const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
  const { AppModule } = require(path.join(api, 'app.module.js'));
  app = await NestFactory.create(AppModule, { logger: false, bodyParser: false });
  app.setGlobalPrefix('api', { exclude: ['/', '/health', '/metrics', '/favicon.ico'] });
  const metadata = new Map();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const Controller = wrapper.metatype;
      if (!Controller) continue;
      for (const method of new MetadataScanner().getAllMethodNames(Controller.prototype)) {
        const handler = Controller.prototype[method];
        const get = key => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, Controller);
        metadata.set(`${Controller.name}_${method}`, {
          'x-apinova-public': get('isPublic') === true,
          'x-apinova-permissions': get('permissions') || [],
          'x-apinova-roles': get('roles') || [],
          'x-apinova-super-admin-only': get('superAdminOnly') === true,
          'x-apinova-controller-guards': [
            ...(Reflect.getMetadata(GUARDS_METADATA, Controller) || []),
            ...(Reflect.getMetadata(GUARDS_METADATA, handler) || []),
          ].map(guard => guard.name || guard.constructor?.name || 'custom'),
        });
      }
    }
  }
  const config = new DocumentBuilder().setTitle('ApiNova management API')
    .setDescription('Controller/DTO snapshot. Read README.md for response families, resource authorization, runtime routes and annotation limitations.')
    .setVersion('source-snapshot').addServer('http://127.0.0.1:9001')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer').build();
  const document = SwaggerModule.createDocument(app, config);
  // This decorator builds an example with Date.now(). Keep the illustrative
  // timestamp stable without changing validation, defaults or runtime behavior.
  const metadataExample = document.components?.schemas?.UpdateDocumentDto?.properties?.metadata?.example;
  if (metadataExample?.lastValidated) metadataExample.lastValidated = '2000-01-01T00:00:00.000Z';
  const sourceFiles = spawnSync('git', ['ls-files', '--', 'packages', 'package.json', 'package-lock.json'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(sourceFiles.status, 0);
  const codeHash = crypto.createHash('sha256');
  for (const file of sourceFiles.stdout.trim().split(/\r?\n/).filter(file => /\.(?:[cm]?js|tsx?|json)$/.test(file) && !file.includes('/docs/')).sort()) {
    // Text identity must not drift between Windows CRLF and Linux LF checkouts.
    codeHash.update(file + '\0').update(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  }
  document.info['x-repository-code-sha256'] = codeHash.digest('hex');
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const entries = [];
  const operationIds = new Set();
  for (const [route, item] of Object.entries(document.paths)) {
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      const details = metadata.get(operation.operationId);
      // Controller aliases share a handler; the exported OpenAPI IDs must still
      // be unique for schema consumers. Preserve the handler identity separately.
      operation['x-apinova-controller-operation'] = operation.operationId;
      if (operationIds.has(operation.operationId)) {
        operation.operationId += `__${method}_${route.replace(/[^a-zA-Z0-9]+/g, '_')}`;
      }
      assert.ok(!operationIds.has(operation.operationId), 'Duplicate exported operationId');
      operationIds.add(operation.operationId);
      if (details) Object.assign(operation, details);
      if (details?.['x-apinova-public']) operation.security = [];
      entries.push({ route, method, operation });
    }
  }
  entries.sort((a, b) => a.route.localeCompare(b.route, 'en') || a.method.localeCompare(b.method, 'en'));
  const escape = value => String(value || '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const lines = [
    '---', 'doc-version: 1.1.0', 'doc-status: active', 'doc-updated: 2026-10-26', '---',
    '# 管理API接口清单', '',
    '由 `node scripts/export-api-docs.cjs` 从已构建控制器及DTO生成。先阅读[接入手册](./README.md)；字段见[OpenAPI快照](./openapi.json)。禁止手工编辑本表。', '',
    `共 ${Object.keys(document.paths).length} 个路径、${entries.length} 个HTTP操作。快照覆盖Swagger可见的控制器，不包含动态Gateway转发、独立MCP监听及Socket.IO消息。`, '',
    '“公开”仅表示显式Public元数据；“控制器/服务校验”不表示匿名可用。权限列为RequirePermissions元数据，仍需角色、资源范围及服务检查；动态授权见接入手册。', '',
    '| 方法 | 路径 | 用途 | 入口/声明权限 |', '| --- | --- | --- | --- |',
    ...entries.map(({ method, route, operation: op }) => `| ${method.toUpperCase()} | \`${route}\` | ${escape(op.summary || op.operationId)} | ${escape(op['x-apinova-public'] ? '公开' : (op['x-apinova-permissions'] || []).join(', ') || '控制器/服务校验')} |`), '',
  ];
  const outputs = {
    'docs/api/openapi.json': JSON.stringify(document, null, 2) + '\n',
    'docs/api/ENDPOINTS.md': lines.join('\n'),
  };
  for (const [name, content] of Object.entries(outputs)) {
    const file = path.join(root, name);
    if (check && fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== content) {
      throw new Error(`Documentation drift: ${name}; rebuild and regenerate the API snapshot`);
    }
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  }
  // Exercise the manual's login/list/refresh examples without real credentials.
  app.use(require('express').json());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, errorHttpStatusCode: 422 }));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'docsadmin', password }),
  });
  assert.equal(login.status, 200);
  const tokens = await login.json();
  assert.ok(tokens.accessToken && tokens.refreshToken);
  assert.equal((await fetch(`${base}/api/v1/assets/source-services`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/assets/source-services`)).status, 401);
  assert.equal((await fetch(`${base}/api/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  })).status, 200);
  console.log(JSON.stringify({ mode: check ? 'check' : 'export', paths: Object.keys(document.paths).length,
    operations: entries.length, examples: 'login/list/anonymous-denial/refresh passed', database: 'isolated SQLite', listen: 'loopback ephemeral' }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close();
});
