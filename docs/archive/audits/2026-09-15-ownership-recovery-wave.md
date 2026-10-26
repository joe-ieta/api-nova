---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-15
---
# 单查询归属与故障恢复

用户明确授权后，7ea27a0成功推送到https://github.com/joe-ieta/api-nova.git的main，远端确认为7ea27a08be32b095a3b2efd72d85127528efe792。本轮随后三路并发实施，父级独立审查、统一API构建和后端回归。本轮新增改动整理为本地提交，尚未推送。

## 完成切片

- MCP：readMcpOwnership单SELECT/LEFT JOIN读取runtime、membership、endpoint、source并接入assemble实际路径，替代归属N+1查询。SQL.js真实实体验证SELECT数为1，保留悬空关联、区分不存在和空runtime、排除其它runtime成员。10001行哨兵拒绝溢出，不返回截断安全映射。profile/publication/upstream仍独立读取，未宣称整体一致事务或生产撤销。
- OBS：Dir读取失败可能永久复用失效句柄，stat错误可能令下次跳过失败对象；新增2例先复现失败。扫描异常时关闭并清空游标，保持失败shard和原错误，下次从分片边界重开。失败批无成功scanUsage，不新增扫描器或开启真实GC。
- UI：畸形capabilities不再造成未处理拒绝，独立显示错误且可恢复；合法not_implemented/null保持兼容。pipeline仅等待capabilities，与servers并行，避免慢来源连带失败。身份代次与登出迟到响应隔离仍保留。

## 验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| API整合构建 | PASS | tmp/ownership-recovery-20260915-api-build.log |
| MCP最终4套 | 56/56 | tmp/ownership-recovery-20260915-mcp-tests.log |
| 正文/容量/retention/pipeline联合 | 58/58 | tmp/ownership-recovery-20260915-obs-tests.log |
| UI四脚本联合 | 36/36 | tmp/obs-ui-diagnostics-recovery-tests.log |
| UI类型检查 | PASS | 子任务vue-tsc工具输出 |
| 扫描修复前复现 | 原7通过，新增2失败 | .tmp/obs-capacity-recovery-before-20260915.log |
| 扫描修复后专项 | 容量9/9、retention10/10 | .tmp/obs-capacity-retention-recovery-20260915.log |

最后两行与58项存在重叠，不重复累加；MCP前期55项与单reader6项由最终56项统一覆盖。测试仅SQL.js、合成文件和注入请求，未部署、未读取真实秘密；PostgreSQL/Linux/多进程及生产一致性仍待验收。

## 完成状态与下一依赖

OBS16：DONE10、IN_PROGRESS5、BACKLOG1。安全23：DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。合计39：DONE11、IN_PROGRESS23、BACKLOG4、DEFERRED1，无新增整包DONE。HTTP28/28限定VERIFIED，AVAILABLE0。

下一依赖是发布资格/profile/upstream读取与候选验证的一致性、受管进程可信传递及撤销。OBS整体配额/生命周期、真实业务健康和完整平台验收仍未闭合。
