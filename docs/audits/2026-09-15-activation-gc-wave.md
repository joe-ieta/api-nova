---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-15
---
# 候选激活与GC重试

本轮并行修复候选激活、GC失败重试，并整理总验收文档。新增成果本地提交，未推送；远端仍7ea27a0。

## 完成切片

- MCP旧激活只检查PASSED，deploy又可能保存旧asset抹掉新失效标记。现激活比较active/previous revision、记录binding的membership/id/revision/active状态，拒绝缺失/非法/重复记录；required失效标记缺时间、非法时间或不早于计划时间也拒绝。固定MCP_CANDIDATE_STALE，历史缺记录候选需重新规划验证。事务重读asset合并部署信息，SQL.js验证旧候选失败时前置server写入与asset/run均回滚。
- GC扫描成功后删除失败会消费游标导致下批跳过对象。collect异常时在释放fence前closeScanner，关闭异常不替换原错误；磁盘上仍存在的候选可在下一批立即重试。unlink成功但元数据事务回滚的过期残留尚需独立整理；expiry检查仍阻止读出正文。
- completion-review与task-plan已按最新证据修正实时流、策略/GC和UI恢复的笼统待实现表述；稳定接口切片可先行验证，整包仍遵守硬依赖退出。未改变任务计数/API数量/批准退出条件。execution ledger历史Socket.IO断言已明确时点。

## 验证

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| API整包构建 | PASS | tmp/activation-gc-20260915-api-build.log |
| MCP归属/上游/装配/验证/激活七套 | 101/101 | tmp/activation-gc-20260915-mcp-tests.log |
| 正文/容量/retention/pipeline | 60/60 | tmp/activation-gc-20260915-obs-tests.log |
| GC失败复现 | 修复前新增用例失败，修复后容量11+retention10全部通过 | .tmp/obs-gc-retry-before-20260915.log、.tmp/obs-gc-retry-regression-20260915.log |

专项计数已包含联合，不累加。SQL.js仅验证观察到旧候选后的事务回滚，不证明跨进程CAS；无manager入口同样检查，但不宣称其多次写入具有调用方事务。时间戳采用>=保守拒绝同毫秒，仍不涵盖未标记修改或计划前混读。未连接真实业务库、启用生产GC、访问秘密或部署。

## 状态与下一依赖

OBS16：DONE10、IN_PROGRESS5、BACKLOG1；安全23：DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。合计39：DONE11、IN_PROGRESS23、BACKLOG4、DEFERRED1，无新增整包DONE。HTTP28/28限定VERIFIED，AVAILABLE0。

剩余：跨进程CAS和完整候选快照、受管启动可信传递/撤销；GC过期元数据残留整理、完整配额/生命周期与全平台验收。
