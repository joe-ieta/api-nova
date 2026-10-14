---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-14
---
# OPS-01 浏览器 OpenAPI URL 导入到 Gateway 消费限定验收

按开发交接选择一个有界用户分支：Windows、隔离 SQLite、打包 UI、管理员、带绝对 server URL 的 OpenAPI 3.0.3 单端点导入。导入分支19/19通过，同一构建手工注册回归19/19通过。修复治理页缺少运行实例入口这一真实阻塞；SEC-F4-02、OBS-16-04、OPS-01生产签收状态不变，不新增历史任务ID。

## 复现与修复

旧打包UI可完成真实URL导入、文档保存和端点入库，但治理端点行没有“运行实例”入口。原始失败证据为 `.tmp/ops-01-browser-A3H4yw/evidence.json`：前5阶段通过，第6阶段实例探测因按钮缺失失败，退出码1，隔离资源已清理。导入出来的临时实例尚未完成健康探测，不能跳过部署健康门禁。

在 EndpointRegistry 治理端点行增加“运行实例”，复用已有 SourceServiceInstancesDialog；以点击端点的 sourceServiceAssetId 和名称打开。弹窗源标识从点击动作捕获，不再持续读取手工分组首行，避免治理分组或列表刷新改变已打开弹窗的目标。缺少源标识仍拒绝打开，不借用其他源。手工注册入口继续传入所选分组端点。未修改后端健康、准入、认证或发布规则。

## 可复现入口

先按根锁文件安装依赖并构建 API/server/UI。沿用 [原浏览器验收器](../../scripts/verify-ops-01-browser.cjs) 的要求：模块可通过 `OPS_PLAYWRIGHT_MODULE` 指定，浏览器通过 `OPS_BROWSER_PATH` 指定；路径取决于本机安装。

- `npm run verify:ops-01-browser -- --import`：新增URL导入分支。
- `npm run verify:ops-01-browser`：原手工注册分支回归。
- `npm run build --workspace api-nova-ui`：包含vue-tsc与生产构建。
- `node --test packages/api-nova-ui/scripts/test-governance-instance-manager.cjs packages/api-nova-ui/scripts/test-publication-member-source.cjs packages/api-nova-ui/scripts/test-gateway-registry-header-control.cjs packages/api-nova-ui/scripts/test-gateway-invocations.cjs packages/api-nova-ui/scripts/test-mcp-publication.cjs`：受影响UI专项。
- `node scripts/test-ops-browser-i18n.cjs`：生产国际化编译。

新增 [导入操作模块](../../scripts/ops-browser-import.cjs) 使用真实表单、真实后端解析和文档创建。文档、端点与临时实例通过管理GET读回核对；导入后刷新确认持久文档可见。复用已有源测试、治理、样本、发布和消费模块，没有通过管理写API代替用户操作。

## 实际结果与候选

代码基线为 `oc_dev / 0e7763c95f62c56009c02afb00824330dadd05ae` 加本次工作树修复及验收脚本；证据记录提交、工作树、API构建、UI源码和打包JS/CSS哈希。两次成功运行的64项脚本/源码/产物哈希均与提交前文件一致，使用同一UI构建。不是最终提交HEAD上的重新全量API验收。

| 验证 | 结果 | 本机证据（不入Git） |
| --- | --- | --- |
| 导入→Gateway→监控 | 19/19，exit 0；2026-10-14 12:03:51—12:04:35，Asia/Shanghai | `.tmp/ops-01-browser-rBYVBh/evidence.json` |
| 手工注册共享流程回归 | 19/19，exit 0；12:04:53—12:05:34 | `.tmp/ops-01-browser-OQ7OMe/evidence.json` |
| UI专项 | 40/40，0失败；含不同源共用URL、缺失标识拒绝和弹窗目标稳定性 | `.tmp/2026-10-14-ops-import-ui-regression.log` |
| UI类型检查/构建 | 通过，exit 0 | `.tmp/2026-10-14-ops-import-ui-build.log` |
| 生产文案 | 2150条通过，JSON及命名插值正常，exit 0 | 控制台 `OPS_BROWSER_I18N_PRODUCTION_OK` |

两条浏览器分支均为 Node v24.15.0、Headless Edge 155.0.4283.45、全新迁移SQLite和随机回环端口；浏览器未捕获异常0。API/上游已停止且端口不可达，预留MCP端口也不可达；没有启动MCP服务，不能作为MCP验证。沿用密码/令牌脱敏与截图遮盖策略，原始数据库/截图/日志不推送。

导入分支闭环：登录→从URL导入 `/imported`→刷新文档→按文档ID定位持久端点及临时实例→治理行打开实例面板并探测healthy→源测试→治理准入→维护smoke样本→创建Gateway/配置Registry v1和api-key-default→绑定实例→发布并验证激活→UI创建一次性Key→无Key401且不访问上游/有Key200且不向上游转发Key→访问日志和同请求监控终态刷新。

导入文档 `d4909d00-e88c-41c9-94bd-f6bad7d728ca`，端点 `c2b1b4e1-b3da-4140-81ce-430b4b5f51cb`，Gateway `e8f3d7eb-4f49-40e3-97a9-a1f8ca13c7bd`，验证run `a7df946b-fb24-421d-b2d0-a06da502c4e6`。成功请求 `8cb501a6-b201-4878-a169-52c80a22fd39` 与持久观测调用 `310b970a-df06-45de-87f6-3ecc1e1b14e7` 对应。

Registry文件与受控reload是环境准备；其他用户流程通过浏览器完成。时间仅诊断，本轮未压测或修改SQLite容量结论。

## 仍未覆盖与外部等待

- 仅证明无文档下载认证、带绝对server URL的OpenAPI 3.0.3单端点。浏览器文件导入、无server导入后补实例、认证规范、多端点、A/B迁移、MCP、多角色及Linux/PG目标矩阵仍未由此证明；既有HTTP/SDK证据继续有效。
- 完整health未重新运行。导入运行只读C盘采样总106757660672字节、空闲9768697856字节，约90.850%已用；达到原90%线还差907068212字节（约0.845GiB）。沿用设备所有者释放至少2GiB后复跑 `verify:env-01` 的要求，不删除用户数据、不降低阈值。
- 生产环境仍未指定，继续遵守“本机隔离、生产待办”。目标身份/ACL、TLS/反代/出站、有效开关、受控SMTP/告警、备份恢复与回退，以及Nest维护/残余依赖处置留在原签收任务；本轮未刷新npm audit，不外推10-08历史审计为当前结果。
- 最终发布仍等待SEC-F4-02和OBS-16-04签收后由OPS-01汇总。本轮提交源码与验收器，不创建发布或tag，不把本机闭环改写为生产可用。

当前状态见[执行台账](../guides/active-work-package-execution-status.md)、[任务划分](../guides/active-work-package-breakdown.md)、[未完成事项](../reference/open-items.md)。
