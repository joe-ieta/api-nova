---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-20
---
# 统一任务迁移与 Gateway 启动隔离验收

本轮完成NP-00规划校准及NP-10早期启动隔离。基线为 `2f49534`（`v1.7.5-rc.2`）；结果仅覆盖本地代码和隔离验收，不代表网络模式生产启用、完整安全发布或目标部署签收。

## 任务迁移与范围决定

- 原执行台账209行：150条限定DONE保留在BASE-150；其余59条逐项唯一归入31个NP工作包。父包、Phase、WP、DEV、OBS/SEC视图不重复累计。
- 新包合同定义优先级、依赖、旧任务来源和验收出口；新状态页为唯一调度台账。旧台账保留原路径和证据，标为被替代的历史记录，不继续维护“当前状态”。
- 原父包D1已在后续H11B证据中完成；D2两条叶子已DONE，旧摘要仍写等待B2/D1。按现有依赖与原功能出口消除过期等待，不添加多节点QoS要求。最终候选联合复验归NP-53。
- A4的69表/4迁移为旧时点证据，不能替代后续模型的候选数据库门禁；最终基线检查归NP-53。
- PROD-06范围审核结论：原[WP70合同](../plans/2026-10-26/runtime-instance-and-regression-closure-plan.md)已列候选隔离、内存激活/回滚、原子MCP持久化及fingerprint为完成项；“完整CAS”未形成新的批准出口。本轮不新增笼统CAS开发包，也不声称所有跨进程CAS已验收。新发布与撤销路径仍按NP-22/30～33的明确一致性合同测试。
- C4/E1/F1父包交叉依赖改用叶子DAG调度：MCP启动先行，最终双运行时联合验收归NP-33。邮件/OAuth/QoS继续单独延期。

原始来源：[冻结子任务](../../guides/active-work-package-execution-status.md)、[原工作包合同](../../guides/active-work-package-breakdown.md)、[安全父包证据](../plans/2026-10-26/security-development-execution-status.md)、[OBS复核](../plans/2026-10-26/runtime-observability-completion-review.md)。新合同见[统一工作包](../plans/main-2026-10-20/unified-work-packages.md)。

## NP-10 实现与边界

共享异步 `GatewayNetworkBootstrap` 在旧Registry工厂加载文件或安装watch之前决定模式。缺少host attestation保持默认关闭；显式坏token、旧配置冲突或host启动失败均闭锁Gateway，不回落旧Registry。有效host通过已有品牌Registry与真实PostgreSQL提供只读Snapshot给PolicyService；撤销或关闭后拒绝读取。

Runtime两个转发入口及Proxy准备/发送入口在查询、授权、缓存和Resolver前检查闭锁。非Gateway接口可继续服务，旧凭据admin在host模式禁用。常量拆至独立config模块，旧导出保持兼容，避免启动工厂与host模块循环依赖。Nest销毁时幂等关闭host/issuer。

此包故意不开放host流量；committed route后的facade/proof装配归NP-11，生命周期与在途终止归NP-12。无HTTP/env/file适配器能生成host token，未新增生产开关，未改变SQL.js host boot拒绝策略。

## 验证结果

| 检查 | 最终结果 | 范围 |
| --- | --- | --- |
| `node scripts/verify-unified-work-plan.cjs` | PASS，209/150/59/31，DAG无环 | 只验证任务完整映射和调度结构 |
| Parser、Server、API依赖顺序构建 | PASS，三个命令各退出0 | 不包含UI或全API测试 |
| Gateway完整目录 | 50 suites / 724 tests，全部PASS，退出0 | 新增bootstrap 13项包含真实Nest HTTP失败闭锁；既有49套回归保留 |
| 隔离PostgreSQL16 | warm 61组 + cold 4组，退出0 | 本包新增8组；有效host的Nest/HTTP健康200、Gateway503、撤销、Snapshot、旧Registry隔离及关闭 |
| PG生命周期 | zeroDrift、restarted、clusterStopped、clusterRemoved均true | 全新专用合成集群；没有访问或修改既有业务数据库 |
| `git diff --check` | PASS | 无提交或推送 |

可重现命令（PowerShell，仓库根目录）：

```powershell
npm.cmd run build --workspace api-nova-parser
npm.cmd run build --workspace api-nova-server
npm.cmd run build --workspace api-nova-api
node scripts/verify-unified-work-plan.cjs

# 本机已安装且本轮验证过的运行时；不修改用户系统PATH
$np10Node = 'C:\Users\ieta\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:OPENSSL_CONF = 'C:\Program Files\Git\mingw64\etc\ssl\openssl.cnf'
Push-Location -LiteralPath 'packages/api-nova-api'
try {
  & $np10Node '../../node_modules/jest/bin/jest.js' --runInBand --testPathPattern=modules/gateway-runtime
} finally {
  Pop-Location
}
$env:API_NOVA_TEST_PG_BIN = 'E:\PostgreSQL\16\bin'
& $np10Node packages/api-nova-api/scripts/test-isolated-postgres-host-credential-registry.cjs
git diff --check
```

本轮本地原始输出：`tmp/np10-gateway-tests.json`（失败）、`tmp/np10-gateway-node24.json`及同名log（最终通过）、`tmp/np10-postgres-final.log`（最终通过）。这些临时输出不纳入版本控制；本报告记录可重现命令、计数和限制。

## 失败历史与环境约束

1. 最初API构建遇到Parser/Server陈旧dist导出缺失；顺序重建三包后通过，没有改接口来绕过类型错误。
2. 新测试初次遇到Supertest导入形式和Nest异常对象断言错误，修正为require导入并断言结构化错误code后通过。
3. 默认Node `E:\emsdk\node\22.16.0_64bit\bin\node.exe`下完整Gateway首轮42/50套、577/724项通过，147失败。其中1项为上述新增断言，其余涉及stable-read和OpenSSL夹具初始化。只读对照显示同一`package.json`的`lstat.dev=0`、`fstat.dev=1287713624`，触发现有文件身份校验。已安装Node24.19.0两值一致；未放松stable-read安全校验。
4. 用Node24.19.0及显式OpenSSL配置运行完整目录后一次性724/724通过。原OpenSSL夹具抑制了stderr，本轮未单独断定其最初失败细因；不将组合复验成功写成已修复所有工具链版本。
5. PG早期6组bootstrap版本warm59+cold4通过；补充真实HTTP后最终warm61+cold4通过，不能将两轮相加为新增用例。
6. WSL只确认注册有Ubuntu与docker-desktop，未执行Linux验收；目标部署、持续负载与P95/P99等阈值未冻结，NP-01保持进行中。
7. 在线依赖审计首试DNS失败，沙箱外重试被自动审批拒绝：向 `https://registry.npmjs.org` 发送依赖树/包名和版本可能暴露内部依赖信息。未绕过，未执行`audit fix`；NP-02待用户明确同意发送该信息，不能沿用旧审计数字作为当前结果。

## 后续调度

NP-11为下一Gateway主线；NP-20与NP-30具备实现前置，可独立推进。可观测治理按NP-40～47推进，环境与性能条件由NP-01维护；NP-02授权、NP-50～53候选验收与NP-60部署签收仍未完成。准确状态以[统一开发状态](../plans/main-2026-10-20/unified-development-status.md)为准。
