---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# 锁定MCP Adapter协议边界验收

基线66654cf；最终实现版本为包含本报告的提交。SDK仍为1.29.0，Server/Parser1.7.0及锁文件未改；不升级无状态协议或启用OAuth。Windows隔离回环与真实stdio子进程。
新原始HTTP矩阵覆盖Streamable/SSE的Method、Accept/Content-Type、Host/Origin、初始化、协议版本、未知/关闭Session和JSON-RPC错误；37项报告包含35个子项与两个父test。
真实失败用例发现Streamable已知端点遇PUT/PATCH/HEAD错返404，现改405并附Allow: GET, POST, DELETE；未知路径仍404。原非法JSON已为400，无需重复修复。
npm run test:adapter-contract --workspace=api-nova-server：新矩阵37+SDK会话11+真实stdio12，60/60通过，exit0；root最终复跑日志.tmp/adapter-final.log。Server构建通过。计数包含父test，不能用作独立场景百分比。
结合B3-01真实DB/CLI撤销、B3-02 dispatcher/会话/通知边界，当前Session型Adapter及stdio stdout/退出合同满足原E0出口。取消/回放/完整安全发布矩阵仍有E2独立依赖；未宣称全部生产平台验收。
原TP-E0要求独立认证/Session/错误合同、不改变协议版本，本次闭合；原TP-B3要求每请求复验/Session绑定/Tool过滤与二次授权，B1/B2/E0依赖现已闭合，结合两叶既有证据提升B3为DONE。不把异步权限广播或强制取消在途请求虚构为既有能力。
