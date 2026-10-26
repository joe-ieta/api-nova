---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-C3-01 固定凭据文件自动重载验收

代码起点：`5c6da02`；最终代码版本为包含本报告的提交。平台Windows，Node 24.15.0，锁文件SHA256 `9eb15cc0265e1366483cc340ee6e7e55638af3ed558eb09dc1a5bb032f3f2a54`。

## 行为和边界

主机配置 `API_NOVA_UPSTREAM_CREDENTIAL_RELOAD_MODE=watch` 明确启用，固定FILE/FORMAT/ENVIRONMENT；文件候选的reload.mode也必须为watch。默认manual。配置内容不能改换监听路径或自行开启监听。
监听父目录以兼容原子替换；合并短时变化，稳定读取/校验/秘密预解析成功后才换代。坏文件、provider失败和删除保留上一代，固定文件重建后恢复。关闭释放句柄/计时器并栅栏拒绝在途激活。
管理员reload在锁内再次检查expectedGeneration，避免审计await期间watch已更新后仍接受旧代请求。watch与手工调用共用锁。

## 验证

- `npm test --workspace=api-nova-parser -- --runInBand --testPathPattern=credentials`：9套252/252，退出0（并行执行者）。
- 主任务独立复验 `npx jest --runInBand --testPathPattern=credentials/registry-watch.spec`（Parser目录）：8/8，退出0。
- Gateway provider/admin：2套31/31；主任务联合限流一起复验4套42/42，退出0。
- Parser构建和API完整构建均退出0。真实Nest依赖注入后resolver读到新代，module.close停止watch。

只关闭C3-01；不证明Linux文件权限、Windows Secret File ACL、DB归属、跨进程传播或生产部署。
