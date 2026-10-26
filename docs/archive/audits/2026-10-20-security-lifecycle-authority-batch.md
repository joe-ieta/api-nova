---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-20
---
# 依赖整改 生命周期收口与发布授权接线

本批并行推进NP-02、NP-20、NP-31。生产依赖告警由43降为18个包条目，NP-20完成Windows本机生命周期出口，NP-31完成默认关闭的宿主授权装配切片。API最终140套1630项、Parser 48套1193项通过；四个工作区构建通过。当前调度见[统一开发状态](../plans/main-2026-10-20/unified-development-status.md)，合同与子任务见[工作包](../plans/main-2026-10-20/unified-work-packages.md)。

本批保留原有工作树改动，未提交、推送、发布、生产启用或操作业务数据库。外部网络访问用于用户已授权的npm依赖查询、下载及审计；安装禁用生命周期脚本，未执行`audit fix --force`。

## 依赖整改

| 范围 | 时点 | critical | high | moderate | low | 包条目 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 全量 | 整改前 | 4 | 81 | 34 | 3 | 122 |
| 全量 | 最终锁文件 | 1 | 61 | 33 | 3 | 98 |
| 生产依赖 | 整改前 | 1 | 21 | 21 | 0 | 43 |
| 生产依赖 | 最终锁文件 | 0 | 2 | 16 | 0 | 18 |

计数包含传递影响，不是独立CVE或已证实可利用入口数。两scope最终audit均退出1，表示仍有漏洞，不是网络失败。整改前分诊保留在[原报告](2026-10-20-dependency-audit-triage.md)。

最终锁文件SHA256：`F9A15441A84C752748E152480912F9E5B4C7BD8A533D97A2991A38BC631D67DD`。报告为`tmp/np02-verified-all.json`、`tmp/np02-verified-production.json`；完整安装图`tmp/np02-installation-all.json`，`npm ls --all --json`退出0。

### 已落地版本与消费方

| 路径 | 修复结果 |
| --- | --- |
| HTTP及Socket.IO | compression 1.8.2、proxy-addr 2.0.8、engine.io 6.6.11、socket.io-parser 4.2.7 |
| 上传与Nest固定副本 | 根和FileInterceptor实际使用的multer均2.4.0；Swagger YAML 4.3.2、Swagger/config lodash 4.18.1 |
| 请求与配置解析 | Axios 1.20.0、YAML 4.3.2、body-parser 1.20.8、qs 6.16.1、Joi 17.13.8 |
| MCP | SDK 1.32.1；API/Server显式声明HTTP适配器@hono/node-server 1.19.17，Hono 4.13.13 |
| UI及工具叶子 | Vue 3.5.44、PostCSS 8.5.31、figlet 1.12.0、Handlebars 4.7.10、shell-quote 1.12.0等 |

根manifest对Nest固定旧依赖、concurrently的shell-quote、body-parser/qs及Hono适配器作定点override，校验实际消费路径与安装副本。顶层已有依赖没有跨主版本；Express 5传递分支将content-disposition从1.x带到2.0.1，已纳入SDK回归，不能把整张依赖图说成“所有包均无主版本变化”。

`scripts/test-dependency-security-remediation.cjs`的6项验证覆盖实际消费版本、锁文件一致性、真实SDK transport加载、gzip正常响应与断连后zlib关闭、Socket.IO polling升级及二进制附件、Axios零跳转和普通YAML兼容性。

`OpenAPIUploadInterceptor`将现有`MAX_OPENAPI_FILE_SIZE`限制提前到multipart解析阶段；两个上传入口仅接受一个`file`，不接受附加文本字段。前端现有调用仅提交该文件。超限返回413，额外文件/字段拒绝400，无效配置拒绝500；原后置校验保留。真实Nest HTTP专项10项通过，覆盖两个入口、授权先于解析、限额和上传中断。专项使用合成授权guard，原JWT元数据和既有JWT测试保留，不将此专项描述为真实账号认证验收。

### 未解决依赖

- 生产high两个包条目来自braces/chokidar链；braces 3.x暂无本轮可用修复，需评估watch迁移，不强制升级。
- 全量critical剩余开发依赖Inspector；仍需核对使用面并独立验证主版本迁移。
- 生产moderate仍含Nest生态、file-type、TypeORM、uuid、ECharts/vue-echarts等。TypeORM等兼容候选也尚未实施，不能统称“只剩重大升级”。
- 真实部署暴露面、离线交付包及独立workspace安装图尚待验证。根override不会自动成为所有独立发布包的策略，后续打包须核对实际安装图及等效约束。NP-02仍IN_PROGRESS。

