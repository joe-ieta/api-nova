---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# 锁定SDK会话与通知合同验证

基线c273eb1；最终测试版本为包含本报告的提交。实际锁定SDK 1.29.0，未升级SDK或修改锁文件。新增可执行矩阵固定当前依赖私有dispatcher边界，不声称其为SDK长期稳定公共API。
npm run test:sdk-session-contract --workspace=api-nova-server：71/71通过，exit 0；新增矩阵11项，联合既有列表40项与执行20项。根任务最终复跑日志.tmp/sdk-contract-final.log；Server构建通过。
矩阵覆盖_requestHandlers必须为Map、缺失形状拒绝、无dispatcher适配器跳过、延迟注册可重试、重复安装不套娃。Streamable/SSE真实连接均验证同主体换钥保留Session并使用新请求scopes，跨主体POST403；Streamable另验跨主体GET/DELETE403且原会话继续可用。
持久凭证撤销真实DB/CLI证据在B3-01独立保留。本矩阵使用真实SDK与传输、受控凭证环境和Tool handler，不把此测试重复描述为持久数据库验证。
凭证scope或主机Tool规则变化后，下一次tools/list及tools/call按新权限执行；不会自动广播tools/list_changed。真实工具注册状态disable通过长连接产生1次通知作为阳性对照。目录通知与权限变化是不同事件，不承诺授权变更广播、空闲流主动断开或跨进程推送。
B3-02 DONE，B3原功能出口已有矩阵，但父依赖E0-01整体Adapter合同尚未闭合，保持IN_PROGRESS。
