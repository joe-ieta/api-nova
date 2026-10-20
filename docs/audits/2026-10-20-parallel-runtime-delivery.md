---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-20
---
# Gateway MCP 与发布入口并行开发验收

本批按[统一工作包](../guides/unified-work-packages.md)并行推进NP-11、NP-20、NP-30，同时执行用户新授权的NP-02在线依赖审计。工作树继承上一批未提交改动；没有提交、推送、生产部署或对既有业务数据库操作。

## NP-11 启动后网络装配

已完成限定出口。`GatewayNetworkInstallationService.onApplicationBootstrap`在真实路由服务`onModuleInit`之后，使用精确committed catalog、真实host Snapshot和新签发的一次性proof构造registration bundle，再将成对provider/resolver安装到稳定facade。

网络计划由host代码签发不可伪造token；无请求/env/文件自动激活适配器。缺少token保持原默认行为；显式坏token、凭据缺失、旧Registry冲突或装配失败继续闭锁且非Gateway健康。路由/来源/策略不匹配不能回落旧发送路径；目录变化、撤销、proof到期及关闭均使许可失效。该启动切片不自动刷新proof，后续重装及完整在途生命周期矩阵归NP-12。

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| 新计划与既有bootstrap/facade专项 | 3 suites / 29 tests PASS | 与完整目录重叠，不相加 |
| Gateway完整目录 | 51 suites / 736 tests PASS | 相比上一批新增12项计划/边界测试 |
| 隔离PostgreSQL16 | 68 warm + 4 cold检查组 PASS | 本包新增7组真实Nest/路由初始化/DNS/HTTP组合 |
| PostgreSQL后置状态 | zeroDrift、restarted、clusterStopped、clusterRemoved均true | 专用随机临时集群已清理 |
| API类型检查与阶段构建 | PASS | 最终跨模块回归另见下文 |

PG组合验证：提交候选但尚未启动时仍闭锁；`app.init()`依次加载真实持久路由并执行装配后，真实DNS和HTTP上游收到一次合成Basic凭据请求；缓存读取/写入为零；未注册路由拒绝；reload后拒绝且DNS/上游计数不再增加；重复启动装配调用不隐式续proof；撤销后健康200、Gateway503；close后Snapshot拒绝。

本地报告为`tmp/np11-targeted.json`、`tmp/np11-gateway-all.json`、`tmp/np11-postgres.log`。执行使用已安装Node24.19.0；Gateway目录复验显式指定OpenSSL配置。所有测试仅使用合成上游、环回地址与专用PG集群。

## NP-20 生命周期接线

完成持久`trusted_ipc_v1`选择、READY后RUNNING、受信进程所有权路由、每次重新准备的手动/自动重启、停止取消、有限重试和脱敏进程投影。缺省仍走既有模式；显式未知模式及旧秘密配置拒绝，不自动迁移或fallback。自动重启在停止旧进程前读取持久开关，真正spawn前再由同一次handoff快照核验。

独立Node测试使用SQL.js持久实体及真实产品child：最终生命周期24/24通过，既有通道/准备47/47通过。前期联合69/69（22+47）通过后，追加真实崩溃自动恢复与产品预检期间停止两项；追加首轮23/24，后者发现取消控制建立过晚，修复后24/24。日志分别为`tmp/np20-final-tests.log`、`tmp/np20-lifecycle-final.log`（失败保留）、`tmp/np20-lifecycle-retest.log`。

真实崩溃恢复核对新PID/launchId、持久RUNNING、有限重试计数及无合成秘密投影；健康检查从每代READY事件启动，修复了重启后不再检查的问题。停止覆盖首次异步预检、准备、等待READY和重启预检窗口，不能因迟到READY复活。失败和漂移保持静态拒绝，旧启动接口仍保留单参数调用。

测试中健康检查为替身，ACK超时使用受控ChildProcess/时钟；真实Nest容器整体shutdown和真实超时强制终止的产品级联动仍待补证，不能以局部服务关闭代替。MCP的PG/Linux、跨进程更新撤销、真实业务上游矩阵亦不在本批证据内。NP-20继续IN_PROGRESS；NP-21/22不提前解锁。

## NP-30 预览与发布事务切片

限定切片通过19 suites / 268 tests及API类型检查。新增只读成员preview，保留JWT和`server:read`权限；返回`preview_only`且不创建草稿、不写业务行、不部署。Unsecured MCP预览和事务发布共用门禁，失败回滚保留旧revision/profile/binding。

