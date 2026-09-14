---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-14
---

# Gateway 上游凭据文件激活

## 已实现范围

GatewayRuntimeModule 已注册异步 Registry 和 Resolver Provider。配置齐备时，Nest 在构造 Resolver/Proxy 前完成文件读取、Schema 校验、环境核对和全部凭据 Dry Resolution。文件或 Secret 无效会使 API 启动失败，错误固定为 gateway_upstream_credential_configuration_failed。

这条链路属于 TP-C3/TP-C4 的进程内手动装载切片。受权Reload/状态API及意图/结果审计已实现；Watch/Debounce、资产归属数据库核验及多进程分发尚未完成。文件中的 reload.mode 必须为 manual，watch 会被明确拒绝。

## 启用配置

| 配置项 | 要求 |
| --- | --- |
| API_NOVA_UPSTREAM_CREDENTIAL_FILE | 本机配置文件的绝对规范路径；普通文件，禁止路径别名、符号链接、目录联接和硬链接 |
| API_NOVA_UPSTREAM_CREDENTIAL_FORMAT | 明确指定 json 或 yaml，不从扩展名推断 |
| API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT | 与配置 metadata.environment 一致的环境标识，建议使用小写 |

三个配置项全部未设置时维持已有 env-headers 路径。任一配置项出现（包括空字符串）后，必须完整、有效地设置全部三项；失败不会回退至旧凭据路径。

这三个配置项通过现有 ConfigService 读取，遵循 API 现有环境配置文件加载顺序。当前只在 Gateway 进程生效，MCP 不会自动消费它们。配置装载完成后，每个 Gateway 请求从同一个 Registry 捕获当前不可变快照，并使用该快照完成 Site/Endpoint 匹配及 Secret 解析。

配置文件仅保存 Secret Reference。运行账号需要在环境中具有所引用的 Secret，或能够使用受支持的 File Provider。真实 Linux File Provider 权限仍需按下文操作补证；Windows ACL Provider 尚未完成，不能把配置文件可读取等同于 Secret File Provider 可用。

## 最小 JSON 结构

以下内容是示例，sourceServiceAssetId 和 endpointDefinitionId 必须替换为实际资产 ID，host/basePath 必须与实际上游一致。SYNTHETIC_UPSTREAM_TOKEN 是环境变量名称，不是实际秘密。

~~~json
{
  "apiVersion": "security.apinova.io/v1",
  "kind": "UpstreamCredentialBindings",
  "metadata": { "revision": "orders-r1", "environment": "production" },
  "reload": { "mode": "manual", "debounceMs": 0, "rejectPlaintextSecrets": true },
  "secretProviders": { "processEnv": { "type": "env" } },
  "credentials": {
    "orders": { "type": "bearer", "secretRef": "processEnv:SYNTHETIC_UPSTREAM_TOKEN" }
  },
  "sites": [{
    "id": "orders",
    "sourceServiceAssetId": "replace-with-actual-asset-id",
    "match": { "scheme": "https", "host": "orders.example.com", "port": 443, "basePath": "/api" },
    "allowedHosts": ["orders.example.com"],
    "credential": "orders",
    "endpoints": [{
      "endpointDefinitionId": "replace-with-actual-endpoint-id",
      "credential": "orders"
    }]
  }]
}
~~~

## 稳定读取与重载

- 文件最大 1 MiB，按有界缓冲区读取；非法 UTF-8 拒绝处理。
- 两次完整采样间隔 50 ms，每次核对打开前、句柄和读取后的文件身份、大小、时间戳、mode、link count，再比对两次内容。
- 采样期间原地写入、原子替换或内容变化会拒绝本次装载；不自动重试，也不会将半成品激活。
- reloadFile(path, format)、reloadText(text, format) 和 reload(object) 共用同一重载锁。文件 I/O 开始前即持锁，重叠调用返回 RELOAD_IN_PROGRESS。
- 装载失败保留上一快照。CONFIGURATION_READ_FAILED 和 CONFIGURATION_UNSTABLE 为静态文件诊断码，Registry 状态不暴露原始文件路径或 Secret。
- 手动替换文件应先在受控目录生成完整文件并原子替换，再调用下述受权Reload接口或重启API。每次成功更新需要新的 metadata.revision。
- 双次采样只证明观测窗口内的稳定性，运行账号及配置目录/挂载必须由可信宿主管理；不构成对恶意文件系统或特权并发修改者的隔离保证。

## 下一依赖及外部补证

当前启动装载切片已打通。MCP 仍需连接共享 Resolver，明确工具使用的 Source Asset/Endpoint 标识和实际发送目标，再接入逐请求凭据解析。D1 业务 Header Allowlist、F3 redirect/DNS/SSRF 的决策与验收矩阵见[Header 与网络边界契约](./security-header-network-boundary-contract.md)。

Linux 补证按[Provider Linux 隔离专项](../testing/upstream-secret-provider-linux.md)执行：启动 Docker Desktop 的 Linux containers，选择已批准且本地存在的 Node.js 20+ Linux 镜像，运行文档中的无网络只读容器命令，保留镜像标识、Node 版本、退出码与完整日志。当前脚本预期为 82 通过、1 项不支持平台测试跳过；这只是验收目标，不能记为本轮实测结果。无需提供真实 Secret、业务数据库或上游网络服务。
## 管理状态与手动重载

GET /api/security/upstream-credentials/status 需要有效管理JWT及config:read；POST /api/security/upstream-credentials/reload需要config:update，权限按当前用户重新读取。两接口均返回Cache-Control:no-store，状态不返回配置路径、Secret Reference或秘密值。

操作顺序：先读取generation；在受控目录按前述规范更新同一配置文件及metadata.revision；POST JSON `{ "expectedGeneration": 1, "reason": "轮换上游凭据" }`，其中generation取实际读取值。请求不能包含file/path/format/secret；reason必须1–500字符且无控制字符。并发重载或generation冲突返回409，重新读取状态后处理。

重载前必须持久化pending意图；文件/候选/Secret校验失败保留旧快照并记录失败。成功记录新generation。若结果审计写入失败，返回503 RELOAD_AUDIT_UNAVAILABLE及实际generation；这不等同于未激活或已回滚，先检查状态/审计，勿直接按旧generation重复操作。reason仅记录存在性与SHA256摘要。

当前仅进程内生效，未提供Watch、跨进程一致切换或资产数据库归属核验。验证为合成配置/秘密与本地HTTP，不是生产配置操作；证据见安全执行台账第20节。
