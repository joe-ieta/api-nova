---
doc-version: 1.0.2
doc-status: active
doc-updated: 2026-10-08
---
# SEC-F4-02 本机安全签收准备与依赖补丁

用户已选择本轮暂用本机隔离环境，生产签收保留待办。SEC-F4-02未完成：本轮刷新依赖证据并修复新增critical项；残余依赖风险处置和目标环境权限/网络/开关签收仍需完成，不把审计命令执行成功视为安全通过。

后续同日已完成兼容更新及Nest实际上传/解析器链迁移，最新为15个依赖节点（0 critical、2 high、13 moderate）；本页保留第一批历史证据，当前结果与剩余行动以[解析器链迁移](./2026-10-08-security-parser-chain-migration.md)为准。

## 第一批依赖审计

在`oc_dev / 94b5841`加本轮改动上运行`npm audit --omit=dev --json`。该命令退出1表示有依赖告警，HTTP查询和JSON解析成功；没有运行`npm audit fix`。

| 时点 | critical | high | moderate | total | 锁文件SHA-256 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-08 补丁前 | 1 | 14 | 17 | 32 | `20eceaf66a68d9432046e62751f1b6b025b623b29b916c6bc1f59e085e34ae6a` |
| 2026-10-08 补丁后 | 0 | 14 | 15 | 29 | `ca0152e771c36fd1fc852a9195e0b764e7c904968d4f717e7f6aa5dbaffe62a4` |

原始记录在`.tmp/security-signoff-8mRGTa/production-audit.json`、`production-audit-after.json`及对应summary。统计为npm报告的受影响依赖节点数，不是可利用漏洞数；转移依赖会传播告警，因此仅改一包也可能减少多个节点。2026-09-26补丁后19项的旧审计是当时时点，不能作为本次候选结论。

## 本轮兼容补丁及验证

`proxy-addr`从2.0.7更新到2.0.8，使用`npm update proxy-addr --ignore-scripts --no-audit --no-fund`，实际只改变一个安装包，锁文件只变该条目。Express 4、Nest内嵌Express和MCP SDK的Express 5依赖树均解析到2.0.8。未改变Nest或SDK主版本，也未修改产品信任代理配置。

[维护者公告GHSA-jqcg-44mw-7w3h](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)说明特定短前缀IPv4映射IPv6信任子网会错误信任任意IPv4来源，修复版本2.0.8。本次[真实HTTP回归](../../scripts/verify-proxy-trust.cjs)在旧包上复现：配置`::ffff:10.0.0.0/8`后伪造X-Forwarded-For被接受。补丁后`npm run verify:proxy-trust`三项通过：默认不信任转发身份、错误短前缀不信任任意IPv4、显式受信loopback仍正常。

仓库检索未发现产品显式设置上述错误trust proxy子网；复现验证的是依赖在特定配置下的漏洞，不声称产品默认配置已被利用。补丁有防止后续代理部署误配放大风险的实际价值。

## 仍需推进的本地风险处置

下表是后续处置队列，不属于必须等待生产环境的工作，也不把旧审计中的“全部需要Nest升级”直接沿用为当前判断。

| 范围 | 当前行动 |
| --- | --- |
| axios、compression、engine.io、figlet、vue/server-renderer、source-map-js等可兼容更新项 | 逐项核对公告条件和锁定链，形成受控补丁批；与HTTP转发、实时流和UI回归一起验收，不在并行验收进程中途替换依赖 |
| MCP SDK OAuth公告 | 核对实际OAuth客户端调用路径（OAuth仍延期）及SDK兼容更新；依赖树存在不等同功能已启用，不凭延期直接豁免所有SDK风险 |
| Nest族及其body-parser、multer、file-type、js-yaml、lodash、qs、uuid链 | 区分可兼容补丁、精确依赖约束和真正主版本迁移；npm建议major不是独立的技术结论，不机械降级或整体升级 |
| chokidar/braces | 复核watcher使用方式与攻击输入，再选择兼容修复或独立迁移；不能仅凭“配置文件本地”宣称不可达 |

当前仍有14 high和15 moderate告警，未逐项完成当前版本可利用性判定或风险签收。不能仅以critical归零宣布SEC-F4-02 DONE。

## 目标环境签收仍需的输入

当前不要求用户立即提供生产环境；用户已选择本机隔离验收。正式签收时复用同一套目标环境：平台/Node/DB版本、API/UI入口与运行账户、数据库和存储授权范围、TLS/反代及可信代理配置、身份/JWKS或凭据引用、受控上游及网络策略、实际运行开关和回退窗口。密码、私钥和令牌由目标环境的secret注入或受控文件提供，仅登记引用，不写入聊天或仓库。

SEC-F4-02的实现依赖已有限定DONE证据；剩余分为上述本地风险处置和真实部署签收。OPS-01继续等待本包与OBS-16-04最终结论。环境输入与可观测签收共用，见[可观测准备](./2026-10-08-observability-signoff-readiness.md)，不重复创建环境任务。
