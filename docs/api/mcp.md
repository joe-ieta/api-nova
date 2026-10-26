---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-26
---
# MCP与Gateway消费接入手册

管理API负责装配和授权；业务应用调用Gateway，模型/Agent调用MCP。它们共享治理资产和证据，协议、凭据及监听入口不同。产品受管发布优先按[使用手册](../guides/USER_GUIDE.md)操作。

## MCP传输和地址

| 传输 | 使用方式 | 入口 |
| --- | --- | --- |
| stdio | 客户端启动独立子进程，以stdin/stdout交换协议 | 没有HTTP URL；stdout需要保持协议安全 |
| streamable | MCP SDK/客户端连接HTTP | 独立默认9022、默认`/mcp`，受管地址读取部署结果 |
| sse | MCP客户端建立SSE及相关消息通道 | 默认`/sse`或受管配置；不当作普通JSON GET |

管理Socket.IO/WebSocket只提供监控与操作消息，不是MCP transport。HTTP `/health`只证明监听健康，不证明工具业务正确性。

## 独立CLI

在已安装根锁依赖并构建的仓库中执行本地例子，避免依赖未核实的公共npm发行版本：

```bash
node packages/api-nova-server/dist/cli.js --help
node packages/api-nova-server/dist/cli.js --openapi ./examples/minimal-openapi.json --transport stdio
```

MCP客户端启动配置可使用上述已构建CLI的**绝对路径**及固定工作目录。独立CLI不会自动把规范登记进产品管理数据库。

HTTP模式必须显式配置当前支持的入站JWT、API Key或Anonymous，与上游认证分开。`--auth-type`、`--bearer-env`等CLI选项针对上游认证，不配置MCP HTTP入口身份。不能复制一个省略运行时认证环境的HTTP示例就声称可用。

已有选项包括`--base-url`、`--endpoint`、`--host`、`--port`、操作过滤、自定义header、文件watch等；以当前`--help`和Server源码为准。secret应从获准的环境/Provider传入，不放进命令行明文示例。

## 受管MCP

通过管理API创建运行资产、成员及绑定；使用mcp-endpoint-preview、deploy-mcp、start及返回的有效地址。保存时默认autoStart=false不表示监听已成功。transport、port、endpointPath及入站模式影响候选/配置一致性。

使用真实MCP客户端完成initialize、tools/list、tools/call，并处理会话ID、身份到期和撤销；工具名及inputSchema读取服务实际列举结果。不得只用HTTP200或health来证明工具闭环，也不能跨用户复用会话。

当前SDK消费者使用根锁中的1.32.1；EXT-06验收器比较已安装SDK与锁文件，而非永久固定旧版本。25项本机限定复验含Streamable/SSE、受管child、权限和撤销；Linux/外部网络、API配置驱动受管生命周期、真实MCP二进制外发仍分别按台账记录。

## HTTP Gateway

入口为`/api/v1/gateway/<实际已发布route>`。路由不是端点原始path的任意透传；必须存在已发布成员和有效上游绑定。按运行资产配置创建并交付消费凭据，使用当前运行时支持的header方式；管理JWT不能替代该凭据。

客户端保留requestId用于关联资产access-logs和统一调用事实。流式响应可能在headers提交后断开，应按客户端传输错误处理；不能依赖每次错误都返回管理API的JSON信封。

多端点、A/B迁移、无凭据拒绝和凭据成功已有本机HTTP/浏览器证据；其他角色/认证/浏览器组合、目标TLS/代理/出站及生产签收仍开放。配置字段见[OpenAPI快照](openapi.json)中的部署、profile/route与凭据DTO。

## Parser库接入

如果应用只需要解析规范或构造工具，可以使用现有Parser导出，而不接管整个管理工作流。接口见[Parser手册](parser.md)。库处理能力不等于自动获得管理授权、运行时监听或生产发布资格。
