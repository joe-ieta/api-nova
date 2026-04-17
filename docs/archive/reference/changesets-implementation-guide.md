# ApiNova - Changesets 实施指南

## 项目概述

本项目是一个基于 pnpm workspace 的 monorepo 架构，包含以下可发布的包：

- `api-nova-server` - 主服务包 (v1.0.9)
- `api-nova-parser` - 解析器包 (v1.0.5)
- `api-nova-api` - API 服务包 (私有，不发布)

## 当前状态分析

### 现有配置
- **包管理器**: pnpm (workspace 模式)
- **TypeScript**: 项目引用 (composite 模式)
- **发布方式**: 手动 `pnpm pack` 命令
- **版本管理**: 手动更新版本号

### 问题识别
1. 版本管理繁琐，容易出错
2. 缺乏自动化的 CHANGELOG 生成
3. 多包发布缺乏协调机制
4. 发布流程不规范

## Changesets 集成方案

### 第一步：安装依赖

```bash
# 安装 Changesets
pnpm add -D @changesets/cli @changesets/changelog-github

# 初始化 Changesets
pnpm changeset init
```

### 第二步：配置文件

#### 1. .changeset/config.json
```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/changelog-github",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": ["api-nova-api"],
  "privatePackages": {
    "version": true,
    "tag": false
  }
}
```

**配置说明**：
- `changelog`: 使用 GitHub 风格的 changelog
- `ignore`: 忽略私有的 API 包
- `access`: 公开发布
- `updateInternalDependencies`: 内部依赖更新策略

#### 2. 根目录 package.json 脚本更新
```json
{
  "scripts": {
    "build": "node scripts/build.js",
    "build:packages": "node scripts/build.js --non-ui",
    "prepack": "node scripts/build.js",
    "pack": "pnpm build && changeset publish --dry-run",
    "changeset": "changeset",
    "changeset:version": "changeset version",
    "changeset:publish": "changeset publish",
    "changeset:status": "changeset status",
    "version-packages": "changeset version && pnpm install --lockfile-only",
    "release": "pnpm build && changeset publish",
    "release:dry": "pnpm build && changeset publish --dry-run"
  }
}
```

### 第三步：.pnpmrc 文件需求分析

**是否需要 .pnpmrc 文件？**

根据你的项目情况，**建议创建 .pnpmrc 文件**，原因如下：

1. **发布配置统一管理**
2. **workspace 行为优化**
3. **依赖提升控制**
4. **构建性能优化**

#### 推荐的 .pnpmrc 配置
```ini
# 启用 workspace 协议
prefer-workspace-packages=true

# 避免依赖提升问题
hoist-pattern[]=*eslint*
hoist-pattern[]=*prettier*
hoist-pattern[]=*typescript*

# 发布配置
publish-branch=main
access=public

# 性能优化
store-dir=~/.pnpm-store
verify-store-integrity=true

# 严格模式
strict-peer-dependencies=false
auto-install-peers=true

# 构建缓存
enable-pre-post-scripts=true
```

### 第四步：包配置优化

#### api-nova-server/package.json
```json
{
  "name": "api-nova-server",
  "version": "1.0.9",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "files": [
    "dist/**/*",
    "README.md",
    "CHANGELOG.md",
    "LICENSE"
  ]
}
```

#### api-nova-parser/package.json
```json
{
  "name": "api-nova-parser", 
  "version": "1.0.5",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "files": [
    "dist/**/*",
    "README.md", 
    "CHANGELOG.md",
    "LICENSE"
  ]
}
```

### 第五步：工作流程

#### 开发者工作流
1. **开发功能**
   ```bash
   git checkout -b feature/new-feature
   # 开发代码...
   ```

2. **创建变更集**
   ```bash
   pnpm changeset
   ```
   
   选择选项：
   - 选择要更新的包: `api-nova-server`, `api-nova-parser`
   - 选择版本类型: `patch`, `minor`, `major`
   - 输入描述: "Add new feature for XXX"

3. **提交代码**
   ```bash
   git add .
   git commit -m "feat: add new feature"
   git push origin feature/new-feature
   ```

#### 维护者发布流程
1. **更新版本**
   ```bash
   pnpm changeset version
   ```

2. **安装依赖**
   ```bash
   pnpm install
   ```

3. **构建项目**
   ```bash
   pnpm build
   ```

4. **发布包**
   ```bash
   # 试运行（推荐）
   pnpm release:dry
   
   # 正式发布
   pnpm release
   ```

