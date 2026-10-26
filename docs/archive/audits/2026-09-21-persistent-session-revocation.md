---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# 持久撤销与既有会话验证

基线27b7864；最终版本为包含本报告的提交。Windows本机隔离SQL.js、真实RuntimeAssets发布/候选验证、Lifecycle/ProcessManager、CLI与loopback上游。未接生产managed IPC。
node --test packages/api-nova-api/scripts/test-runtime-credential-session-revocation.cjs：2/2通过，覆盖Streamable HTTP和旧SSE。每个场景持有真实GET事件长连接，使用SDK执行tools/list及tools/call且真实命中上游。
同一CLI PID中更新持久toolScopes后既有会话列表收窄/调用拒绝；管理服务撤销后既有会话、新连接、携带回放游标重连均拒绝。SQLite destroy/reopen后旧凭证仍拒绝，其他有效凭证仍能执行。磁盘admission401审计存在且无完整Key。
使用主机API_NOVA_RUNTIME_CREDENTIAL_SOURCE=database；原静态导出不声称持久即时传播。已获准并进入上游的在途请求不取消，执行中撤销与取消策略归E1-04；本包保证撤销后的后续请求/工具执行拒绝，不保证异步推送权限通知。
当前实现已逐请求读取DB，无需重写传输或Session授权。B3-01限定出口DONE；B3-02 SDK dispatcher/通知矩阵与父依赖E0仍未闭合，父包B3保持IN_PROGRESS。
