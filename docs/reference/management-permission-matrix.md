---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-10-26
---
# 管理权限与资源范围

管理JWT、运行时消费凭据和上游认证分属不同信任域。本文给出当前权限族；每个HTTP操作的声明权限从控制器元数据生成在[接口清单](../api/ENDPOINTS.md)，服务内动态授权仍必须满足。

| 操作族 | 常用声明 | 额外边界 |
| --- | --- | --- |
| 读取源资产/端点/运行资产/成员 | server:read | 当前身份和可访问资源 |
| 探测、测试、治理及部分profile维护 | server:update | 当前对象、状态与有效证据 |
| 注册、成员装配、绑定、部署/启停、消费凭据创建和撤销 | server:manage或具体操作权限 | 角色、资源及部署合同；不能以read推导 |
| 删除运行资产 | 对应delete/manage声明 | 具体控制器元数据及关联状态 |
| 查看统一调用/事件/统计 | monitoring:read | 当前资产范围；global/scoped不是相同能力 |
| 查看正文/IP等受限信息 | monitoring:payload:read / monitoring:source:read等 | 在基础读取与资源权限之上执行 |
| 订阅/投递管理 | monitoring:subscription:manage；retry另需delivery:retry | 订阅owner/revision、当前范围、状态及幂等 |
| 策略/调用者标签维护 | monitoring:manage等具体声明 | 全局范围或当前资源交集，见可观测API |
| 用户/角色/权限/配置等管理 | 各控制器RequirePermissions/角色/超级管理员条件 | 不笼统授予所有已登录用户 |

显式Public元数据只表示该入口跳过相应管理Guard，不代表无输入校验、无限流或允许任意操作。OpenAPI清单里的“控制器/服务校验”不表示匿名可用；看不到权限装饰器也不能忽略服务内校验。

管理JWT失效按401处理，权限/范围不足按403或接口定义的受控错误处理。签名游标、前端缓存、资源ID和已建立Socket连接都不是新的授权凭据；续页和推送会按各自合同重新检查。

端点测试二进制下载要求server:manage及当前样例/对象校验，不能按普通server:read样例列表权限推导。消费运行资产需独立运行时身份和工具/路由范围。更多字段及错误语义见[安全合同](security-contract.md)、[可观测API](../api/observability.md)。
