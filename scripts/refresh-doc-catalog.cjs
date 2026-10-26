'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { root, filesInRepository } = require('./verify-docs.cjs');
const files = filesInRepository().filter(file => !file.startsWith('docs/archive/'));
const documents = files.map(file => {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const kind = file.includes('/templates/') ? 'template'
    : /^docs\/release\/versions\/v[^/]+\//.test(file) ? 'release-record'
      : file.endsWith('/CHANGELOG.md') ? 'package-history' : 'active';
  const title = text.match(/^#\s+(.+)$/m)?.[1] || file;
  const version = text.match(/^doc-version:\s*(\S+)/m)?.[1];
  const updated = text.match(/^doc-updated:\s*(\S+)/m)?.[1];
  if (kind === 'active' && (!version || !updated || !/^doc-status:\s*active\s*$/m.test(text))) throw new Error(`Missing current metadata: ${file}`);
  return { path: file, title, kind, ...(version ? { version, updated } : {}),
    catalogLink: path.relative('docs', file).replace(/\\/g, '/') };
});
documents.push({ path: 'docs/api/openapi.json', title: '管理API OpenAPI快照', kind: 'generated-asset', catalogLink: 'api/openapi.json' });
documents.sort((a, b) => a.path.localeCompare(b.path, 'en'));
const manifest = { schemaVersion: 1, reviewed: '2026-10-26',
  policy: 'One current entry per topic. Archive bodies retain historical metadata; archive path determines historical status. Published release records and package changelogs retain their bytes.',
  documents };
fs.writeFileSync(path.join(root, 'docs/documentation-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const old = fs.readFileSync(path.join(root, 'docs/VERSIONS.md'), 'utf8');
const header = old.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0];
if (!header) throw new Error('VERSIONS.md requires reviewed metadata before refreshing');
const active = documents.filter(entry => entry.kind === 'active');
const other = documents.filter(entry => entry.kind !== 'active');
fs.writeFileSync(path.join(root, 'docs/VERSIONS.md'), header.replace(/\r\n/g, '\n') + [
  '# 当前文档版本与类型清单', '',
  '本表穷举当前仓库文档；由 `node scripts/refresh-doc-catalog.cjs` 根据实际文件及元数据生成。阅读顺序见[文档中心](README.md)，机器清单见[documentation-manifest.json](documentation-manifest.json)。', '',
  '## 当前文档', '',
  '| 文档 | 版本 | 状态 | 更新时间 |', '| --- | --- | --- | --- |',
  ...active.map(entry => `| [${entry.title}](${entry.catalogLink}) | ${entry.version} | active | ${entry.updated} |`), '',
  '## 生成资产、模板与版本记录', '',
  '| 文件 | 类型 |', '| --- | --- |',
  ...other.map(entry => `| [${entry.path}](${entry.catalogLink}) | ${entry.kind} |`), '',
  '这些文件不套用普通手册版本号：OpenAPI快照随控制器生成；模板是待填内容；已发布版本说明和package CHANGELOG是不可原地改写的版本记录。它们不是当前任务状态入口。', '',
  '## 归档与维护规则', '',
  '- 历史材料穷举在[归档清单](archive/INDEX.md)，移动前后映射及原始摘要见[归档映射](archive/relocations-2026-10-26.json)。',
  '- 归档正文保留原日期及原front-matter；即使历史元数据写active，实际状态也由archive路径确定为archived，不覆盖当前手册。只修复引用，不重写历史结论。',
  '- 原批准合同归档不撤销其未完成退出条件；209项任务状态和245条依赖仍由统一台账/合同表维护。',
  '- 当前手册使用UTF-8和doc-version/doc-status/doc-updated。实质内容变化递增minor，结构/契约重大变化递增major，纯修正递增patch；相同主题仅保留一个权威入口。',
  '- 修改后刷新清单，执行 `node scripts/verify-docs.cjs`；控制器/DTO变化构建后生成并检查API快照。发布使用新的版本，不覆盖旧包或旧tag。', '',
].join('\n'));
console.log(JSON.stringify({ active: active.length, recordsAndAssets: other.length, manifest: documents.length }));
