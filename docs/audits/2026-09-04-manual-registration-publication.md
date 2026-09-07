---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-07
---
# 审查报告 A1：手工服务注册 → 发布为代理服务的能力审查

- 报告编号：A1
- 审查日期：2026-09-04
- 审查范围：服务注册后（重点：**手工服务注册**）发布为代理服务（MCP Server / Gateway）的能力完整性、可用性与实现一致性
- 审查方式：静态代码审查（只读，未修改任何代码）
- 相关人员：（填写审查人 / 复核人）
- 状态：`已整改`（代码整改完成，运行级 E2E 复核待本机环境恢复后补充）

---

## 1. 结论概述

后端链路（注册 → 探活 → 测试 → 就绪 → 发布 → Runtime 落地）**骨架已闭环**：

手工端点可进入 `asset-catalog`，经 `publication` 发布到 `MCP_SERVER` 或 `GATEWAY_SERVICE`，具备 readiness 门禁、审计、批处理、离线、运行时落地（deploy/start/stop/redeploy）与观测能力。

但对**手工注册的端点**而言，该链路的"代理可用性"存在多处实质缺口，**发布 ≠ 可被真正调用**，其中 MCP 路径问题最严重：

- 手工端点因缺少参数/请求体信息，生成的 MCP 工具**输入 Schema 为空且禁止传参**，query/body/path 参数均无法透传；
- 合成的工具名含 `/`，违反 MCP 规范，多数客户端会拒绝或错乱；
- 带 `{path 参数}` 的手工端点按正常路径**无法通过就绪门禁**，发布被阻塞；
- MCP 发布后仅自动 deploy 不自动 start，服务进程未运行；
- Gateway 发布需手动建 route、访问入口展示失真、默认匿名暴露；
- UI 源目录为空，运营界面缺失。

总体评估：**能力框架完善度较高，但"手工注册 → 可调用代理"的端到端可用性不达标，不能满足"发布后即可接入 AI 应用"的预期。**

---

## 2. 审查对象与链路

```
PATCH/POST /api/v1/assets/endpoints/manual        asset-catalog.service.ts:352
  → SourceServiceAsset + EndpointDefinition（status=DRAFT, publishEnabled=false）
  → probe（探活）→ test（功能测试）→ governance（readiness）   asset-catalog.service.ts:189,263；endpoint-readiness.policy.ts:40
  → publication：runtime-asset / membership / profile / gateway-route   publication.service.ts:311,359,431,466
  → publish / offline / batch                                       publication.service.ts:578,613,641
  → Runtime 落地：
      MCP → assemble → deployMcpRuntimeAsset → CLI spawn(streamable)   runtime-assets.service.ts:592；server-lifecycle.service.ts:91
      Gateway → assemble → gateway snapshot → proxy forward            runtime-assets.service.ts:358；gateway-route-snapshot.service.ts
```

已具备的能力（未发现问题项）：

- 发布候选/成员/档案/路由的配置管理
- 单条发布/下线、批量发布/下线（含批运行记录与审计）
- 发布档案（profile）与历史快照
- Gateway 路由冲突检测、优先级快照解析
- Gateway 转发引擎：鉴权（jwt/api-key/anonymous）、缓存、限流、熔断、重试、访问日志与指标
- Runtime 生命周期：deploy / start / stop / redeploy 与观测事件

---

## 3. 问题清单

### A1-01【高】手工端点 MCP 工具输入 Schema 为空且禁止传参

- 位置：`asset-catalog/dto/asset-catalog.dto.ts:60`；`asset-catalog/service.ts:514`；`runtime-assets/service.ts:257-283`；`api-nova-parser/transformer/index.ts:470-544（尤其 539-544）`
- 描述：手工注册 DTO 只采集 `name/baseUrl/method/path/description/businessDomain/riskLevel`，不采集参数/requestBody/header/schema；落库无 `rawOperation`/`parameters`。装配重建的 OpenAPI operation 无 parameters/requestBody → 生成 `inputSchema = { type:'object', properties:{}, additionalProperties:false }`。MCP 客户端在 `additionalProperties:false` 下不允许传入任何实参，LLM 只能 0 参调用。
- 影响：手工端点发布为 MCP Server 的工具"形同虚设"，无法携带任何入参。
- 建议：手工注册支持录入 OpenAPI 简化参数模板（path/query/body 简化 schema）并写入 `rawOperation`；或允许从示例请求推导参数结构。

### A1-02【高】MCP 工具名含 `/`，违反 MCP 规范

- 位置：`runtime-assets/service.ts:260-266`（合成 `operationId = ${method}_${path}`，如 `get_/pets`）；`api-nova-parser/transformer/index.ts:434-447`（对存在的 operationId 原样用作工具名，不做清洗）
- 描述：手工端点无 operationId，装配时为操作写入 `method_/path` 形式的 operationId，parser 直接以其作 tool 名，名称含 `/`。
- 影响：含 `/` 的工具名不符合 MCP 工具命名约束（字母数字/下划线/连字符），多数 MCP 客户端会拒绝注册或解析错乱；长路径还可能超出 64 字符限制。导入类无 operationId 的端点同样受影响。
- 建议：装配阶段对合成 operationId 做规范化（去除非法字符、路径参数占位替换），参考 parser 自带 `generateToolName` 的清洗逻辑。

