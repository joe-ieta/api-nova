---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-27
---
# SEC-E1-03 真实 child 受管执行闭环矩阵证据（2026-09-27）

> Document status: Active evidence。真实构建产物 `managed/entry.js` 子进程；合成秘密与回环上游；默认关闭、未启用可信模式。

## 1. 环境与执行

- 执行器：`npm run verify:e1-03 --workspace api-nova-api`（`scripts/verify-e1-03.cjs`），标记 `E1_03_VERIFY_OK`
- 环境：win32 x64，Node v24.15.0；运行前自动构建 API/Parser/Server 并拒绝陈旧 `dist`；TEMP 规范化为真实大小写
- 结果：聚合既有真实 child 证据 **77/77**（channel 15、preparation 32、managed-runtime 14、e1-02c1 6、e1-02c2 10）+ 新增 **10 场景 / 31 项检查**；全量 API jest **154 suites / 1678 tests**；API/Parser/Server 构建与 type-check 通过；Linux 容器（`node:24-alpine`）spawn/IPC/READY/auth/cleanup **4 项**

## 2. 矩阵 1–13 映射

| # | 场景 | 证据 |
| --- | --- | --- |
| 1 | API Key/Bearer 正常 | N1：真实 READY，继承 bearer/覆盖 apiKey，消费者值不出现 |
| 2 | None + 父 Axios/legacy/env 污染 | N1：零上游认证；声明业务头通过、凭据头剥离 |
| 3 | 缺/重复/跨资产绑定、伪造 x-* | N1/N2/N9：预 READY 拒绝零发送；工具参数不能替换身份 |
| 4 | 准备后 Registry 变更 | N3：陈旧拒绝；重新准备仅绑定 r2 |
| 5 | OpenAPI/指纹不匹配 | N4：`MANAGED_RUNTIME_FAILED`、零发送、无监听 |
| 6 | 无 IPC/重复包/错版本/超限 | N5：固定码、无 swagger/远程回退、无残留进程 |
| 7 | 多会话/两 runtime 同 OpenAPI | N6：各自闭包、digest 隔离、无跨准备缓存复用 |
| 8 | 302 到另一目标 | N1：第二目标零请求、无秘密/正文重放 |
| 9 | bootstrap 失败/超时 | N8：无 current/无进程；拒绝切换保留既有已验证实例 |
| 10 | 自动重启/恢复/父断开 | N7：父 IPC 断开 → 退出并释放端口 |
| 11 | argv/日志/异常/审计扫描 | N7 实际 spawn argv/env；N8 argv/env/stdout/stderr/store/status/raw row/error 合成秘密扫描 |
| 12 | 入站认证环境裁剪 | N9：不继承 ambient JWT/JWKS/`JWT_SECRET`/`NODE_OPTIONS`；401/401/200 与逐请求工具授权；legacy CLI 4/4 独立 |
| 13 | Windows/Linux | N7 Windows 参数/argv；N10 Linux 容器 4 项；File Provider 权限归 C2-01/02 |

## 3. 未覆盖（`notCovered`）

- 真实 30s 握手超时等待（真实 bootstrap 失败已执行，计时器由既有通道沙箱覆盖）。
- 受管 JWT/anonymous（受管运行时仅 `private_api_key`；ambient JWT 裁剪与 legacy 已经覆盖）。
- ProcessInfo 序列化（受管路径不经 ProcessManager，改为扫描 argv/env/store/status/log/error）。
- File Provider ACL/权限证据（设计上归 C2-01/C2-02）。
- Linux 为有界容器检查（4 项），非全 13 行 Linux 矩阵；Windows 为主平台。
