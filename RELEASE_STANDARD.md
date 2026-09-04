# ApiNova 版本发布规范

> 文档状态：Active，项目发布唯一规范
> 生效范围：本规范合入后创建的新版本
> 最后复核：2026-09-04

## 1. 目的与效力

本文件是 ApiNova 产品版本发布的唯一事实来源，统一规定版本身份、三平台产物、归档目录、最新运行目录、发布文档、验证门禁和对外发布事务。

如果其他文档、技能、脚本示例或历史发布方式与本规范冲突，以本文件为准。改变发布契约时，应先修改本文件，再同步脚本和技能。

规范目标：

- 一个产品标签对应一套不可变的三平台发布物；
- 每个正式产物完全离线，解压后可直接运行；
- 历史版本只追加留存，不静默覆盖；
- `api-nova-release` 始终保存同一最新版本的三个运行目录；
- 每个版本携带发布说明和快速运行手册；
- 缺少任一平台时，不得宣称为完整版本。

## 2. 版本身份

Git 标签是产品版本号的唯一来源。

- 正式版：`vMAJOR.MINOR.PATCH`，例如 `v1.8.0`；
- 预发布版：`vMAJOR.MINOR.PATCH-rc.N`，例如 `v1.7.5-rc.1`。

同一版本的三个平台产物必须来自完全相同的 Git commit，并在包内元数据和版本清单中记录完整 SHA。

`packages/<name>/package.json` 中的版本只用于 npm 包发布，不替代产品 Git 标签。

产物一旦归档或上传，不得在同一标签下替换文件。源代码、依赖、打包内容或运行说明发生实质变化时，必须创建新的 `rc.N` 或补丁版本。

## 3. 强制三平台产物

每个正式版本必须同时提供：

| 平台标识 | 目标系统 | Node 标识 | 归档格式 | 原生构建环境 |
| --- | --- | --- | --- | --- |
| `win-x64` | Windows x64 | `win32-x64` | `.zip` | Windows x64 |
| `linux-x64` | Linux AMD64/x86_64 | `linux-x64` | `.tar.gz` | Ubuntu x64 |
| `linux-arm64` | Linux ARM64/aarch64 | `linux-arm64` | `.tar.gz` | Ubuntu ARM64 或等效原生 ARM64 环境 |

Linux 默认兼容基线为 Ubuntu 22.04 LTS，变更时必须写入发布说明。

固定文件名：

```text
api-nova-release-<tag>-win-x64.zip
api-nova-release-<tag>-linux-x64.tar.gz
api-nova-release-<tag>-linux-arm64.tar.gz
```

例如：

```text
api-nova-release-v1.7.5-rc.1-win-x64.zip
api-nova-release-v1.7.5-rc.1-linux-x64.tar.gz
api-nova-release-v1.7.5-rc.1-linux-arm64.tar.gz
```

Linux AMD64 在发布文件名中统一为 `linux-x64`。禁止混用 `amd64`、`x86_64` 和 `x64`。

`bcrypt` 等原生依赖与操作系统和 CPU 相关，禁止跨平台复制 `node_modules` 或 Node 可执行文件。Windows 构建不能作为 Linux 产物的验证证据。

## 4. 发布目录

### 4.1 不可变版本归档

Windows 默认归档根目录：

```text
E:\CodexDev\api-nova-release-archive
```

Linux 可使用 `/opt/api-nova-release-archive` 或明确配置的其他存储目录。

```text
api-nova-release-archive/
└── <tag>/
    ├── RELEASE_NOTES.md
    ├── QUICK_START.md
    ├── RELEASE_MANIFEST.json
    ├── SHA256SUMS.txt
    ├── api-nova-release-<tag>-win-x64.zip
    ├── api-nova-release-<tag>-linux-x64.tar.gz
    └── api-nova-release-<tag>-linux-arm64.tar.gz
```

七个文件齐全且三个归档校验通过后，版本归档才算完整。归档目录只允许追加，禁止覆盖或删除已有版本。

### 4.2 最新三个运行目录

固定最新目录：

```text
E:\CodexDev\api-nova-release
```

```text
api-nova-release/
├── CURRENT_RELEASE.json
├── win-x64/
├── linux-x64/
└── linux-arm64/
```

