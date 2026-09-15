---
doc-version: 1.3.0
doc-status: active
doc-updated: 2026-09-15
---
# MCP可信操作身份映射

可信操作身份表由受信任进程代码注入。仅配置映射时不做凭据授权；现在可另显式选择single-hop共享Resolver发送模式。两者都不替代数据库资产归属核验。

```ts
import { transformToMCPTools } from 'api-nova-parser';
const tools = transformToMCPTools(spec, {
  trustedOperationBindings: [{
    method: 'GET', path: '/items/{id}',
    endpointDefinitionId: 'endpoint-123',
    sourceServiceAssetId: 'source-456',
  }],
});
```

映射由可信应用代码提供，不能从Tool参数、OpenAPI x-*或未验证外部输入直接构造后称其可信。Server的core Transformer options和transformOpenApiToMcpTools末尾可选参数均透传；未配置该选项保持原入口行为。

编译器验证method/path对应spec实际operation，规范化method、拒绝重复/未知绑定；已选择输出的operation缺失映射时整个转换失败，不静默丢工具。注册表复制并冻结，标准HTTP handler闭包固定身份，后续输入对象、OpenAPI扩展或调用args不能改变Endpoint/Source Asset关联。启用运行审计上下文时这两个可信ID优先于扩展及上下文旧值。

该能力不校验数据库中两个ID的归属，不选择凭据，不证明目标URL授权。自定义customHandlers不经标准HTTP发送路径，不能外推同样保证。已可显式选择下面的单跳共享Resolver模式；自动逐跳复验及CLI托管秘密移除仍属E1/C4/F3剩余项。

Parser映射及全量回归、两个Server转换入口的验证证据见[本轮执行记录](../audits/2026-09-14-routing-policy-mapping-wave.md)。

## 显式单跳凭据模式

可信宿主可在Transformer options中传入 `upstreamCredentialPolicy: { mode: 'single-hop', captureSnapshot: () => registry.captureSnapshot() }`（captureSnapshot返回Registry的冻结快照）。必须同时配置trustedOperationBindings。Server两个进程内转换入口均透传；不从Tool输入或OpenAPI启用。

每次标准HTTP调用捕获一次快照，使用闭包内Endpoint/Source Asset及目标URL调用共享Resolver，失败在Axios调用前返回固定UPSTREAM_CREDENTIAL_UNAVAILABLE。剥离消费者认证及全部候选托管API Key名称后，仅注入当前结果；None不回退旧env引用或authManager；single-hop使用独立customHeaders配置并禁用旧env provider，原配置后续修改不恢复该提供器。私有Axios实例隔离全局interceptor，并清除继承的认证/请求头/参数等默认值。宿主adapter/序列化扩展仍须可信，不声称抵御恶意宿主传输代码。

本模式固定maxRedirects=0，将3xx作为响应返回，不自动把秘密或正文带到下一跳；legacy仍保留既有跳转行为。自定义handler不允许绕过此模式；构造时检查全部自有键，运行期拒绝后加自有项且不求值getter，原型方法名仍走标准HTTP。传输错误返回固定UPSTREAM_REQUEST_FAILED，不回传包含秘密的异常文本。该模式不是自动逐跳授权，不提供业务DNS/SSRF或完整Header allowlist，也不证明生产MCP托管启动链已切换。
## 管理侧资产快照生成器

API 的 runtime-assets/services/mcp-trusted-operation-bindings.ts 提供 createMcpTrustedOperationBindings(runtimeAsset, selectedRows, spec)。每行包含 membership、endpoint、sourceAsset，必须来自可信管理代码捕获且用于装配同一规格的实体行；此函数自身不访问数据库，也不证明这些行来自一致事务。校验 membership.runtimeAssetId、membership.endpointDefinitionId、endpoint.sourceServiceAssetId 对应关系、UUID、已有启用/生命周期状态，并要求所选行与 spec 操作完整一一对应。返回冻结的 TrustedOperationBinding 数组，拒绝统一为 INVALID_MCP_OPERATION_OWNERSHIP。

OpenAPI 扩展不能覆盖关系身份。成员停用后重新读取并生成会拒绝，但已有映射保持原快照；发布授权、持续撤销及托管启动链仍待接入。生成器初始专项 19/19、API 构建通过，见[前轮记录](../audits/2026-09-14-commit-ownership-wave.md)。2026-09-15装配接线范围及验证见后续执行记录；数据库事务一致性和生产托管启动链仍须单独实现。


2026-09-15：assembleMcpRuntimeAssetPayload 已调用生成器并向 Server 转换入口传递映射；用 structuredClone 捕获查询返回值，选中行缺实体即拒绝。当前只是捕获行内部归属核验，不是一致事务。3套50/50和API构建通过；受管进程启动仍未接入，详见[装配接线记录](../audits/2026-09-15-mcp-assembly-ownership-wave.md)。
