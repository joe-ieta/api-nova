---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-27
---
# Linux 容器平台验证证据（2026-09-27）

> Document status: Active evidence。Docker Desktop Linux 引擎（本地启动）上的两项环境验收：SEC-C2-01 与 OBS-14-05C3 的 Linux 部分。

## 1. 环境

- 宿主：win32 x64；Docker Desktop Linux 引擎（用户启动）
- 镜像：`node:24-alpine`（本地拉取；容器内 Node **v24.21.0**，musl）；Alpine `postgresql16` **16.15** + `postgresql16-contrib`
- 约束：验证期间 C 盘空间受限；仅拉取最小 Node 镜像，PG 数据目录使用 Docker 卷（ext4），运行后删除

## 2. SEC-C2-01 Linux Secret File 权限矩阵

- 方式：按[操作说明](../testing/upstream-secret-provider-linux.md)的加固参数运行（`--network none`、`--read-only`、`--cap-drop ALL`、`--pids-limit 64`、`--memory 256m`、`--cpus 1`、tmpfs 工作区）
- 结果：**83 项 = 82 通过 / 0 失败 / 1 按设计跳过**（跳过项为非 Linux/Windows 的“不支持平台”用例），退出码 0，与操作说明的预期计数一致
- 覆盖：多级相对 key、私有根与祖先可写性、目录代替文件、最终符号链接/根路径链接/硬链接、UTF-8/空/含 NUL/非法编码、字节上限与读中变更等
- 说明（流程偏差，建议回写操作说明）：单文件挂载 `secret-provider.js` 会因缺少同目录模块失败，实际改为只读挂载整个 `dist` 目录；另补 `/tmp` tmpfs 以保证 `--read-only` 下临时文件可写

## 3. OBS-14-05C3 Linux 多人写入与 PG 重启

- 脚本：`packages/api-nova-api/scripts/test-call-observability-payload-pg-multiwriter.cjs`（自建临时 PG 集群，禁止外部 DB/PGHOST）
- 结果：**9/9 通过**（Alpine PG 16.15）——四进程预算/幂等、四个实际 ingest 中断窗口、完整文件链并发、PG 重启重放守恒，与既有 Windows PostgreSQL 16.10 9/9 对齐
- 容器适配（不改脚本语义）：`postgresql16-contrib` 供 TypeORM 自建 `uuid-ossp`；创建 `/run/postgresql`（Alpine PG 默认 Unix socket 目录）；PG 数据目录落在 Docker 卷（Windows 绑定盘不支持 chmod，PG 拒绝）。工作区通过只读挂载 + `NODE_PATH=/repo/packages` 解决 pnpm/npm workspace junction 在容器内不可见的问题

## 4. 边界

- 仅 amd64 musl（Alpine）单架构，不等于 Ubuntu/glibc 或内核竞态全覆盖；未验证 PG 掉电、长期浸泡与生产部署。
- 容器运行使用 root 进入后再以非 root 用户执行测试（Docker 安全参数按操作说明）；未修改任何生产默认。