三个目录的 `RELEASE_INFO.json` 必须记录同一标签和 commit，禁止混合版本。

`api-nova-release` 是可替换的最新分发镜像，不是历史归档或生产数据目录。在其中运行产生的 `data/`、`logs/`、`pids/` 在晋升新版本时视为可丢弃数据；需要保留时必须先备份到目录外。

最新版本必须原子晋升：

1. 三个平台归档全部验证通过；
2. 解压到带版本号的临时目录并分别验证；
3. 停止旧运行进程；
4. 同一次操作替换三个平台目录；
5. 最后写入 `CURRENT_RELEASE.json`。

任一平台失败时，现有最新目录保持不变。

### 4.3 构建暂存目录

构建和解压验证使用独立目录，例如：

```text
E:\CodexDev\api-nova-release-staging/<tag>/<platform-id>/
```

禁止把 `api-nova-release` 直接作为打包脚本 `OutputDir`。打包脚本会重建输出目录，可能删除运行数据。

## 5. 解压目录契约

每个归档只包含一个顶层目录：

```text
api-nova-release-<tag>-<platform-id>/
```

必须包含：

```text
api-nova-release-<tag>-<platform-id>/
├── .env
├── .api-nova-runtime-platform
├── QUICK_START.md
├── RELEASE_NOTES.md
├── RELEASE_INFO.json
├── README_PROJECT.md
├── start.bat
├── start.sh
├── package.json
├── package-lock.json
├── node_modules/
├── packages/
├── public/
├── runtime/node/
├── data/
├── logs/
└── pids/
```

强制要求：

- 包含生产依赖和目标平台 Node，首次启动不得下载或调用包管理器；
- `data/`、`logs/`、`pids/` 在归档内必须为空；
- 不包含 `.git`、缓存、测试数据库、测试日志、PID 或真实凭据；
- `.env` 只能含公开的本地测试默认值；
- Windows 入口为 `start.bat`；
- Linux 入口为 `./start.sh`，并保留可执行权限；
- Linux 的 `runtime/node/bin/node` 也必须可执行；
- 默认 UI 为 `http://127.0.0.1:9001/`；
- 启动健康地址为 `http://127.0.0.1:9001/api/health/live`；
- 运行文件只能写入解压目录内部。

Windows npm workspace Junction 必须在 ZIP 中展开为普通目录，或证明普通用户无需管理员权限即可解压运行。Linux `.tar.gz` 必须保留 Unix 权限和链接。

## 6. 每版本文档

创建标签前必须在仓库生成并提交：

```text
docs/release/versions/<tag>/
├── RELEASE_NOTES.md
└── QUICK_START.md
```

模板位置：

- `docs/release/templates/RELEASE_NOTES.template.md`
- `docs/release/templates/QUICK_START.template.md`
- `docs/release/templates/RELEASE_INFO.template.json`
- `docs/release/templates/RELEASE_MANIFEST.template.json`
- `docs/release/templates/CURRENT_RELEASE.template.json`

最终发布说明和快速手册复制到版本归档目录及三个平台包内。

### 6.1 发布说明

`RELEASE_NOTES.md` 至少记录：

- 版本、commit、状态和日期；
- 核心变化与已修复问题；
- API、UI、运行时、配置和安全影响；
- 数据兼容或迁移策略；
- 已知限制及未完成外部验收；
- 三个平台验证证据；
- 升级和回退说明。

Git commit SHA 会形成文档自引用，无法在被该 SHA 覆盖的提交中预先写入自身哈希。因此仓库中的版本文档使用 @GIT_COMMIT@ 占位符；构建器必须以实际发布提交替换占位符，进入三个平台包、版本归档和远端 Release 的最终副本不得保留占位符。

未在真实平台验证的能力不得声明为已支持。

### 6.2 快速运行手册

`QUICK_START.md` 面向使用者，不写构建细节，几分钟内可读完，至少包含：

- 版本和平台；
- 解压及一条启动命令；
- 默认访问地址和健康地址；
- 默认测试账号及修改凭据提醒；
- 配置、数据和日志位置；
- 停止方式；
- 简短故障排查。

## 7. 结构化元数据

每个平台包内的 `RELEASE_INFO.json` 至少记录：

