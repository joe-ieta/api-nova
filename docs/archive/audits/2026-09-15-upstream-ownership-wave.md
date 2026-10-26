---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-15
---
# 上游归属交叉核验

本轮三路并行检查实际依赖。实现集中于确认存在的跨源混读；其余两路未发现新问题，因此没有机械修改或扩大测试。新增成果整理为本地提交，未推送；远端仍为7ea27a0。

## 修复

旧MCP装配先捕获endpoint source A，resolve随后仅检验instance属于upstream binding.source。若binding已更新为source B，会出现A可信身份配B URL/credentialRef。现resolved和unresolved结果都携带runtimeAssetEndpointBindingId/sourceServiceAssetId；MCP调用方在构造URL和transform前核对捕获endpoint关系、返回membership、绑定source和实例source，缺字段同样固定拒绝MCP_UPSTREAM_OWNERSHIP_MISMATCH。

真实resolver（合成仓储返回）→assembly回归覆盖跨源拒绝和同源正常，无真实HTTP发送。防护不锁定同源revision，不代替一致事务、发布激活版本保护、生产受管启动或撤销。原Gateway调用resolve的行为未切换。

## 验证与复核

- API目录 npx jest runtime-assets-mcp-ownership.spec.ts runtime-assets.service.spec.ts runtime-upstream-bindings.service.spec.ts mcp-ownership-reader.spec.ts mcp-trusted-operation-bindings.spec.ts --runInBand：五套76/76，子任务工具输出。包含新增返回字段兼容回归。
- npm run build --workspace api-nova-api：PASS，tmp/upstream-ownership-20260915-api-build.log。
- OBS只读复核：Nest同模块provider销毁并行、数据库后续关闭；扫描前/中/后停止均由扫描门闩、worker等待和GC finally租约释放收尾。未发现新增缺陷，沿用上一轮20项证据，没有声称本轮重跑。
- Gateway分页复核：筛选/身份变化废弃旧响应，历史页不被轮询覆盖，错误清行与游标；既有专项6/6通过，无新增修改。

## 状态

OBS16：DONE10、IN_PROGRESS5、BACKLOG1；安全23：DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。合计39：DONE11、IN_PROGRESS23、BACKLOG4、DEFERRED1，无新增整包DONE。HTTP28/28限定VERIFIED，AVAILABLE0。

下一依赖仍为同源版本与候选验证/激活一致性、受管进程可信传递及运行中撤销。未运行真实业务库、生产GC、部署或访问真实秘密。
