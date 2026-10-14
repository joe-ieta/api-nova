---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-14
---
# OPS-01 打包浏览器 Gateway 主流程限定验收

本机 Windows、隔离 SQLite、打包 UI 的手工注册 Gateway 主流程已完成。19 个阶段通过，包含环境准备、真实浏览器操作和辅助 HTTP 消费；这不关闭 OPS-01 的目标环境生产签收。时间仅作诊断，没有降低准入、认证、持久化或数据完整性要求。

## 可复现入口与证据

- 入口：`npm run verify:ops-01-browser`。先安装仓库依赖并构建 API/server/UI；Playwright 可通过普通模块解析或 `OPS_PLAYWRIGHT_MODULE` 指定已安装模块，`OPS_BROWSER_PATH` 可指定 Chromium/Edge 可执行文件。可选 `--vite` 仅用于开发诊断，最终验收采用默认打包模式。
- 脚本：[隔离启动与取证](../../scripts/verify-ops-01-browser.cjs)、[注册与治理](../../scripts/ops-browser-scenario.cjs)、[发布与部署](../../scripts/ops-browser-publication.cjs)、[消费与监控](../../scripts/ops-browser-consumption.cjs)。
- 基线：`oc_dev / 60bf65f` 加本轮四项 UI 修复；原始证据为 `E:\CodexDev\api-nova\.tmp\ops-01-browser-zcWhIR\evidence.json`。其中包含执行脚本、产品 API 构建、UI 页面源码和全部打包 JS/CSS 的 SHA256。
- 运行：2026-10-14 11:35:26—11:36:07（Asia/Shanghai），约 41 秒；Headless Edge/Chromium 155.0.4283.45。使用全新迁移数据库、随机 loopback 端口、随机管理密码/JWT和独立审计/观测目录。
- 最终结果：`OPS_01_BROWSER_VERIFY_OK`，exit 0，19/19，浏览器未捕获异常 0。浏览器已关闭；自建 API/上游端口及预留 MCP 端口均不可达。没有启动真实 MCP 服务，此项不是 MCP 生命周期验收。
- 同目录保留 `browser-runtime-access-logs.png`、`browser-monitoring-terminal.png`、最终 DOM 文本/截图、API/迁移日志。消费 Key 只在内存使用并加入脱敏清单，截图遮盖一次性 Key 区域；临时数据库、日志、截图不入 Git。

## 实际用户流程

| 阶段 | 操作与核验 |
| --- | --- |
| 登录与注册 | 通过登录表单登录；手工注册页实际填写服务、回环地址、GET `/manual` 并创建；读取响应验证端点身份 |
| 实例、测试、治理 | 运行实例面板点击探测，确认 healthy；测试弹窗真实请求上游并显示结果；治理页探测与准入检查通过 |
| smoke 样本 | 测试弹窗进入样本库，维护当前成功样本的 `smoke` 标签；不使用缺样本豁免 |
| 发布配置 | 创建 Gateway、勾选并加入就绪端点；配置已评审画像、外部路由、`api-key-default` 和显式 Registry v1 请求头策略；绑定健康实例并保存 |
| 发布与部署 | 实际点击发布、确认、部署；真实候选验证 `passed`，激活状态 `activated`，部署响应返回对应验证 run |
| 凭证 | 运行资产详情实际创建 API Key；从一次性输入框读取，刷新后不重新显示；管理 API 只读回查凭证状态 |
| 部署后消费 | 辅助真实 HTTP 消费者使用产品公布的地址；无凭证 401 且未到上游，有凭证 200、响应来自预期实例，消费者 Key 未转发上游 |
| 运维关联 | 详情访问日志刷新后仍显示 200；由发布页“查看监控”带资产参数跳转，按同请求 ID 显示 durable finished/success/200；再次刷新仍可读 |

