---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-26
---
# 开发API手册与接入约定

本手册面向自定义UI、运维集成和业务应用。管理API由api-nova-api提供；Gateway和MCP是发布后的消费入口，认证与生命周期各自独立。当前控制器快照包含227个路径、267个HTTP操作、232个DTO schema；完整列表见[接口清单](ENDPOINTS.md)，字段与示例见[OpenAPI JSON](openapi.json)。

## 地址与认证

| 面 | 默认地址/前缀 | 身份与用途 |
| --- | --- | --- |
| 管理API | `http://127.0.0.1:9001/api` | 管理JWT、角色、权限及资源范围；登录等显式公开入口除外 |
| 资产/测试/发布 | `/api/v1/assets`、`/api/v1/runtime-assets`等 | v1是具体路由组成，不是所有管理API统一版本前缀 |
| 统一可观测性 | `/api/monitoring/observability` | monitoring细分权限和资产范围，响应信封独立 |
| HTTP Gateway | `/api/v1/gateway/<已配置route>` | 运行时消费凭据及发布策略，不使用管理JWT替代 |
| MCP | 独立监听；默认9022/mcp或实际发布地址 | 协议认证、工具权限、会话与撤销；stdio无HTTP URL |
| 实时管理 | Socket.IO `/monitoring` namespace、`/socket.io` path | 管理token及专用订阅协议，不属于MCP transport |

管理请求一般使用`Authorization: Bearer <accessToken>`；API Key不是管理JWT的替代品。管理权限由控制器和服务共同执行，路径可见不保证当前用户可操作；细则见[权限矩阵](../reference/management-permission-matrix.md)。

## 最小调用示例

以下为Bash/curl示例，服务需已按[部署手册](../guides/DEPLOYMENT.md)启动。密码由使用者输入；响应内容只留在本地，不将token提交到代码或日志。

```bash
BASE=http://127.0.0.1:9001
curl --fail-with-body "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"<管理用户名>","password":"<管理密码>"}'
```

登录成功直接返回含`accessToken`、`refreshToken`、`user`等字段的对象，不包在统一data中。将返回的accessToken设为本地ACCESS_TOKEN变量后（refresh示例用实际刷新令牌替换占位符）：

```bash
curl --fail-with-body "$BASE/api/v1/assets/source-services" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
curl --fail-with-body "$BASE/api/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<刷新令牌>"}'
```

刷新返回新的token，客户端需要替换旧refreshToken；进程内刷新会话状态不构成跨重启/多实例会话持久化承诺。401可走受控刷新或重新登录；403先核对资源与权限，不能循环刷新绕过。

PowerShell可用`Invoke-RestMethod`及`ConvertTo-Json`构造同样请求；不要将curl示例的Bash变量语法直接贴入PowerShell。

## 主流程API导航

| 阶段 | 已有入口 | 接入注意事项 |
| --- | --- | --- |
| 规范 | `/api/openapi/parse`、validate、normalize、upload；`/api/documents` | JSON DTO与multipart按具体接口区分；字段以快照/源码为准 |
| 目录 | `/api/v1/assets/source-services`、`/api/v1/assets/endpoints` | 手工注册为`POST /api/v1/assets/endpoints/manual` |
| 实例 | `/api/v1/assets/source-services/{id}/instances` | 显式维护地址/认证，归档不是删除逻辑源资产 |
| 测试/治理 | 目录端点的probe、test、readiness、governance；`/api/v1/endpoint-testing` | 样例读取、修改和二进制内容权限不同 |
| 发布装配 | `/api/v1/publication/endpoints` | 候选、runtime-assets、memberships、profile、gateway-route、publish/offline |
| 上游绑定 | `/api/v1/runtime-memberships/{id}/upstream-binding` | 选择实例；失效证据不能作为新候选依据 |
| 验证 | `/api/v1/runtime-assets/{id}/verification-runs` | plan、证据读取、execute-gateway；遵循门禁，不用普通更新代替激活 |
| 部署/运行 | `/api/v1/runtime-assets/{id}`的deploy-gateway/deploy-mcp/start/stop/redeploy | 读取有效配置和返回地址；保存不等于启动 |
| 消费凭据 | 运行资产下runtime-access-credentials（兼容gateway-consumer-credentials） | 新建/撤销按server:manage及运行时范围执行；秘密不反复回显 |
| 日志/观察 | runtime-assets的access-logs/observability及统一可观测API | 请求ID关联与origin/时间窗，不能混用不同分页/响应结构 |
| 管理基础 | `/api/auth`、users、roles、permissions、audit、config、system | 公共入口、角色和管理员条件逐操作核对 |

运行面说明：[Gateway/MCP手册](mcp.md)、[发布合同](../reference/publication-contract.md)、[可观测API](observability.md)。

## 响应、错误与分页

成功响应存在不同族：认证直接返回token对象；部分管理API返回对象/数组或`success/data`；统一可观测API使用`status/data/meta`；二进制、SSE和204没有普通JSON对象。不要写一个全局“永远取response.data.data”的客户端。

通用HttpExceptionFilter常见错误为`{success:false,error:{code,message,details,timestamp,path,method,requestId}}`；统一可观测API另有`{status:"error",error:{code,message,...}}`。Gateway流已提交响应头后可能直接中断连接，不能假定总有JSON错误体。

| HTTP | 常见含义 |
| --- | --- |
| 400 | 参数/业务约束不符合；可观测查询有自己的INVALID_QUERY |
| 401 / 403 | 未认证或权限/资源范围不足；消费身份另按运行时协议 |
| 404 / 409 / 410 | 资源不存在、revision/幂等/状态冲突、已失效或到期 |
| 413 / 422 | 请求规模过大；DTO校验错误（全局whitelist且拒绝额外字段） |
| 429 / 503 | 限流；依赖/门禁/健康或运行面不可用 |

分页不是全局统一协议；普通管理列表和统一可观测签名游标分别按接口实现。可观测游标绑定当前身份、范围和过滤，不是授权凭据；详见[查询与事件](observability.md)。

## 接口清单与快照边界

`node scripts/export-api-docs.cjs`从已构建Nest控制器/DTO生成静态清单及JSON；`--check`核对漂移，并在隔离SQLite/回环临时端口验证上述登录、读取、匿名拒绝、刷新流程。元数据记录当前产品源码/配置/锁文件摘要，不把Swagger自身的version=source-snapshot当作产品版本。

Swagger可见性不是运行可用性或授权证明。DTO字段有注解缺口，部分服务返回结构没有完整schema；`x-apinova-*`补充显式Public、权限、角色、超级管理员及控制器Guard元数据，但服务内资源检查和动态许可不会全部出现在schema。兼容路由别名的operationId在快照中唯一化，原控制器标识保留于x-apinova-controller-operation。不可据此自动放行请求或无检查生成生产客户端。

动态Gateway通配路由、独立MCP监听、Socket.IO消息及部分排除控制器不在Swagger清单，相关协议在本套手册另列。源码运行且非production时可访问`/api/docs`、`/api/docs-json`；production关闭，离线包无需依赖在线Swagger。

当前API边界与风险见[open-items](../reference/open-items.md)；本轮没有新加接口、统一响应格式或改变原发布合同。
