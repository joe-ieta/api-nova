---
doc-version: 1.0.0
last-updated: 2026-09-14
status: active
---

# 上游凭证 Provider Linux 隔离专项

## 当前状态

这是待执行的操作说明，不是验收报告。Windows 本机 Provider 专项为 53 通过、0 失败、30 项真实 Linux 文件场景跳过。当前 Docker Linux 引擎没有运行；不会将 docker-desktop 内部 WSL 发行版当作通用 Linux 测试环境。

## 操作前提

1. 在本机启动 Docker Desktop 并使用 Linux containers。
2. 选择已经批准、已经在本地存在的 Node.js 20+ Linux 镜像。本流程不拉取镜像、不自动启动 Docker。
3. 使用本轮成功构建的 `packages/api-nova-parser/dist/credentials/secret-provider.js` 和 `packages/api-nova-parser/scripts/test-upstream-secret-provider.cjs`，不要替换为旧版本。
4. 不需要业务数据库、API/JWT 密钥、实际上游凭证或网络服务。

## PowerShell 执行

以下命令仅挂载两份指定文件为只读，关闭容器网络，根文件系统只读；合成测试文件位于容器内 owner-only 临时目录，容器退出后移除。不会递归删除或修改宿主目录。

```powershell
$ErrorActionPreference = 'Stop'
$repo = 'E:\CodexDev\api-nova'
$image = Read-Host '已批准且本地存在的 Node.js 20+ Linux 镜像'
if ($image -notmatch '^[A-Za-z0-9][A-Za-z0-9._/:@-]*$') {
  throw 'Invalid local image reference'
}
$platform = & docker image inspect --format '{{.Os}}' $image
if ($LASTEXITCODE -ne 0 -or ($platform -join '').Trim() -ne 'linux') {
  throw 'A running Docker Linux engine and an approved local Linux image are required'
}
$provider = (Resolve-Path -LiteralPath (Join-Path $repo 'packages/api-nova-parser/dist/credentials/secret-provider.js')).Path
$test = (Resolve-Path -LiteralPath (Join-Path $repo 'packages/api-nova-parser/scripts/test-upstream-secret-provider.cjs')).Path
$log = Join-Path $repo ('tmp/secret-provider-linux-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
$dockerArgs = @(
  'run', '--rm', '--pull=never',
  '--network', 'none', '--read-only',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '64', '--memory', '256m', '--cpus', '1',
  '--user', '0:0', '--env', 'HOME=/work',
  '--tmpfs', '/work:rw,nosuid,nodev,noexec,mode=700,size=32m',
  '--mount', "type=bind,source=$provider,target=/suite/dist/credentials/secret-provider.js,readonly",
  '--mount', "type=bind,source=$test,target=/suite/scripts/test-upstream-secret-provider.cjs,readonly",
  '--workdir', '/suite', '--entrypoint', 'node',
  $image, '--test', '/suite/scripts/test-upstream-secret-provider.cjs'
)
& docker @dockerArgs 2>&1 | Tee-Object -FilePath $log
$exit = $LASTEXITCODE
if ($exit -ne 0) { throw "Provider Linux tests failed with exit code $exit; retain $log" }
```

## 结果登记

- 记录实际镜像标识、Node 版本、退出码及完整日志。
- 当前脚本的预期计数为 82 通过、1 项“不支持平台”测试跳过；这是预期，不是已经取得的结果。任何失败都必须保留，不能通过放松权限或跳过断言来凑齐数量。
- 真实文件专项覆盖多级相对 key、目录权限、祖先目录可写性、普通文件/链接、UTF-8、大小与读取期间变更等已写入的场景。
- 即便此脚本通过，也不等同于完整跨平台、安全文件系统或不同 UID/所有内核竞争条件的验收；Windows ACL 适配、Registry Watch/审计及 C4 Resolver 仍另行推进。
- 本说明中的 Docker 命令尚未实际执行。若没有可用镜像或 Linux 引擎，请先提供环境，不需要提供任何真实秘密。
