---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-16

---
# 重拆第五批：发布意图、样例孤儿整理与鉴权语义

本记录对应[129项叶子任务划分](../guides/active-work-package-breakdown.md)及[统一执行状态](../guides/active-work-package-execution-status.md)。叶子项DONE只表示表中限定出口达标；OBS-14、PROD-04、SEC-A1等父包退出条件仍单独核对，测试集互有交叠，不把用例数当项目完成率。

| 子项 | 本批可核查结果 | 保留边界 |
| --- | --- | --- |
| SEC-A1-01 | [七模式跨层矩阵](../testing/sec-a1-01-auth-mode-cross-layer-matrix.md)逐DTO、存储、UI、发布和运行路径标实现/缺口；原审计运行API97/97、Parser23/23、stdio12/12及MCP HTTP安全冒烟。 | 是合同盘点，不是模式保存到真实请求的闭环。 |
| SEC-A1-02A | Gateway可见性写边界统一internal/external；旧public回传精确归一为受保护internal，只有显式external允许匿名。空authPolicyRef明确清空，候选拒绝且旧active保留；保存→编译/快照专项API三套34/34、UI helper2/2。 | 尚未完成A1-02D的完整真实HTTP/重启矩阵；临时匿名治理仍属SEC-A3。 |
| SEC-A1-02C | 直连stdio审计标local_process及unknown，不伪称HTTP anonymous或认证caller；真实stdio12/12、HTTP权限20/20、Parser审计规范化41/41。 | 不表示managed stdio部署已实现。 |
| OBS-14-05C2C2B1 | 双方言前向迁移、当前schema和独立发布意图原语；旧reservation不回填。隔离SQLite新库69实体/表、2次迁移，同库重启0迁移/0漂移；旧库仅1次前向迁移；专项9/9。 | PostgreSQL只做静态DDL/实体对照，未连接隔离PG运行。 |
| OBS-14-05C2C2B2 | writer校验事务先提交预留和精确final/temp意图，首次文件I/O在后；重放仅复用原temp key，残留文件不覆盖，未知占用不释放；专项13/13。 | quotaEnforced仍false；可证明结算留C2C2C。 |
| OBS-14-05C2C2B3 | SQL.js导出重启、首次open前崩溃、残留temp、旧无意图、settled/uncertain及owner/epoch/generation变化矩阵8/8。 | 不等价于PostgreSQL/Linux/真实多进程崩溃验收。 |
| PROD-04B3E1 | 发布、撤销和整理共用对象围栏；SQL.js同进程队列，PostgreSQL代码使用会话级advisory lock与前后活性检查。 | 真实PG跨进程及单次文件操作中途断线未验；E2持久CAS阻断旧写者ready。 |
| PROD-04B3E2 | 显式受权清理复用单轮100对象/2秒软预算；无引用staged经5分钟宽限、围栏内复核和持久staged→delete_pending CAS后才按受控key unlink；失败留ORPHAN墓碑重试。 | 仅SQL.js临时目录验证，不启用生产定时器。 |
| PROD-04B3E3 | 双服务排队、候选复核、旧写者、CAS/文件/终结事务失败及重启矩阵；endpoint-testing四套75/75。 | 不表示PG跨进程、真实断线或生产留存验收。 |

主任务独立复验：endpoint-testing 75/75、Gateway/Publication三套34/34、UI helper2/2、发布意图/接线/重启30/30、Parser安全23/23、真实stdio12/12；API与UI构建通过。测试均在本机隔离SQL.js/临时目录或本地子进程执行，没有触达生产数据库和生产对象根。

## 依赖重排与下一出口

C2C2B1/B2/B3完成后，C2C2C可进入仅对可证明意图、文件和元数据的恢复对账；旧无意图reservation仍维持unknown，不能据文件存在或长度释放额度。PROD-04B3E1/E2/E3完成后，B3D可进入删除/回放整体验收；PG跨进程和平台权限仍由PROD-04C/外部验收单独覆盖。

鉴权模式跨层矩阵证实原SEC-A1-02B同时包含模式存储、现行进程启动、实验性managed IPC和UI，已在[任务划分](../guides/active-work-package-breakdown.md)细分为B1/B2/B3/B4；A1-02D等待这些出口与A/C的端到端验证。SEC-E1-02C1受管生产生命周期和OBS-14-03E2B事件永久删除仍保持原审批边界。