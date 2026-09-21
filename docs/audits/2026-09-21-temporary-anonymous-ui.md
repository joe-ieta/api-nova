---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# 临时匿名管理界面验收

代码基线30f6a71，最终版本为包含本报告的提交。SEC-F2-02将A3-01已有服务端规则接入Gateway绑定编辑和MCP发布对话框；不新增认证方式或永久匿名自动降级。
共用TemporaryAnonymousEditor：原因1–500字、带时区到期时间、生产许可及双许可提示。保存重开回显服务端actor和期限，请求不提交actor。已有临时授权不可取消为永久；既有显式永久匿名保留风险提示。Gateway合并原upstreamConfig，不丢其他配置。
过期/无原因/非法时间阻止提交；服务端拒绝保持草稿，兼容文本及temporary_anonymous_expired/temporary_anonymous_production_forbidden错误码，显示可读提示。是否获准仍由服务器决定，UI复选框不能替代主机生产许可。
node packages/api-nova-ui/scripts/test-mcp-publication.cjs：26/26通过，exit 0，含真实Vue模板SSR和可执行表单协议、保存重开、actor边界与拒绝反馈；根任务最终复跑日志.tmp/anonymous-ui-final.log。npm run build --workspace=api-nova-ui通过（既有vendor循环chunk及PURE注释警告）。未执行真实浏览器点击端到端验收，不将SSR称为浏览器验收。
后端managedServer.temporaryAnonymous回显随30f6a71交付。此前A3真实发布/冷重开/子进程到期证据继续适用，本报告新增UI出口。F2-02 DONE；F2-01整体界面分区仍READY，父F2保持IN_PROGRESS。
