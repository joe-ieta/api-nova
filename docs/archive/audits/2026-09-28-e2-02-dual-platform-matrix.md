---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# SEC-E2-02 双平台稳定性误差矩阵证据（2026-09-28）

> Document status: Active evidence。同一提交在 Windows 与 Linux 容器复跑 E2-01 矩阵；0 结果差异。

## 1. 环境与执行

- 执行器：`npm run verify:e2-02`（根 `scripts/verify-e2-02.cjs`），标记 `E2_02_VERIFY_OK`，exit 0
- 平台：Windows win32 Node v24.15.0；Linux `node:24-alpine`（容器 Node **v24.21.0**/musl，Docker 29.5.3，仅用本地镜像不拉取，`--network none`）
- 结果：**17 行映射，双平台各 12 套件/153 测试 + 5 场景/19 检查，retries=0，0 结果差异**

## 2. 对比结论

- E0-01 adapter、B3-02 SDK 会话、传输/HTTP 观测、HTTP/SSE 投递、stdio 观测、B3-01 撤销、managed channel/runtime、C1/C2、publication endpoints 及 N1–N5 全部一致通过。
- N4 时序：Windows 30064ms vs Linux 30077ms（均命中 30s 握手超时绑定）。
- 容器配方（可复现）：canonical 只读挂载 + `tar` 工作副本到 `tmpfs(exec)` + `NODE_PATH` 工作区解析 + `--network none`；tmpfs 默认 `noexec` 会阻断 bcrypt musl prebuild（EPERM），需显式 `exec`。

## 3. 已记录差异与边界

- 差异：Node 补丁版本/musl（v24.15.0 vs v24.21.0，同 24.x 线，仅本地已有镜像）；容器内路径/时序夹具差异已在配方层解决；b3-01 耐久审计落盘 vs force-stop 竞态为已知间歇（Windows 6 次中 1 次；独立运行 3/3），采用**记录首证 + 至多一次同平台重跑**的稳定策略，最终 retries=0。
- `notCovered`：glibc/Ubuntu/Debian/macOS、部署/打包、长时浸泡与内核竞态、外网 DNS/TLS/代理、jest 包单测与 UI、Windows ACL（C2-02）、裸机内核。