## GitHub Actions 集成

### .github/workflows/release.yml
```yaml
name: Release

on:
  push:
    branches:
      - main

concurrency: ${{ github.workflow }}-${{ github.ref }}

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Setup pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 8
          run_install: false

      - name: Get pnpm store directory
        shell: bash
        run: |
          echo "STORE_PATH=$(pnpm store path --silent)" >> $GITHUB_ENV

      - name: Setup pnpm cache
        uses: actions/cache@v3
        with:
          path: ${{ env.STORE_PATH }}
          key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            ${{ runner.os }}-pnpm-store-

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build packages
        run: pnpm build

      - name: Create Release Pull Request or Publish to npm
        id: changesets
        uses: changesets/action@v1
        with:
          publish: pnpm release
          commit: "chore: release packages"
          title: "chore: release packages"
          createGithubReleases: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### .github/workflows/changeset-check.yml
```yaml
name: Changeset Check

on:
  pull_request:
    branches:
      - main

jobs:
  changeset-check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Setup pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 8
          run_install: false

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Check for changeset
        run: |
          if [ -z "$(pnpm changeset status --output=json | jq -r '.releases[] | select(.name != "api-nova-api")')" ]; then
            echo "::error::No changeset found. Please run 'pnpm changeset' to create one."
            exit 1
          fi
```

## 实施步骤

### 准备阶段
1. 创建 `.pnpmrc` 文件
2. 安装 Changesets 依赖
3. 初始化配置文件
4. 更新 package.json 脚本

### 测试阶段
1. 创建测试分支
2. 模拟变更集创建
3. 验证版本更新
4. 测试发布流程

### 部署阶段
1. 配置 GitHub Actions
2. 设置 NPM_TOKEN
3. 正式启用流程
4. 团队培训

## 迁移脚本

```bash
#!/bin/bash
# migration.sh - Changesets 迁移脚本

echo "🚀 开始 Changesets 迁移..."

# 1. 创建 .pnpmrc 文件
echo "📝 创建 .pnpmrc 文件..."
cat > .pnpmrc << 'EOF'
prefer-workspace-packages=true
hoist-pattern[]=*eslint*
hoist-pattern[]=*prettier*
hoist-pattern[]=*typescript*
publish-branch=main
access=public
store-dir=~/.pnpm-store
verify-store-integrity=true
strict-peer-dependencies=false
auto-install-peers=true
enable-pre-post-scripts=true
EOF

# 2. 安装 Changesets
echo "📦 安装 Changesets..."
pnpm add -D @changesets/cli @changesets/changelog-github

# 3. 初始化 Changesets
echo "⚙️ 初始化 Changesets..."
pnpm changeset init

# 4. 创建 GitHub Actions 目录
echo "🔄 创建 GitHub Actions..."
mkdir -p .github/workflows

echo "✅ 迁移完成！请手动完成以下步骤："
echo "1. 更新 package.json 脚本"
echo "2. 配置 .changeset/config.json"
echo "3. 创建 GitHub Actions 工作流"
echo "4. 设置 NPM_TOKEN 密钥"
```

## 最佳实践

### 变更集编写规范
```markdown
# 好的变更集示例

---
"api-nova-server": minor
"api-nova-parser": patch
---

Add support for OpenAPI 3.1 specifications

This change adds full support for OpenAPI 3.1 specifications including:
- New schema validation rules
- Enhanced error reporting
- Better type inference

Breaking changes: None
```

### 版本发布策略
- **patch**: bug 修复，安全补丁
- **minor**: 新功能，向后兼容
- **major**: 破坏性变更，API 变更

### 发布检查清单
- [ ] 所有测试通过
- [ ] 文档已更新
- [ ] CHANGELOG 生成正确
- [ ] 版本号符合语义化版本规范
- [ ] 依赖关系正确更新

## 常见问题

### Q: 如何处理内部依赖？
A: Changesets 会自动处理内部依赖更新，配置 `updateInternalDependencies: "patch"` 即可。

### Q: 如何跳过某些包的发布？
A: 在 `config.json` 中配置 `ignore` 数组。

### Q: 如何处理预发布版本？
A: 使用 `pnpm changeset pre enter alpha` 进入预发布模式。

## 总结

通过集成 Changesets，你的项目将获得：
- 自动化的版本管理
- 规范化的发布流程
- 完整的变更记录
- 更好的团队协作

建议按照上述步骤逐步实施，确保每个环节都经过充分测试。