最终运行资产 `f89ac030-18b5-4e98-9e63-8fcae78f290d`，部署验证 run `996252bb-f136-44be-94f0-2ac74d4e69b0`。真实成功请求 `be937a52-5da5-4853-9a97-dbe64776731c`，观测调用 `dabb3b67-f851-4a4d-a64e-f37943b5cad9`；未把源端点测试误当作部署后消费。

仅上游 Registry 文件和受控 reload 属环境准备，由脚本配置；注册、实例探测、治理、样本标签、成员/路由/绑定、发布部署与消费凭证均由真实浏览器点击完成，没有通过管理写 API 替代这些操作。浏览器未覆盖 Registry 管理员配置流程。

## 发现并修复的真实阻塞

1. Gateway 表单缺少生产 guard 所需的 Registry v1 请求头策略入口。新增显式选择，保留既有上游配置和匿名例外，已保存的 v1 不因取消勾选被降级；guard 与凭证隔离规则不变。
2. 打包 UI 的 JSON 参数示例包含未转义大括号，生产国际化编译器报 `Invalid token in placeholder`，使测试弹窗不可用。中英文文案改为合法字面插值，最终显示仍为 `{"id": 1}`。
3. 发布成员行未携带源服务标识，使“运行上游绑定”入口隐藏。优先使用成员源标识，否则按同端点从候选映射，不借用其他端点的来源。
4. 发布页挂载与路由监听强制筛选 ready，把新加入的 draft/blocked 成员隐藏，无法继续配置。默认改为 all，并保留用户主动筛选；可加入候选和真正发布的准入门禁保持有效。

联调还明确了操作前置：仅测试端点不等于运行实例已 healthy。未探测实例时部署真实返回 `fixed_primary_unavailable`；最终流程通过实例面板完成探测后正常部署。未把该拒绝改为通过。

## 验证范围

- UI 类型检查及最终构建通过：`.tmp/2026-10-14-ops-ui-build-final.log`。
- 相关 UI 回归 **38/38**：Registry 策略、真实成员映射/挂载/路由监听/过滤、消费调用与既有发布认证回归；`.tmp/2026-10-14-ops-ui-regression.log`。
- `node scripts/test-ops-browser-i18n.cjs`：真实生产国际化编译器验证中英文流程文案 **2150 条**，并验证 JSON 与命名插值渲染。
- 最终真实浏览器 **19/19**，使用本轮最终产品构建；未修改 API 产品源码，未重新宣称全 API 套件在本轮运行。

## 剩余边界与外部要求

- 本轮范围为管理员手工注册单端点、单健康实例、API Key Gateway。浏览器 OpenAPI 导入、A/B迁移、MCP、其他身份/角色和非 Windows 环境未由本轮证明；它们原有 HTTP/SDK 限定证据仍可复用。
- SEC-F4-02、OBS-16-04、OPS-01 的目标环境签收保持待办。用户已选择暂用本机隔离环境，不擅自执行生产部署。后续需指定目标 OS/CPU、数据库、运行账户/ACL、TLS与反向代理、真实身份/网络、有效开关、日志审计保留、受控告警/SMTP接收端及备份恢复/回退窗口；无需发送明文密码或令牌。
- 本轮只读 C 盘采样：总量 106757660672 bytes，空闲 9854779392 bytes，使用率约 **90.769%**，达到现有90%阈值还差 820986676 bytes（约0.77 GiB）。建议设备所有者释放至少 **2 GiB** 留余量后重跑 `verify:env-01`；本轮没有清理用户数据、降低磁盘阈值，也没有重测完整 health。
- 原 SQLite 3000次负载未完成的大样本观察继续作为非阻断诊断保存；本轮小规模业务闭环不覆盖该完整性缺口，也不重新开启本机时间优化。

状态入口：[执行台账](../guides/active-work-package-execution-status.md)、[任务划分](../guides/active-work-package-breakdown.md)、[剩余事项](../reference/open-items.md)。
