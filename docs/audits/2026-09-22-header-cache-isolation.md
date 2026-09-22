---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-22
---
# Header策略缓存隔离与真实命中验收

## 交付

SEC-D1-02C完成显式compiled v1路径的缓存隔离。沿用02B真实流执行器，Publication/Registry/冷恢复的生产NOT_READY门禁仍保留；02D负责真实入口安装、策略元数据接线、默认启用、迁移例外及防降级。

- [Runtime](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-runtime.service.ts)在每次命中前执行消费者授权/限流，再由Proxy准备一次当前可信凭据及原始Header校验；miss复用该次结果，重试重新解析，不能以缓存跳过禁用/过期/重复认证字段。
- [Cache](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-cache.service.ts)强制策略identity、可信调用身份、Accept/Accept-Language/Accept-Encoding及全部有效业务扩展入键；过滤后的值区分缺失和空串，配置只能增加合法业务vary。Provider动态材料epoch来自同批C1，秘密及秘密摘要不进入key。
- v1只缓存无正文且实际出站也是GET的请求；Range/If-*/Cache-Control/Pragma、分块或非零长度正文全部绕过读写。保留完整query顺序，不允许旧varyQueryKeys裁剪掉v1参数；消费者query认证值在key与上游URL中移除。
- Proxy保留原始Set-Cookie/Pragma/Cache-Control/Vary/Content-Type/Age信号，即使Connection提名使业务头被删除，也不能失去禁存依据。206/SSE/private/no-store/no-cache、无法解析/未知缓存指令、Vary=*或未覆盖字段、超限/截断和缺信号均拒绝入缓存。max-age/s-maxage及原始Age收窄TTL。
- 保存过滤后的业务响应头及原始实体字节；命中重新生成长度和请求ID，压缩不解码，204不生成非法Content-Length。响应实际凭据epoch不同于预检（如重试发生轮换）时不向旧key存储。

## 验证

| 验证 | 结果 |
| --- | --- |
| [真实HTTP缓存](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-cache.http.spec.ts) | 32/32；真实Runtime+Proxy+Cache，受控回环上游，鉴权/限流服务为stub但逐请求执行与拒绝有断言 |
| 最终API联合 | 30套428/428，detectOpenHandles，`.tmp/security-0922-api.log`，包含同批C1与旧Gateway/发布门禁 |
| 缓存/编排补充拒绝 | 原始信号缺失、过期/歧义TTL、重试材料变化、v1安全拒绝不重试；均包含联合回归 |
| 构建 | Parser、Server、API最终通过；API中间因Basic准备器单引用假设失败已在C1修复，准备验证32/32 |

真实HTTP验证miss→hit、gzip不同编码/原始bytes、必需头/策略/身份隔离、缺失与空值、Connection实际出站值、各类bypass与rawveto（含被剥离的SSE类型）、超限/截断后不可hit、缓存命中前Resolver失败及权限/限流拒绝。测试计数重叠，不能相加为新增场景数。

## 退出与剩余

本包关闭02C并解锁02D；H11在受控compiled v1路径有真实证据，H01–H12生产整合尚未关闭。不会把内存策略夹具推导为已迁移现有部署，也不把本地HTTP推导为F3 DNS/SSRF或跨平台验收。安全父包D1及D2保持原状态与依赖。
