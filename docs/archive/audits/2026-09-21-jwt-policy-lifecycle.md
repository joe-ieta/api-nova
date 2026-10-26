---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# JWT参数保存与真实运行验收

基线c044ca2，最终版本为包含本报告的提交。Windows隔离SQL.js与真实CLI；锁文件无改动，未修改生产环境。
新增RuntimeJwtPolicy：algorithms仅允许RS256/384/512、PS256/384/512、ES256/384/512、EdDSA；requiredClaims保留sub/exp/iat安全基线并可增加；clockToleranceSeconds整数0–300。非法/null/未知字段拒绝。旧配置默认RS256/ES256、sub/exp/iat、0秒。
Gateway保存于route.upstreamConfig.jwtPolicy；MCP部署保存于server.config.jwtPolicy。省略更新保留旧策略，managedServer摘要回显。运行中的MCP实质变更策略返回MCP_JWT_POLICY_CHANGE_REQUIRES_STOP，避免保存与运行不一致。
MCP生命周期/启动预检与执行采用同一策略；持久策略优先，缺省读主机API_NOVA_RUNTIME_JWT_POLICY，忽略saved env覆盖。固定issuer/JWK/JWKS/audience继续由可信主机配置，不从令牌挑选信任源。JWK预检按算法/曲线匹配，非默认ES384可启动。
保留原expiresAt，新增authorizationExpiresAt=exp+clockToleranceSeconds供SSE流截止使用；API Key仍按自身截止，不继承JWT容差。该参数是验证容差，不是延长签发令牌。
## 验证
- Parser JWT真实签名/既有安全审计43项通过；API配置相关85项通过（包含后补运行中变更拒绝）。
- 根任务生命周期相关4套31/31，含真实Node子进程收到持久策略、伪造env不能覆盖、非法策略先于进程副作用拒绝。
- 根任务Gateway/runtime-assets/publication/servers联合45套465/465；随后新增运行中策略测试由runtime-assets36/36补验，计数不重复累加。
- node packages/api-nova-api/scripts/test-jwt-policy-lifecycle.cjs：1/1，实际发布/失败保旧→SQLite关闭重开→Lifecycle/ProcessManager/CLI，Gateway/MCP同样执行ES384、tenant必需声明、容差内接受/外拒绝，同PID。最终复跑exit 0，日志.tmp/jwt-final-live.log。
- node --test packages/api-nova-server/scripts/test-mcp-http-observability.cjs：17/17，包含真实JWT SSE有效截止和API Key原截止。
- Parser/Server/API构建exit 0，API最终日志.tmp/jwt-final-build.log；临时日志不保证随Git发布。
B2-01及原TP-B2固定JWK/JWKS、issuer/audience/alg/claims出口闭合，父包DONE。B3的SDK桥接/通知和D1完整Header策略仍独立，不能由本包提升其它父状态。