writer向校验器传入实际事务`EntityManager`，在异步校验及写入后重新核对context/evidence/发布记录；G4缺少`validateTransaction`时拒绝写入。批量部分失败禁止自动部署，已提交但后置副作用失败标为`committed_side_effect_failed`，不伪装为回滚或可直接重试。

新增集成证据来自真实PublicationService与SQL.js，部署调用仍是测试替身。专项运行命令：

```powershell
& $parallelNode '../../node_modules/jest/bin/jest.js' --runInBand --moduleNameMapper '{}' --testPathPattern 'modules/publication/'
```

此命令在API目录使用已构建的真实workspace导出；最终默认mapper整合结果另记。首轮新增故障注入曾266通过/2失败，修正注入时机后268全部通过，没有放宽门禁。

生产challenge/session/proof issuer、认证请求绑定context provider、用事务manager重新验证proof对应evidence/context/epoch的真实实现尚未装配。G2仍`canPublish:false`，G4仍限同步host swap；真实异步激活、Gateway/MCP一致性、PG/重开/并发矩阵仍待完成。因此NP-30保持IN_PROGRESS，不能用Unsecured MCP切片宣称受保护发布完成。

## NP-02 审计与修复边界

用户本轮已明确授权向`https://registry.npmjs.org`发送依赖信息。以下两条命令成功取得完整JSON报告，均退出1（发现漏洞）：

```powershell
npm.cmd audit --json --registry=https://registry.npmjs.org
npm.cmd audit --omit=dev --json --registry=https://registry.npmjs.org
```

全量122个包条目；生产43个（1 critical、21 high、21 moderate）。这些包条目包含传递影响，不等于独立漏洞数或已证明可利用入口。[分诊报告](./2026-10-20-dependency-audit-triage.md)记录锁文件指纹、实际依赖节点、生产入口、触发条件及优先处置顺序。未执行`audit fix`或修改锁文件；兼容补丁、重大升级和部署暴露面核查仍有待完成，NP-02保持IN_PROGRESS。

## 重现与限制

```powershell
$parallelNode = 'C:\Users\ieta\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:OPENSSL_CONF = 'C:\Program Files\Git\mingw64\etc\ssl\openssl.cnf'
Push-Location -LiteralPath 'packages/api-nova-api'
try {
  & $parallelNode '../../node_modules/jest/bin/jest.js' --runInBand --testPathPattern=modules/gateway-runtime
  & $parallelNode '../../node_modules/jest/bin/jest.js' --runInBand --json --outputFile=../../tmp/parallel-api-final.json
  & $parallelNode '../../node_modules/@nestjs/cli/bin/nest.js' build
} finally {
  Pop-Location
}
$env:API_NOVA_TEST_PG_BIN = 'E:\PostgreSQL\16\bin'
& $parallelNode packages/api-nova-api/scripts/test-isolated-postgres-host-credential-registry.cjs
& $parallelNode --test packages/api-nova-api/src/modules/servers/services/managed-mcp-lifecycle.test.cjs
& $parallelNode --test packages/api-nova-api/scripts/test-managed-mcp-channel.cjs packages/api-nova-api/scripts/test-managed-mcp-handoff-preparation.cjs
node scripts/verify-unified-work-plan.cjs
git diff --check
```

以上不是全平台或目标部署验收。原NP-10失败历史保留在[上一批记录](./2026-10-20-unified-planning-np10.md)。并行编辑期间的类型检查曾见两个暂态编译错误，相关分支修正后重跑退出0；初次禁用incremental的检查命令与composite配置冲突，改用独立tsBuildInfoFile后执行。不得把中途失败隐藏成首次全绿。

首轮全API为136/137 suites、1583/1585 tests通过（退出1）；两项旧启动接口测试要求原单参数调用，新增可选signal被显式传成undefined导致失败，已恢复旧调用形态。首轮证据`tmp/parallel-api-all.json`保留。

最终源码完整重跑：137/137 suites、1585/1585 tests通过，退出0，167.221秒；结果`tmp/parallel-api-final.json`及`tmp/parallel-api-final.log`。最终API构建退出0。上述Jest计数已包含Gateway和publication专项，不再累加；独立Node生命周期24项和既有通道/准备47项不在Jest计数内。映射校验再次确认209条原任务、150条继承DONE、59条剩余任务、31个新包，依赖无环；24个所查本地文档链接及`git diff --check`通过。