- 产品名、产品标签、完整 commit SHA；
- 平台标识、操作系统和 CPU；
- `offline` 包模式；
- Node 和 npm 精确版本；
- UTC 构建时间；
- `package-lock.json` SHA-256；
- 发布说明和快速手册文件名。

版本归档中的 `RELEASE_MANIFEST.json` 记录同一标签和 commit，以及三个归档的文件名、大小和 SHA-256。

最新目录中的 `CURRENT_RELEASE.json` 记录当前标签、commit、晋升时间和三个平台。只在三个目录全部晋升成功后写入。

## 8. 构建门禁

构建前：

1. 从 `main` 构建，除非明确批准发布分支；
2. 拉取远端标签并确认目标标签不存在；
3. 确认工作区干净且与远端提交同步；
4. 创建并复核版本文档；
5. 使用已提交的 lockfile 执行 `npm ci`；
6. 三个平台使用相同的 Node 精确版本。

仓库发布门禁：

```bash
npm run verify:package-manager
npm run verify:runtime-closure
npm run test
npm run type-check
npm run lint
npm run build
```

本规范生效后的版本必须全部通过。Lint 以命令退出码为 0 且 0 error 为通过；warning 技术债必须可见并逐步收敛，不能从发布证据中静默省略。

每个平台在目标原生环境执行：

```powershell
pwsh ./scripts/package-release.ps1 \
  -Mode OfflineCurrentPlatform \
  -OutputDir <staging-package-directory> \
  -IncludeNode
```

构建器必须断言实际 `process.platform-process.arch` 与请求平台一致，不一致立即失败。

旧 `Portable` 模式仅用于开发传递，因首次运行可能联网，不属于正式版本产物。

## 9. 单包验证

暂存目录和最终归档的新解压副本都必须验证：

1. 核对平台标记和内置 Node；
2. 加载运行依赖和原生模块；
3. 确认启动不安装或下载依赖；
4. 使用包内 Node 启动；
5. `/api/health/live` 返回 HTTP `200`；
6. `/` 返回构建 UI；
7. `/api/system/initialization` 返回 HTTP `200`；
8. 停止后无遗留 PID；
9. 归档前清除测试数据库、日志、PID 和临时文件；
10. 在断网或阻断网络的环境，从最终归档新解压副本重复启动验证。

Linux 必须在匹配架构上运行验证，跨平台文件检查不能替代执行。

归档固定后生成 SHA-256。`SHA256SUMS.txt` 必须包含三个归档，并在晋升 latest 和外部上传前重新校验。

## 10. 完整发布事务

以下条件全部满足才算发布完成：

1. 版本文档已提交；
2. 仓库门禁全部通过；
3. 三个平台均通过归档解压后的离线运行验证；
4. Manifest 和校验文件完整；
5. 不可变版本归档完整；
6. 最新三个运行目录晋升到同一标签；
7. 注释 Git 标签指向准确提交；
8. 远端 Release 包含相同的三个归档、说明、清单和校验文件。

禁止在正式标签下发布单平台或双平台版本。任一平台不可构建时，版本保留在 staging 并报告阻塞。

创建或推送标签、上传文件属于外部变更，执行前必须获得授权。上传公开仓库前必须检查凭据，并披露测试默认账号或密钥。

## 11. 回退与留存

- 禁止原地重建旧标签；
- 已发布版本目录和校验文件长期留存；
- 回退时选择完整历史版本，先验校验和，再解压三个 latest 目录，最后更新 `CURRENT_RELEASE.json`；
- latest 不承诺数据迁移，版本特定数据策略写入 `RELEASE_NOTES.md`。

## 12. 现有目录迁移

本规范之前，`E:\CodexDev\api-nova-release` 是平铺的 Windows 运行目录，并可能包含 `data/api-nova.db`，不得自动删除或改造。

首次迁移必须：

1. 停止旧目录进程；
2. 明确丢弃还是备份运行数据；
3. 获得用户授权后才移动或归档旧目录；
4. 创建 `win-x64`、`linux-x64`、`linux-arm64` 结构；
5. 一次性晋升完整三平台版本。

`v1.7.5-rc.1` 及以前属于过渡版本，不追溯要求满足新结构。禁止移动已推送标签来伪装历史版本合规。