### A1-03【高】手工端点 query 参数无法透传、POST/PUT 请求体无法传递

- 位置：`api-nova-parser/transformer/index.ts:680-690`（query 仅来自 `operation.parameters`）；`717-758`（请求体依赖 requestBody 或剩余 args）
- 描述：手工端点 operation 无 `parameters`/`requestBody` 定义 → query 参数在 `buildUrlWithParams` 中被忽略；body 构造依赖 args，而 A1-01 已禁止传参，因此 POST/PUT 请求体也无法携带。
- 影响：带 query 参数的 GET、任何有请求体的写操作，通过 MCP 代理调用时请求不完整 → 对上游而言代理"不可用"。
- 建议：与 A1-01 一并解决（补参数/请求体 schema）；同时评估对无定义操作放开 `additionalProperties` 以便透传 body。

### A1-04【中】带 `{path 参数}` 的手工端点无法通过就绪门禁

- 位置：`asset-catalog/service.ts:199-206`（probe 默认 URL 用字面 `{id}`）；`274`（test 同）；`endpoint-readiness.policy.ts:45-69`（强制 probe 健康 + test 通过 + 状态 verified + publishEnabled）
- 描述：probe/test 均以字面 `baseUrl + path` 请求，`/pets/{id}` 未做参数替换 → 上游 404/400 → unhealthy / failed → readiness 不通过，`addPublicationRuntimeMemberships` 与 `publishMembershipContext` 抛 `Publish blocked`。
- 影响：带路径参数的合法端点按正常路径永远无法发布，只能通过手工编辑 metadata / governance 绕过。
- 建议：probe/test 支持对 `{param}` 用示例值替换（可在 metadata 配置测试参数/示例），或将占位参数视为"可达性已确认"的判定放宽点。

### A1-05【中】MCP 发布后仅自动 deploy 不自动 start

- 位置：`publication/service.ts:1029-1034,1094-1114`；`runtime-assets/service.ts:637-649`（autoStart 默认 false、status STOPPED）
- 描述：对手工 MCP 端点发布成功后自动调用 `deployMcpRuntimeAsset`，但只创建/更新 `MCPServerEntity`，不启动进程；返回仅提示"Runtime deployment has been updated automatically"。
- 影响：发布完成后服务并未运行，代理不可连，需再手动 start，流程有断裂点、易误判为"已发布即已上线"。
- 建议：发布参数支持"发布后自动 start"选项；或在返回与 UI 中显式提示下一步 start 操作。

### A1-06【中】Gateway 发布需手工配置 route，无默认建路由行为

- 位置：`publication/service.ts:466-576,1196-1204,1321-1331`（routeRequired）
- 描述：发布到 GATEWAY_SERVICE 前必须先调用 `PUT runtime-memberships/:id/gateway-route` 配置路由，否则被 `routeRequired` 阻塞；无按 method+path 自动建 route 的默认行为。
- 影响：操作负担高；手动 build 路线遗漏 route 时发布即失败，体验不顺畅。
- 建议：提供"按端点 method/path 自动生成默认 route"选项（允许覆盖），并在 UI 上给出明确引导。

### A1-07【中】Gateway runtime 的 `accessUrls` 为空/失真

- 位置：`runtime-assets/service.ts:1304,1321-1322,1408-1440`（managedServer 恒为 null；URL 依赖 runtimeEndpoint 或 matchHost）
- 描述：Gateway runtime 无 managedServer，默认无 matchHost 时 `buildGatewayRouteAccessUrls` 返回 `[]`；而路由其实暴露在 `/api/v1/gateway/<path>`。
- 影响：governance/运行时摘要展示的访问入口与实际可达地址不一致，运营误导。
- 建议：将真实入口（`{apiBaseUrl}/api/v1/gateway/{routePath}`）纳入 accessUrls 计算。

### A1-08【中】`routeVisibility=internal` 只存不查

- 位置：`gateway-route-binding.entity.ts:70`；`publication/service.ts:499,523`；`gateway-route-snapshot.service.ts:218-252`（未校验）
- 描述：`routeVisibility`（默认 `internal`）仅存储展示，snapshot 解析与代理转发均不校验。
- 影响："内部"路由同样对外可访问，visibility 语义未落地。
- 建议：在 snapshot/resolver 中对 visibility 语义（internal/external）明确处理，或在文档中声明其为纯标注字段。

### A1-09【中】Gateway 转发无 JWT 守卫且默认匿名；openapi 公共端点泄露上游信息

- 位置：`gateway-runtime.controller.ts:6-19`；`gateway-security.service.ts:40-45`；`openapi.controller.ts:37,516`
- 描述：转发入口控制器未挂 JWT 守卫，默认无 authPolicy 时走 `anonymous`；`/openapi/by-runtime-asset/:id`、`by-server/:id` 为 `@Public`，可无鉴权拉取组装 OpenAPI（含手工端点上游 URL 与 LLM 描述）。
- 影响：发布的 Gateway 路由只要知道 URL 即可匿名调用；外部可直接读取内部端点与上游信息。
- 建议：默认生成"匿名受限"提示或强制要求配置鉴权；公共 openapi 端点增加最小访问保护（如 token/白名单），或对对外链路隐藏内部字段。

