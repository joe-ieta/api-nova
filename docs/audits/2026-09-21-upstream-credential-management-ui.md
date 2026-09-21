---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# Consumer与Upstream分区和重载恢复

代码基线2359796，最终版本为包含本报告的提交。SEC-F2-01复用现有管理JWT、config:read/config:update和Registry接口，不创建浏览器本地凭证源或伪造跨进程状态。
运行时详情明确Consumer与Upstream用途；既有binding对话框保留真实binding.revision，共享Registry面板显示API返回的revision/generation/environment。Registry状态仅代表当前API/Gateway进程，不能表示MCP子进程已同步。
Reload携带当前读取的expectedGeneration和原因。冲突、超时或任何失败保留只读旧状态并标为待刷新；成功显式读取后才能再试，不自动重放、不自增代次。身份切换/关闭丢弃迟到结果，响应白名单避免展示路径或秘密。
## 验证
- npm run build --workspace=api-nova-ui及类型检查通过；已有vendor/PURE警告保留。node packages/api-nova-ui/scripts/test-upstream-credentials.cjs：12/12，root最终复跑exit0，日志.tmp/credential-ui-final.log。
- node packages/api-nova-api/scripts/test-upstream-credential-ui-http.cjs：1/1，实际UI adapter/controller→真实Nest管理JWT与权限→真实AdminService/固定文件Registry；验证并发管理员代次冲突、坏文件保旧、结果审计失败但激活已生效、刷新后恢复及权限撤销403，响应无路径/秘密。UserService/AuthService和审计存储为隔离夹具，未连接生产用户库。
- API admin/controller/binding相关3套21/21通过，exit0；本地日志.tmp/admin-bindings-final.log。日志不保证随Git分发。
未执行真实浏览器点击验收。Consumer保持已有Gateway凭证管理能力，本次没有补MCP凭证/Tool Scope编辑表单；不能把分区出口写作全量凭证管理UI完成。
F2-01及F2-02两个叶子已完成；父F2仍受C3多进程与F1对账依赖约束，保持IN_PROGRESS。本批共3叶：1项CODE、1项VALIDATION、1项DOC，DONE71→74，总量仍132。
