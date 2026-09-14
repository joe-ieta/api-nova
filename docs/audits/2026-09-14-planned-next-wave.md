---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-14
---
# 按规划推进：策略、状态覆盖与凭据管理

本轮沿用[前一波依赖安排](./2026-09-14-active-task-dependencies.md)，保留工作区已有修改，并行交付以下切片。

| 任务 | 本轮交付 | 剩余依赖 |
| --- | --- | --- |
| OBS-TP14 | API27/28新事件留存；持久生效、If-Match并发保护、全局权限交集及同事务审计 | 正文/配额/完整生命周期及安全GC |
| OBS-TP10 | 授权目录、业务事实及历史报告覆盖；缺目录/缺资产身份/类型不符可见 | 真实周期心跳和资产映射、长期覆盖 |
| SEC-C3 | 同一Registry固定源管理status/reload；当前JWT权限、generation、意图/结果审计 | Watch、资产数据库归属、多进程；E1另需可信MCP映射与网络边界 |
| OBS-TP15 | 公开能力/事件/正文链接与main共享/api前缀；真实模块HTTP/Swagger验证 | 旧消费者迁移、完整身份/拒绝审计及全链路部署切换 |

策略仅支持新统一事件eventDays，默认14、范围1–365；invocation/projection/subscription.test共用。已有TTL不变、投递30天不变、不自动清理。服务器无业务证据不等于离线，heartbeat保持未知。凭据重载审计先记意图，结果审计失败返回实际generation而不假称回滚。

## 验证

- API构建PASS：tmp/planned-next-api-build-final.log。
- OBS十二脚本首轮188/191：三项旧接口计数/前缀断言失败，证据保留于tmp/planned-next-observability-tests.log。
- 同一联合门禁修正后191/191，0失败/取消/跳过：tmp/planned-next-observability-final.log。包含策略6项、覆盖20项，不重复相加。
- Gateway全量17套176/176，句柄检测正常退出：tmp/planned-next-gateway-tests.log。包含新管理接口15项。
- 策略事务/权限/生产者覆盖经独立只读复核，未发现阻断项。

环境为Windows、本地SQL.js、回环HTTP/Socket.IO和合成文件/凭据。没有新增表或更改初始化结构，未操作业务数据库/生产配置，未部署。

## 当前状态与下一顺序

OBS：DONE10、IN_PROGRESS5、BACKLOG1，TP15从BACKLOG转为IN_PROGRESS；HTTP28/28仅为已实现限定契约验证，AVAILABLE=0。安全仍DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。合计39包：DONE11、IN_PROGRESS23、BACKLOG4、DEFERRED1；未新增整包DONE。

下一步仍按已批准依赖：TP14完整策略消费与安全GC；TP10真实生产者心跳，供TP13全局状态快照使用；TP13/15旧消费者迁移；安全E1可信映射/共享Resolver及D1/F3发送网络边界。最终TP16/SEC-F4须针对完成后的整合版本验证PostgreSQL/Linux、多进程、容量与发布环境，不以局部切片替代整体验收。
