# ApiNova v1.7.6-rc.5 人工测试指南

候选测试版，生产环境签收未完成。选择Windows x64、Ubuntu24.04 x64或ARM64离线包，完整解压。

## 启动与停止

Windows运行start.bat，Linux运行./start.sh，无需安装依赖。打开 http://127.0.0.1:9001/ ，使用admin / admin@123456登录。启动终端按Ctrl+C停止。

配置在.env，数据库在data/api-nova.db，进程日志在logs/，PID在pids/。共享网络使用前修改管理员密码及JWT_SECRET/JWT_REFRESH_SECRET；公开默认值分别为api-nova-local-release-change-me和api-nova-local-release-refresh-change-me。

## 人工检查顺序

1. 对照 /health 检查顶部健康和刷新；完整健康要求至少空闲5GiB、内存及MCP正常，/api/health/live只表示API存活。
2. 从URL或JSON文件导入OpenAPI；无servers文档应有端点但没有自动运行实例。显式添加实例，检查端口可编辑，探测、测试和准入。
3. 首次配置production运行绑定，检查候选实例可见；将两个端点发布到同一Gateway并部署。
4. 创建消费凭证，检查无凭证拒绝、有效凭证成功，并在访问日志和监控查对应请求。
5. 在隔离环境归档旧实例A并配置B，重新测试、绑定和部署；确认不需重新导入文档且消费转到B。
6. 日志页应显示真实运行事件。检查翻页、级别筛选、当前页搜索、刷新；清空当前显示后刷新可重新读取，服务器记录不删除。断网或权限不足时显示错误。
7. 停止重启，检查文档和资产持久化；记录平台、版本、步骤、预期与实际、脱敏截图和日志。

日志页仅显示持久化运行事件，搜索和来源筛选仅作用于当前页，不替代全部进程日志或完整安全审计。自动浏览器测试不等于人工签收；其他已知边界见RELEASE_NOTES.md。

## 排查与回退

检查9001/9022端口、平台/CPU、空闲空间及启动终端和logs/。MCP未启动造成完整健康503，不等于API启动失败。升级前完整备份旧数据，勿在archive中运行；回退使用rc.4包与对应数据备份。latest晋升时旧目录保存在api-nova-release/backups/。