## MCP生命周期收口

NP-20补齐真实Nest容器关闭、排队及执行中自动重启取消、首次预检取消、慢HTTP健康检查与停止竞态、真实30秒握手超时及5秒强制终止。终态核对数据库、进程投影、健康/恢复计时器、事件监听、stdio/IPC及child PID，无迟到RUNNING；测试自然退出，无`forceExit`。

修复在途恢复未等待、停止后健康计时器重建、关停后新启动及终态handle保留。可信模式仍只由持久`trusted_ipc_v1`显式选择，READY后才RUNNING，旧模式不自动迁移。超时场景使用测试局部加载器替换为真实故障child，使用真实时钟和操作系统强杀；正常场景运行真实产品entry。生产固定entry、环境/DTO和HTTP授权面未增加测试开关。

生命周期32/32、既有通道/准备47/47通过；servers既有16套87项通过并包含在最终API全量。证据为`tmp/np20-lifecycle-closeout-rerun.tap`及专项日志。C1/C2本机出口完成，NP-20记DONE、NP-21变READY；PG/Linux、真实上游矩阵和运行中更新撤销仍由后续包承接，不关闭E1父包。

## 发布授权装配

`PublicationAuthorityModule`由Publication和Gateway共同导入，复用同一宿主authority及请求绑定存储。只有host代码能签发不可序列化plan，缺少或无效plan默认关闭。

装配复用实际challenge、proof issuer和持久证据；绑定可信会话、资源归属及Provider epoch，事务校验使用实际EntityManager并重读上下文/证据。挑战权限不代替`server:manage`。Gateway在Resolver前及发送前核对精确请求、路由和目标，受保护流量绕过缓存。

新增35项分别用默认mapper及真实workspace导出通过，受影响既有237项通过，共14套272个独立用例。覆盖真实四段挑战与实际Gateway转发、伪造/序列化能力拒绝、请求/会话绑定、到期/撤销/漂移、事务证据回滚和关闭后拒绝。真实导出复验不额外累加35项。

生产会话epoch与资源归属适配器、宿主管理入口/认证middleware、G2及异步激活接线、PG和受保护网络策略联合验收仍缺。G2仍`canPublish:false`，不能将宿主能力服务视为已经向用户开放受保护发布。NP-31.1完成限定装配出口，NP-31整体仍IN_PROGRESS，NP-31.2等待NP-30。

## 汇总验证与失败记录

| 验证 | 最终结果 | 本地证据 |
| --- | --- | --- |
| API全量 | 140 suites / 1630 tests，退出0 | `tmp/np-batch2-api-all.json`及同名log |
| Parser全量 | 48 suites / 1193 tests，退出0 | `tmp/np02-parser-all.json` |
| MCP协议及工具授权 | 122 tests，退出0 | `tmp/np02-sdk-contract-retest.log` |
| MCP生命周期 | 32 tests，退出0 | `tmp/np20-lifecycle-closeout-rerun.tap` |
| 既有IPC/准备 | 47 tests，退出0 | 子任务复验，按脚本范围分别记录 |
| 依赖独立回归 | 6 tests，退出0 | `tmp/np02-dependency-regressions-final.log` |
| 上传专项 | 10 tests，已含API全量 | `tmp/np02-upload-tests.json` |
| 发布授权专项 | 14 suites / 272独立用例，已含API全量 | `tmp/np31-authority-source-default.json`、`tmp/np31-regression.json` |
| 构建 | Parser/Server/API/UI全部退出0 | UI含vue-tsc及Vite，`tmp/np02-ui-build.log` |

首次npm更新保留了两个被override标为invalid的嵌套旧副本。随后重新解析父包、去掉精确定位的陈旧锁条目并由npm生成解析结果，未手填新包integrity。Hono节点又出现缺失，首次SDK及部分代理测试因此失败；最终显式声明运行时依赖，完整`npm ls`和真实transport加载通过后重跑。失败报告`tmp/np02-sdk-contract-tests.log`、`tmp/np20-lifecycle-closeout.tap`、`tmp/np31-authority-source.json`保留。

SDK精确版本断言从1.29.0更新为1.32.1，原行为断言保留并完整重跑。子任务中的夹具错误、沙箱临时目录读取及普通tsconfig跨包检查失败未算作通过；最终使用生产build配置及Node24复验。

执行使用Node24.19.0、PowerShell7.6.5及显式OpenSSL配置。本批未新增PG/Linux、浏览器交互、长期压力或目标部署验收。31主包和7执行子任务结构由`node scripts/verify-unified-work-plan.cjs`核对，子任务归属、前置与状态不一致会报错。
