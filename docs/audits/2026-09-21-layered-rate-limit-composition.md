---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# 六层限流组合验收

## 范围
SEC-D2-02在B1-02提交4680316完成后闭合。最终实现版本为包含本报告的提交；Windows本机真实HTTP及隔离SQL.js，不涉及生产部署。锁文件未变。
Global/Runtime/Route/Credential/IP/Anonymous按顺序评估，首个饱和层负责拒绝归因；拒绝不扣前面各桶。缓存命中仍参与计量，同Subject轮换保持限流身份，缓存仍按Key身份隔离。24并发在7额度下精确准入7次。
组合测试发现共享Global/Runtime桶可被其他路由较短windowMs提前重置，现保存原窗口定义：未到期配置冲突503并发出gateway.rate_limit_configuration_conflict，不修改任何桶；原窗口到期后采用新定义。
## 验证
- npm test --workspace=api-nova-api -- --runInBand --testPathPattern="gateway-rate-limit-composition.http|gateway-traffic-control.service|gateway-rate-limit.http|gateway-cache.service"：4套73/73通过，exit 0。
- 新组合HTTP19项，含6层顺序/归因、缓存计量、跨Runtime/Route作用域、拒绝不扣、轮换/撤销/到期/越域及并发精确准入。
- npm run build --workspace=api-nova-api：exit 0。扩大Gateway/runtime-assets/publication回归30套382/382，和B1/A3重叠不累加。
路由选择使用夹具，凭证为真实SQL.js仓库，入口和上游为真实socket，观测出口mock；未宣称多节点限流或真实监控部署。
## 父包和后续
D2原出口是身份化缓存、分层限流、匿名独立Bucket，当前功能均有证据。父依赖B2与D1整体验收尚未闭合，保留IN_PROGRESS；原台账额外“多节点验收”不是批准原出口，已删除该无依据延期条件。
当前叶子68 DONE、21 READY、0 IN_PROGRESS、23 WAIT_DEP、17 NEED_ENV、1 SCOPE_REVIEW、2 DEFERRED，共132。后续优先B3-01持久撤销/长连接、F2-02匿名管理界面，可与已有READY的B2配置矩阵并行；C3-03等生产生命周期C1真实接线。
