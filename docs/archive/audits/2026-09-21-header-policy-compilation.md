---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# Header策略编译与安全接线准备

基线7702888，最终代码版本为包含本报告的提交。D1-02已按四个实际出口拆为02A/B/C/D，本报告仅交付02A。
Parser提供v1严格schema、每方向64项精确名称、基础集合/扩展、Site到Endpoint分方向继承与空数组替换、保留名/认证名冲突校验。编译结果冻结并带sourceId与SHA256 identity；Registry候选编译失败不换旧代，JSON/YAML使用同一编译器。
历史认证名仅在同一Registry进程跨成功代累积，失败候选不污染；持久化历史登记和迁移防降级仍归02D。源码允许捕获已编译元数据，不能据此声称已经执行Header过滤。
Gateway新增单一来源编译适配；Registry+inline冲突拒绝。由于02B/C执行器尚未交付，生产provider拒绝含Site/Endpoint v1候选；Resolver再次防守，路由编译/发布保存/冷恢复拒绝显式headerPolicy（含null或畸形），不退回legacy。既有无策略路径保持原实现。
## 验证
- npm test --workspace=api-nova-parser -- --runInBand --testPathPattern="credentials|header-policy"：10套294/294，exit0，日志.tmp/header-parser-final.log。
- API Header/provider/resolver/policy/publication联合10套89/89，exit0；后补删除策略更新与真实SQL.js冷恢复拒绝，Header/snapshot2套33/33，exit0，日志.tmp/header-cold-rejection-final.log。重叠计数不累加。
- Parser/API构建exit0；Server独立协议构建亦通过。本批未改数据库schema/migration/锁文件或生产配置。
- 真实固定文件+DB ownership工厂证明首次含v1启动拒绝、坏候选reload保旧；已持久快照含v1即使fingerprint自洽，SQLite导出/重开后也拒绝。
02A DONE；02B READY，下一步完成双向allowlist/rawHeaders/framing及真实字节传输。02C缓存与02D默认迁移仍WAIT_DEP。本报告不是Header保护上线、安全发布签收或SSRF完成。
