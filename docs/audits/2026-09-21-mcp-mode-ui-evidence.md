---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-A1-02B4鉴权模式界面交付

三模式显式选择与保存回填、预览模式核对、旧未知阻断、运行中改模式冲突处理、中英文文案已接入MCP发布/重发布弹窗。既有服务管理、资产详情和端点注册入口共用该弹窗。配置结果不能显示成已确认生效。

父任务复核发现详情页最初对空managedServer直接读取会报错且Gateway会出现MCP标签，已改为MCP条件和可选访问，并加入空资产、未部署MCP、已部署JWT、Gateway的实际摘要模板SSR回归。

验证：test-mcp-publication.cjs 19/19（父任务独立复跑）；UI完整构建通过，最后详情修复后类型检查通过，diff无空白错误。构建有既有PURE annotation/circular chunk提示。Vue SSR使用组件替身，不是浏览器视觉或端到端验收。

[任务划分](../guides/active-work-package-breakdown.md)与[执行状态](../guides/active-work-package-execution-status.md)标B4 DONE、A1-02D READY；运行实际模式仍unknown，真实跨层保存/发布/重启/请求验证留A1-02D，不提升父包完成状态。
