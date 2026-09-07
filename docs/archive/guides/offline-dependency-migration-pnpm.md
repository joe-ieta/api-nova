> Archived on 2026-09-07. These pnpm instructions describe the source branch before its integration with the npm-based repository. They are retained as historical evidence and are not the current installation workflow.

---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-07
---
# 外网 → 内网 离线依赖库迁移（ApiNova）

> 适用场景：工程源码是从**外网开发机**拷贝进内网的，本机离线（无外网、无 npm 镜像），
> 且本机上一次拷贝得到的 `node_modules` 是**被修剪的残缺副本**（仅 464 个包、符号链接大量悬空，无法编译）。
> 本文件给出从外网机迁移**完整依赖库**、在本机离线 `pnpm install` 重建依赖、再编译发布的**可直接复制执行**的命令。

## 1. 两端环境事实（迁移前请先对照）

| 项 | 外网机（源） | 本机（目标） |
| --- | --- | --- |
| 工程根 | `E:\CodexDev\api-nova` | `E:\IETA\Java\api-nova`（仓库根 = monorepo 根，含 `packages/`、`scripts/`、`docs/`） |
| Windows 用户 | `IETA` | `ieta-48` |
| pnpm 内容店（依赖库本体） | `C:\Users\IETA\.pnpm-store\v10` | 由本文件第 3 步创建于 `C:\Users\ieta-48\.pnpm-store\v10` |
| pnpm 版本 | `10.33.0`（见 `node_modules\.modules.yaml` 的 `packageManager`） | 需从外网机拷贝（本机无 pnpm；`corepack` 拉 pnpm 需联网，离线不可用） |
| 转移介质 | 共享盘 / U 盘 / 网络路径（下文统一记作 `X:\`） | 同左 |

> **不要在本机找 `C:\Users\IETA\...`**：那是外网机用户目录，本机用户是 `ieta-48`。
> pnpm 的 `store-dir` 是本地配置，**搬内容 = 复制文件**，落到本机任何可写路径并让 `.npmrc` 指向即可。

## 2. 为什么搬"内容店"而不是搬 `node_modules`

pnpm 采用 `isolated` 链接模式：工作区每个包的 `node_modules` 里全是 **junction/符号链接**，指回
`node_modules\.pnpm\...`。直接整目录复制 `node_modules` 极易搬断链接（本机现有的残缺 copy 就是这么坏的）。
正确做法分两条：

- **主流（推荐、可复现）**：搬 **pnpm 内容店**（纯文件，无链接），再 `pnpm install --offline` 用锁文件完整重建 node_modules。
- **备选（快速、取已编译产物）**：整工程（含 `dist`）robocopy 到同一绝对路径临时使用；但 `dist` 若早于本机源码改动则不包含最新代码，且依赖任会搬坏，故建议仍走离线 install。

工程 `.npmrc` 已配置 `store-dir=~/.pnpm-store`（pnpm 展开为 `C:\Users\ieta-48\.pnpm-store`），因此把店落到该默认路径后**无需任何配置改动**。

---

## 3. 外网机（源）操作 —— 打包依赖库

在**外网机** PowerShell 中执行（把下面的 `X:\` 换成实际共享/U 盘路径）。
`robocopy` 退出码 `0~7` 为成功，`>=8` 为失败；本段每条命令后都做了退出码检查。

```powershell
# ---- 1) pnpm 内容店（依赖库本体）----
robocopy "C:\Users\IETA\.pnpm-store" "X:\pnpm-store" /E /MT:16 /R:1 /W:1 /NFL /NDL
if ($LASTEXITCODE -ge 8) { throw "robocopy(stage1) failed: $LASTEXITCODE" }

# ---- 2) pnpm 执行器（独立版；先定位再拷贝）----
where.exe pnpm     # 记录输出目录，如 C:\Users\IETA\AppData\Local\pnpm\pnpm.EXE
robocopy "$env:LOCALAPPDATA\pnpm" "X:\pnpm-cli" /E /R:1 /W:1 /NFL /NDL
if ($LASTEXITCODE -ge 8) { throw "robocopy(stage2) failed: $LASTEXITCODE" }

# ---- 3) npm 离线缓存（保险：UI 曾用 npm 装过，若后续缺件时回退用）----
robocopy "$env:LOCALAPPDATA\npm-cache" "X:\npm-cache" /E /MT:16 /R:1 /W:1 /NFL /NDL
if ($LASTEXITCODE -ge 8) { throw "robocopy(stage3) failed: $LASTEXITCODE" }

# ---- 4) 整工程（含已编译 dist；排除 node_modules/logs/db，避免搬断链接）----
robocopy "E:\CodexDev\api-nova" "X:\api-nova-full" /E /R:1 /W:1 /NFL /NDL /XD ".git" "node_modules" "logs" "pids" "data" /XF "*.db" "*.log" ".env" "*.pid"
if ($LASTEXITCODE -ge 8) { throw "robocopy(stage4) failed: $LASTEXITCODE" }
```

可选：确认整工程里的 `dist` 是否可读/完整，决定本机能否 `-SkipBuild` 直接打包：
```powershell
Test-Path "E:\CodexDev\api-nova\packages\api-nova-api\dist\src\main.js"
Test-Path "E:\CodexDev\api-nova\packages\api-nova-ui\dist\index.html"
```

---

## 4. 本机（目标）操作 —— 落地依赖并离线安装

在本机 PowerShell 中执行（`X:\` 为同一转移路径）。

```powershell
# ---- 1) 内容店落到本机默认 store-dir（= C:\Users\ieta-48\.pnpm-store，与 .npmrc 一致）----
robocopy "X:\pnpm-store" "C:\Users\ieta-48\.pnpm-store" /E /MT:16 /R:1 /W:1 /NFL /NDL
if ($LASTEXITCODE -ge 8) { throw "robocopy(dest1) failed: $LASTEXITCODE" }
Test-Path "C:\Users\ieta-48\.pnpm-store\v10"      # 应为 True

