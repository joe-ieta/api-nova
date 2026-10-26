---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-15
---
# 发布读取与停机收敛

沿用前轮依赖，三路并发实现并独立审查；本轮新增内容整理为本地提交，未推送。远端仍为已授权推送的7ea27a0。

## 完成切片

- MCP单语句增加membership唯一publish绑定和MAX(version) profile。已有membership/version唯一索引防止历史版本乘行，相关子查询只生成SQL不另发查询。装配删除两类独立读取，保留publishedToMcp OR active与最高version描述选择；publicationProfileId不改变旧语义。上游解析、验证/激活仍独立。
- OBS扫描器停机原先可能在await opendir期间提前销毁并遗留后到Dir。新增停止门闩，等待在途scan再关闭，重复销毁幂等，停止后拒绝新scan；正常并发仍STORAGE_BUSY。新增用例先失败复现，修复后确认实际Dir关闭。
- UI策略load的Promise.all一路失败后，原finally清除超时而遗留另一路GET。现取消同轮剩余请求；回归覆盖412重读失败、无PATCH重放和随后重读恢复，身份代次保护保留。

## 验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| API整包构建 | PASS | tmp/publication-shutdown-20260915-api-build.log |
| MCP最终4套 | 63/63 | tmp/publication-shutdown-20260915-mcp-tests.log |
| 正文/容量/保留/pipeline | 59/59 | tmp/publication-shutdown-20260915-obs-tests.log |
| UI联合4脚本 | 37/37 | tmp/publication-shutdown-20260915-ui-tests.log |
| UI类型检查 | PASS | 子任务vue-tsc输出 |
| 停机修复前 | 原9项通过、新1项失败 | .tmp/obs-scanner-shutdown-before-20260915.log |
| 停机修复后专项 | 容量10/10+retention10/10 | .tmp/obs-scanner-shutdown-regression-20260915.log |

专项与联合集合重叠不累加。MCP用真实SQL.js，PostgreSQL仅driver离线SQL引用/占位符验证（复用已加载实体列名metadata），未连接服务或验证PostgreSQLschema。无真实业务数据库/秘密/部署操作，GC默认关闭不变。

## 完成状态

OBS：DONE10、IN_PROGRESS5、BACKLOG1；安全：DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。合计39：DONE11、IN_PROGRESS23、BACKLOG4、DEFERRED1。HTTP28/28仍限定VERIFIED，AVAILABLE0，无新增整包DONE。

下一依赖：上游选择与捕获规格的一致性、候选验证/激活版本保护、受管进程可信映射传递和运行中撤销；OBS完整配额/生命周期及业务健康验收继续独立推进。
