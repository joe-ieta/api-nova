---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-14
---
# 显式单跳凭据执行、容量样本与诊断UI

沿用[前轮依赖](./2026-09-14-routing-policy-mapping-wave.md)，三路并发交付，父级接入pipeline容量视图、独立审查和统一验证。未改业务数据库/初始化结构、真实环境开关或部署；已有工作区改动保留。

| 任务包 | 本轮完成切片 | 剩余退出条件 |
| --- | --- | --- |
| SEC-E1/C4 | 显式single-hop标准HTTP发送使用可信操作映射+单次Registry快照+共享Resolver；None隔离、固定零自动跳转、静态错误及Server双入口 | 生产托管链配置、DB归属、自动逐跳/DNS/SSRF、CLI秘密移除 |
| OBS-TP14 | 同一次GC扫描记录清理前逻辑字节样本与覆盖；pipeline.retention.scanUsage按独立扫描时间解释 | 当前全盘总量/可用空间、配额强制及其余元数据生命周期 |
| OBS-TP10/14/15 | Dashboard只读诊断：管理心跳、授权路由、留存报告及容量样本，分来源失败与身份/卸载隔离 | 全局状态快照、业务存活及完整UI/平台交付 |

## 审查与修复

- P1：None曾可通过旧customHeaders.env提供器发送当前Registry未包含的认证名。以合成秘密/内存adapter复现后，single-hop采用独立配置副本并禁旧env provider，后续原配置变更不恢复它。
- P2：非枚举或后加custom handler getter曾可在拒绝前执行。现在构造检查Reflect.ownKeys，运行期只检查自有项并固定拒绝，不求值getter；原型方法名走标准HTTP。两项均有定向回归及独立复核。
- 全局Axios认证/头/参数默认值及interceptor不会重新注入新模式；宿主adapter/序列化扩展仍要求可信。凭据解析失败零发送，固定maxRedirects=0，模拟原生HTTP adapter的302只发一次。旧模式自动跳转与既有header/cookie正文排除防护保留。
- GC容量不是当前磁盘总量：不累计跨批数值、不新开全盘扫描；complete仅扫描窗口覆盖。扫描失败/busy/旧结构为unknown，worker停机不刷新旧样本时效。未强制配额。

## 验证

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| Parser构建 | PASS | tmp/single-hop-capacity-wave-parser-build.log |
| Server构建 | PASS | tmp/single-hop-capacity-wave-server-build.log |
| API构建 | PASS | tmp/single-hop-capacity-wave-api-build.log |
| UI类型检查/生产构建 | PASS | tmp/single-hop-capacity-wave-ui-build.log |
| OBS联合（含路由/容量） | 273/273，0失败/取消/跳过 | tmp/single-hop-capacity-wave-observability-tests.log |
| Parser全量 | 20套363/363 | tmp/single-hop-capacity-wave-parser-tests.log |
| Gateway全量 | 17套176/176，detectOpenHandles正常退出 | tmp/single-hop-capacity-wave-gateway-tests.log |
| Server两个入口 | 4/4 | tmp/single-hop-capacity-wave-server-tests.log |
| UI诊断/策略/查询/实时流 | 33/33 | tmp/obs-ui-diagnostics-tests.log |

OBS集合为前轮16脚本+payload-capacity+gateway-routing-observation；容量7项和pipeline16项已包含273项中。单跳14项包含Parser363项中；上述集合不与历史专项相加。容量三脚本source33/33先行验证见tmp/single-hop-capacity-wave-capacity-tests.log，不再累加。

环境为Windows、SQL.js、隔离合成文件、注入Axios/原生HTTP mock或回环测试。无真实外部上游/秘密操作。源码收敛期间的条件类型错误已修复，由最终四包构建作统一门禁。PostgreSQL/Linux、多进程、容量持续负载与真实部署仍未验收。

## 当前状态与下一依赖

OBS：DONE10、IN_PROGRESS5、BACKLOG1。安全：DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。合计39包：DONE11、IN_PROGRESS23、BACKLOG4、DEFERRED1；无新增整包DONE，HTTP28/28限定VERIFIED，AVAILABLE=0。

下一关键依赖为受管MCP启动链接入可信映射/单跳Resolver及DB资产归属，自动逐跳和DNS/SSRF另行闭环；OBS继续完整容量/配额及元数据生命周期、业务运行健康→全局状态快照。TP16/SEC-F4按最终整合版本验证完整矩阵。
