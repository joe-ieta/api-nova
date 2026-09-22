---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-22
---
# 四类上游凭据与生命周期作用域验收

## 交付

SEC-C1-02按[批准合同](../guides/upstream-credential-types-contract.md)实现API Key Header、Bearer、Basic双引用及单值Custom Header，沿用reference-only与对象/JSON/YAML统一Schema。Query/Cookie/OAuth/未知类型仍明确拒绝。

- [Schema与类型](../../packages/api-nova-parser/src/credentials/schema.ts)：严格未知/null/明文拒绝；enabled、notBefore/expiresAt、环境/Host/Endpoint/Method交集。跨四位年份的时区归一化使用数值时间比较，补充反向范围拒绝。
- [Registry](../../packages/api-nova-parser/src/credentials/registry.ts)与[Resolver](../../packages/api-nova-parser/src/credentials/resolver.ts)：Basic两个引用全部解析才注入；合法禁用可激活，下一解析拒绝；坏Candidate保旧；异步Secret解析前后检查期限，保留历史认证名。
- [秘密材料检查](../../packages/api-nova-parser/src/credentials/secret-material.ts)：Unicode、控制字符、空值、Basic用户名冒号、单材料与最终Header长度拒绝；失败仅固定安全错误。
- [Gateway适配](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential-resolver.ts)与[显式single-hop](../../packages/api-nova-parser/src/credentials/single-hop-execution.ts)：Endpoint选择器与实际出站Method分离，消费者/当前/历史认证名先剥离；没有跨scope回退。
- [DB归属](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential-ownership.ts)：Scope ID必须存在，属于引用该凭据的Site源集合；未引用预置只检查ID存在，引用后重验，运行时继续取具体Site交集。

Gateway适配的缓存身份包括非敏感revision/代次/Site/Credential和随机材料epoch；闭包有界256条只存材料摘要与随机epoch，秘密或其摘要不进入缓存键/日志。Provider内容变化使epoch改变；缓存命中前仍须重新解析当前凭据。共享Proxy预检接口已准备，02C负责实际命中接入。

## 证据与边界

| 验证 | 结果 |
| --- | --- |
| Parser最终全量 | 27套533/533，`.tmp/security-0922-parser.log`；4条既有审计失败注入告警不计失败 |
| API最终联合 | 30套428/428，`.tmp/security-0922-api.log`；包含同批02C，不能全部计为凭据新增测试 |
| 四类型真实HTTP | 27/27：实际Gateway Proxy与Server transform显式single-hop，四类正确注入及禁用/Scope/过期零命中、Basic双引用变化及任一失败、坏候选保旧与历史名剥离 |
| 适配/Provider/DB归属 | 5/26/6项均通过，已包含联合回归，不相加为新增数 |
| 构建与准备校验 | Parser/Server/API构建通过；managed handoff preparation 32/32，含Basic双引用批准/分别缺一拒绝，未改变生产生命周期 |

真实测试使用本机Windows、隔离回环和合成Secret，DB归属用真实SQL.js。显式Server transform的工具执行不等于受管生产child/IPC验收；不改变生产生命周期门禁。Linux文件权限、F1安全声明对账/发布门禁、E1生产接线与F3网络仍各属原任务。

## 父包出口复核

TP-C1原SEC-C01与A0依赖只要求YAML/JSON结构、Site归属及真实匹配、Endpoint ID/唯一回退、继承/覆盖/None。本批结合原Loader/Registry/Resolver证据与四类类型出口闭合C1；F1对账和E1受管全链路不能倒挂成C1新增依赖。C2/C3/C4/E1等父包不随C1自动完成。
