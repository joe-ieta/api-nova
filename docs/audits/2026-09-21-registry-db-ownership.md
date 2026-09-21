---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-C3-02 Registry配置可信数据库归属验收

起点c3e0002，最终代码版本为包含本报告的提交。Windows、Node24.15.0、隔离SQL.js；未读取业务数据库。锁文件SHA256 `9eb15cc0265e1366483cc340ee6e7e55638af3ed558eb09dc1a5bb032f3f2a54`。

Gateway主机向Registry注入可信归属校验，在secret dry resolution之后、原子换代之前执行；有文件配置但DB不可用时拒绝启动。每次启动/manual/watch在同一SERIALIZABLE事务内读取Source/Endpoint：未知Source、未知ID、跨源ID、跨源method/path均拒绝；数据库失败不替换旧快照。配置文本无法注入校验器。

验证：Parser registry/manual/watch 3套46/46；Gateway provider/admin/controller/resolver 4套46/46，其中provider25项使用真实SQL.js；主任务连同B1周边复验7套120/120，均退出0。Parser和API构建通过。覆盖JSON/YAML Nest接线、DB删除/失败保旧、watch错误归属恢复和关闭。

入口：[归属验证器](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential-ownership.ts)、[真实DB测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential.providers.spec.ts)。

只关闭C3-02。每次激活重新核验，不因激活后的DB变更自动撤销当前generation；不替代C3-03跨进程传播。
