---
doc-version: 1.0.1
doc-status: active
doc-updated: 2026-10-20
---
# 顶部健康、页面刷新及文件导入补验

## 修改与范围

基于oc_dev/5295fe4，修复顶部健康模拟值与通用刷新空实现。健康读取根路径`/health`，兼容Terminus原始响应及HttpExceptionFilter的503封装；真实异常显示error，网络/格式异常显示unknown，初始不假报healthy。Vite代理相同路径，30秒真实轮询且卸载清理；并发请求共用一次检查。

布局读取响应式store，刷新调用当前页面暴露的loader，不重建页面、不清除输入。批量/手工注册、治理、发布、运行资产列表/详情及监控接入；其他页面明确只刷新健康。等待两类请求全部结束，失败不报成功；页面loader失败向布局传播。修复刷新异常分支调用不存在captureError导致的二次异常。监控手动刷新使用manual原因，避免被自动轮询节流跳过。

文件导入浏览器用带绝对server URL的JSON文件，通过真实UI上传并验证持久化的文档/端点/实例，再完成同一Gateway闭环。不能外推无server、认证规范或多角色支持。

## 验证记录

- UI脚本回归89/89，其中新健康/刷新专项6项；覆盖200/503/包装503、错误响应、未知初始状态、断网去除旧健康、并发合并、页面失败及loading恢复。
- UI生产构建和类型检查通过；UI lint为0 error、78 warnings。
- 打包UI文件导入+健康刷新：22/22，`.tmp/ops-01-browser-jPbNuX/evidence.json`。
- 打包UI手工注册：19/19，`.tmp/ops-01-browser-0oTjDz/evidence.json`。
- 打包UIURL导入：19/19，`.tmp/ops-01-browser-gYi8BN/evidence.json`。
- Vite文件导入+健康刷新：22/22，`.tmp/ops-01-browser-RB9Xmu/evidence.json`。
- 最终UI构建修正监控手动刷新原因后，打包文件导入+健康刷新再次22/22：`.tmp/ops-01-browser-ZtAKEp/evidence.json`，增加顶部刷新保留搜索筛选的断言。该轮记录的commit为当时5295fe4父提交，并包含后续提交为afc7954的工作树；最终发布CI在afc7954执行完整门禁，见[发布审计](./2026-10-20-release-v1.7.6-rc.4.md)。
- 健康集成用真实后端503对照徽标；另用浏览器响应注入验证200→503→断网→200，不能将注入视为实际MCP启停证据。列表500故障不报刷新成功，恢复后重新请求列表。
- 首轮`.tmp/ops-01-browser-jsXitL`失败，原因是未识别后端503封装及错误处理器方法不存在；修复后以上重跑通过，不将失败轮计为通过。
- 10-20生产依赖审计：10 moderate、0 high/critical；保留原SEC维护事项。

本机Node、Edge、构建哈希、工作树、独立SQLite路径、端口及清理结果分别在evidence.json。正式发布门禁和三平台证据另记本版本发布审计，不用本机浏览器测试替代生产签收。

## 待办整理

历史209叶子仍为204 DONE、2 IN_PROGRESS、1 WAIT_DEP、2 DEFERRED。已完成修复移出当前队列，文件导入仅关闭本次有界覆盖缺口。新增确认LogViewer.loadLogs仍构造mockLogs，列为UI维护；目标生产矩阵、延期需求、依赖维护及非阻断压力诊断继续归原任务。不重复立项，不因旧交接快照重新开发已完成能力。