# ---- 2) pnpm 可用化（本机用户目录 + 写回用户 PATH，当前会话也生效）----
New-Item -ItemType Directory -Force "C:\Users\ieta-48\AppData\Local\pnpm" | Out-Null
robocopy "X:\pnpm-cli" "C:\Users\ieta-48\AppData\Local\pnpm" /E /R:1 /W:1 /NFL /NDL
if ($LASTEXITCODE -ge 8) { throw "robocopy(dest2) failed: $LASTEXITCODE" }
[Environment]::SetEnvironmentVariable("Path", "C:\Users\ieta-48\AppData\Local\pnpm;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
$env:Path = "C:\Users\ieta-48\AppData\Local\pnpm;" + $env:Path
pnpm -v                                          # 期望 10.33.0

# ---- 3) 离线重建依赖（只消耗本地内容店，不访问网络）----
cd E:\IETA\Java\api-nova
pnpm install --frozen-lockfile --offline
```

> 若你想用显式路径避开用户目录混淆（如 `E:\pnpm-store`）：第 1 步的落点改到该路径，
> 并在工程根 `.npmrc`（`E:\IETA\Java\api-nova\.npmrc`）里**追加**一行 `store-dir=E:/pnpm-store`（注意用正斜杠），其余不变。

---

## 5. 构建 + 发布（离线）

依赖重建成功后，编译并产出发布包（会包含最新源码与审查整改，建议**重跑构建**而非直接用旧 dist）：

```powershell
cd E:\IETA\Java\api-nova

# 构建 api / parser / server / ui
pnpm run build

# 标准 Portable 包（不含 node_modules，首启按需装 prod 依赖）→ 发布目录
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 -Mode Portable -OutputDir E:\IETA\Java\api-nova-release

# （可选）离线免安装包（含 prod node_modules，可选捆绑 node.exe，仅当前平台）
# powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 -Mode OfflineCurrentPlatform -IncludeNode -OutputDir E:\IETA\Java\api-nova-release-offline-win-x64
```

> 如确认外网整工程 `dist` 完整且不含本机私有改动，可用 `-SkipBuild` 跳过构建直接打包以提速。

---

## 6. 校验清单（务必执行）

```powershell
# 依赖完整性（关键：node_modules/.pnpm 数量应上千，而不是残缺副本的 464）
Test-Path "C:\Users\ieta-48\.pnpm-store\v10"
(Get-ChildItem "E:\IETA\Java\api-nova\node_modules\.pnpm" -Directory).Count
Test-Path "E:\IETA\Java\api-nova\packages\api-nova-ui\node_modules\vite"                   # True
Test-Path "E:\IETA\Java\api-nova\node_modules\.pnpm\typescript@*"                          # 至少一个 True
Test-Path "E:\IETA\Java\api-nova\node_modules\.pnpm\typeorm@*"                             # 至少一个 True

# 发布产物完整性
Test-Path "E:\IETA\Java\api-nova-release\packages\api-nova-api\dist\src\main.js"           # True
Test-Path "E:\IETA\Java\api-nova-release\public\index.html"                                # True(UI)
Test-Path "E:\IETA\Java\api-nova-release\start.bat"
```

---

## 7. 常见问题与排查

- **robocopy 提示"失败"？** 退出码 `0~7` 是成功（`1` 表示复制了文件），`8+` 才是失败；本文件命令已用
  `if ($LASTEXITCODE -ge 8)` 判断，仅真正失败才抛错。
- **不要用 `corepack pnpm`**：corepack 首次运行要去 registry 拉 pnpm，离线必失败；请用第 4 步放好的 `pnpm` 本体（PATH 里的 `pnpm.exe`）。
- **`--offline` 报"缺包"**：说明外网店内容店拷贝不完整，通常是 UI 中曾用 **npm** 安装的部分不在 pnpm 店里。
  处理：把第 3 步的 `X:\npm-cache` 放回 `C:\Users\ieta-48\AppData\Local\npm-cache`，
  再在 `packages\api-nova-ui` 下执行 `npm install --offline` 补齐后重试 `pnpm install --frozen-lockfile --offline`。
- **`node_modules\.pnpm` 数量仍是四百多**：店没搬全或落到错路径；回到第 4 步核对 `Test-Path ...\.pnpm-store\v10`，并确认 `.npmrc` 的 `store-dir` 指向该店。
- **直接复制 `node_modules`（资源管理器/普通复制）**：不推荐，junction 链接必然损坏；务必用"内容店 + 离线 install"。
- **只想把已编译的整工程当发布源**：用第 3 步 stage4 的 `X:\api-nova-full`（含 `dist`），配合 `-SkipBuild` 打包，但注意其 `dist` 可能早于本机源码改动。

## 8. 参考

- 发布包类型与 `package-release.ps1` 用法：`docs/release/api-nova-release-requirements.md`
- pnpm 离线安装官方说明：`pnpm install --offline` / `--prefer-offline`
