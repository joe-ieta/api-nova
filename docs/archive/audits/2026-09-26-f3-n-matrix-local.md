---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-26
---
# SEC-F3-02D 本地 N01–N17 真实连接矩阵（2026-09-26）

> Document status: Active evidence。本地 Windows 隔离回环 DNS/HTTP/TLS/代理；不含生产默认启用、跨平台或公网结论。

## 1. 环境与执行

- 执行器：`scripts/verify-f3-n-matrix.cjs`（`npm run verify:f3-n-matrix`）；标记 `F3_N_MATRIX_OK`
- 环境：commit `a9efdc5`，win32 x64，Node v24.15.0；受控 UDP DNS + HTTP/HTTPS（临时 CA）+ TCP 代理陷阱，全部回环
- 结果：parser 真实网络 **17 套件 / 573 例全通过**；gateway 网络流 **84 例全通过**；N01–N17 每项必需用例均已出现且通过

## 2. 逐项覆盖

| 条款 | 关键证据 |
| --- | --- |
| N01 | gateway 302 单次请求/单连接不跟随（隔离 HTTP）；hop=0 |
| N02 | safe-read 五跳分连接、第六跳拒绝；legacy 未配置分支单跳 |
| N03 | 真实 HTTP/TLS 忽略 Axios ambient 凭据；证书失败零 HTTP 字节；字面 pin |
| N04 | 相对 Location 按真实 method/path 解析并重选 Site |
| N05 | 同 asset 跨 origin 授权重授权；None 剥离历史 Endpoint 凭据 |
| N06 | 缺失/重复/循环/未知/外来 Location 零下一跳；HTTPS 降级拒绝 |
| N07 | safe-read 真实跟随剥离凭据；HEAD 保持；伪造 proof 零发送 |
| N08 | 空/NXDOMAIN/SERVFAIL 逐地址 closed；例外过期即拒 |
| N09 | 下一跳 DNS 变化按 rebinding 拒绝且零 HTTP |
| N10 | 静默 DNS 5 秒上限；预中止/超期零 DNS 包 |
| N11 | A/AAAA 混合与 CNAME 私网整组拒绝；CNAME 终址授权 |
| N12 | 完整 A/AAAA 授权零目标连接；单跳 rebinding 不可达另一 peer |
| N13 | 限期精确例外；CIDR 规范化；始终拒绝集合 |
| N14 | 显式模式忽略代理环境、代理陷阱零连接；v1 拒绝 `connection:"proxy"` 与外部 transport |
| N15 | 303 保持 GET/HEAD；POST/带体单跳且原体返回；无隐式重放 |
| N16 | 普通 reload 固定版本；撤销世代变化终止；每新连接重验 |
| N17 | 有/无 context 安全结果一致；观测失败不放宽政策；被拒跳不伪造发送 |

## 3. 边界

- 生产默认启用与管理配置、Linux/macOS 平台矩阵、真实公网 DNS/TLS 与外部接收方、长时浸泡/对抗负载仍为环境验收项。
- 观测失败（sink 不可用等）按用例要求不影响拒绝决策；本矩阵不替代全量 F3 Scan。