### A1-10【中】已发布手工端点的编辑/删除缺乏一致性

- 位置：`asset-catalog/service.ts:369-415`（update 不同步 route/profile、不校验发布态）；`417-428`（delete 不级联清理 membership/route/profile）
- 描述：更新改 method/path/baseUrl 不影响已建 gateway-route（发布后路径错位）；删除只删 endpoint + 孤儿 source asset，悬挂 membership/publishBinding/route/profile/audit，publication 查询随之抛 NotFound（`publication/service.ts:930-967` 的 require 链路）。
- 影响：发布稳定性差，历史绑定悬空，审计/列表出现 404。
- 建议：发布态校验与受限编辑；删除时级联清理（或软删 + 提示先下线/清理）。

### A1-11【中】`packages/api-nova-ui/src` 为空目录，UI 运营闭环源码缺失

- 位置：`packages/api-nova-ui/`（仅空 `src/` 与预构建 `dist/`）
- 描述：仓库内无任何 UI `.vue/.ts` 源文件，仅存在构建产物。文档宣称的 manual registration / governance / publication workbench 页面在源码树中不可见。
- 影响："手工注册 → 发布"的运营界面在源码层面不存在，无法追踪与复现 UI 行为。
- 建议：恢复/补齐 `api-nova-ui/src`（或明确外部交付来源与版本对应），否则按文档口径 UI 能力无法交付。

---

## 4. 整改跟踪

> 整改日期：2026-09-04，整改人：开发。以下状态已同步回写本表；运行级 E2E 复核待本机环境（jest/pnpm 依赖）恢复后补充。

| 编号 | 问题摘要 | 严重度 | 整改状态 | 整改日期 | 整改人 | 验证/备注 |
| --- | --- | --- | --- | --- | --- | --- |
| A1-01 | MCP 工具输入 Schema 为空且禁止传参 | 高 | `已整改` | 2026-09-04 | 开发 | 手工注册 DTO 支持 `parameters`/`requestBody` 简化模板，写入 `rawOperation`，MCP 装配自动透传 |
| A1-02 | MCP 工具名含 `/`，违反规范 | 高 | `已整改` | 2026-09-04 | 开发 | parser `generateToolName` 对 operationId 清洗（非法字符→`_`，折叠，截断 64）；runtime-assets 合成 operationId 同步清洗 |
| A1-03 | query/body 无法透传，代理不可用 | 高 | `已整改` | 2026-09-04 | 开发 | 随 A1-01 一并解决（模板写入 rawOperation 后 parser URL/query/body 透传生效） |
| A1-04 | 带 path 参数端点无法过就绪门禁 | 中 | `已整改` | 2026-09-04 | 开发 | probe/test 对 `{param}` 做示例值替换（metadata.testParameters > 参数 example > 默认值） |
| A1-05 | MCP 发布后不自动 start | 中 | `已整改` | 2026-09-04 | 开发 | `PublishEndpointDto.autoStart`（默认 true）→ 发布后 deploy+start，失败返回 `start_failed` 提示 |
| A1-06 | Gateway 无默认建路由行为 | 中 | `已整改` | 2026-09-04 | 开发 | `PublishEndpointDto.autoConfigureRoute`（默认 true）→ 发布前按 method/path 自动建默认路由（internal） |
| A1-07 | Gateway accessUrls 为空/失真 | 中 | `已整改` | 2026-09-04 | 开发 | accessUrls 回退为 `{API_BASE_URL}/api/v1/gateway/{path}`（未配置则相对路径） |
| A1-08 | routeVisibility 只存不查 | 中 | `已整改` | 2026-09-04 | 开发 | gateway authorize 对 internal 路由强制 JWT（禁止 anonymous） |
| A1-09 | 转发无守卫/匿名默认，openapi 公共端点泄露上游信息 | 中 | `已整改` | 2026-09-04 | 开发 | 默认 internal→匿名被拒；openapi 控制器挂 `JwtAuthGuard` 并移除类级 `@Public()` |
| A1-10 | 已发布端点编辑/删除不一致 | 中 | `已整改` | 2026-09-04 | 开发 | active 发布态禁改 method/path/baseUrl、禁删；非 active route 自动同步；删除事务级联清理 membership/publish-binding/route/profile/history/audit |
| A1-11 | api-nova-ui 源码缺失 | 中 | `已整改` | 2026-09-04 | 开发 | 从 git HEAD 恢复 122 个 UI 源文件到 `api-nova/packages/api-nova-ui/src` |

---

## 5. 说明与限制

- 本次为**静态代码审查**，未运行时验证；个别结论（如 MCP 客户端对空 schema / 含 `/` 工具名的实际表现）建议以端到端联调复核。
- 未修改任何代码；本报告只记录现场结论，状态变更统一回写 [README.md](./README.md) 与本节跟踪表。