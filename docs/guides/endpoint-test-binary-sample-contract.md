---
doc-version: 0.4.0
doc-status: active
implementation-status: partial
doc-updated: 2026-09-16
---
# 端点测试二进制样例合同

PROD-04A交付源码核对与PROD-04B/04C实施边界。本文冻结本地受控对象存储的技术合同；第1–8节保留04A时的现状与实施要求，第9节记录04B1限定实现。不表示原始二进制可自动脱敏或生产存储已经批准启用。DEV-04及父工作包状态不因04A/B1完成而关闭。

## 1. 已实现依据与缺口

| 层次 | 当前事实 | 尚需实现 |
| --- | --- | --- |
| 实际采集 | AssetCatalogService调用HttpService后把response.data传给recordSuccessfulRun；没有显式二进制responseType或完整字节测量合同 | 在真实测试响应边界识别字节，不能从已经转码的字符串恢复原始二进制 |
| 样例/运行记录 | 成功测试在同一数据库事务生成run与一个独立sample；requestPayload/responsePayload均是JSON列 | 二进制对象描述符及独立受控对象引用 |
| 当前大小护栏 | ENDPOINT_TEST_SAMPLE_MAX_BYTES默认256KiB；按脱敏值JSON序列化UTF-8长度计量，超限留下truncated/byteLength/sha256和最多4096字符preview | 二进制按原始应用字节计量，不复用JSON大小或输出原始预览 |
| 读取/管理 | list samples/runs要求server:read；维护/归档要求server:update；删除/cleanup要求server:manage；无二进制读取路由 | 新内容读取须单独授权，列表不内联正文 |
| 留存 | ENDPOINT_TEST_SAMPLE_RETENTION_DAYS默认90；cleanup只选archived且capturedAt早于cutoff；显式删除直接删sample | 引用撤销→对象删除的可靠顺序和失败重试；不能偷偷让active样例90天自动过期 |
| 回放 | Gateway把requestPayload按对象/JSON构造请求；MCP把对象参数传给tool.handler；响应断言面向JSON/text/status | 二进制描述符不可被当成普通请求参数或JSON期望响应 |
| OBS正文 | CallObservabilityPayloadStore归属调用身份、request/response侧、runtime_payloads和OBS保留链 | 不直接复用OBS实体、对象目录、TTL、配额、扫描器或事件清理 |

源码入口：

- [测试采集入口](../../packages/api-nova-api/src/modules/asset-catalog/services/asset-catalog.service.ts)
- [样例服务](../../packages/api-nova-api/src/modules/endpoint-testing/services/endpoint-testing.service.ts)、[DTO](../../packages/api-nova-api/src/modules/endpoint-testing/dto/endpoint-testing.dto.ts)、[控制器权限](../../packages/api-nova-api/src/modules/endpoint-testing/endpoint-testing.controller.ts)
- [样例实体](../../packages/api-nova-api/src/database/entities/endpoint-test-sample.entity.ts)、[运行实体](../../packages/api-nova-api/src/database/entities/endpoint-test-run.entity.ts)
- [Gateway回放](../../packages/api-nova-api/src/modules/runtime-verification/services/gateway-candidate-replay.service.ts)、[MCP回放](../../packages/api-nova-api/src/modules/runtime-verification/services/mcp-candidate-replay.service.ts)、[响应断言](../../packages/api-nova-api/src/modules/runtime-verification/services/runtime-response-assertion.service.ts)
- [现有OBS对象存储，仅供边界对照](../../packages/api-nova-api/src/modules/call-observability/call-observability-payload.store.ts)
- [已批准样例目标与留存基线](./runtime-instance-and-regression-closure-plan.md)

## 2. 内容类型、表示与测量

04B先交付成功测试的二进制**响应样例**存储/受权读取和回放阻断解释；不额外开通任意文件上传、二进制请求重放、multipart重建或对外自动发送。

- JSON（application/json及+json）和已解码文本沿用脱敏JSON/text路径。二进制候选为application/octet-stream、application/pdf、application/zip及image/*、audio/*、video/*。类型只作分类和描述，不能证明安全。text/html、SVG/XML以及未知类型不因扩展名被提升为可信原始可预览内容。
- 优先从测试HTTP响应真实Buffer/Uint8Array或有界流取得字节。字符串、JSON的`{type:Buffer,data:...}`或用户metadata中的base64不是可信字节来源；缺少原始字节则标记unavailable，而非重编码后声称原始内容。
- 存储编码固定raw：不在JSON列、列表、日志或错误里内联base64/data URI/字节数组。下载返回原始应用响应字节；HTTP压缩由客户端是否解码决定，描述符必须记录measurement=`decoded_response_body`或`encoded_response_body`，不称作wireBytes。
- 描述符由服务端生成：kind=`binary`、schemaVersion=1、mediaType、measurement、observedBytes、isComplete、sha256、captureState、opaqueObjectId（仅stored时存在）。mediaType去参数并小写，长度上限128；不保存用户提供文件路径/下载文件名。
- sha256是完整捕获的对应测量字节SHA-256；只拿到前缀时sha256=null，不把前缀hash当完整摘要。流超限中止后observedBytes只是已观察量，isComplete=false；只有完整读完才报告完整大小。Content-Length可记录为单独declaredBytes，不代替observedBytes。
- 二进制不产生原始preview。保留状态至少区分stored、metadata_only、too_large、unavailable、storage_failed、deleted；授权不足以HTTP拒绝表达，不将对象是否存在透传给未授权用户。

## 3. 大小与配置

未配置专用对象根目录时保持已批准行为：二进制只保留类型/大小/完整摘要，不存原始内容。04B拟增加显式`ENDPOINT_TEST_SAMPLE_BINARY_DIR`作为DB外的私有文件对象库；目录存在不自动等于启用，需有效服务端配置。它不能位于静态站点或OBS正文目录。

二进制每对象上限沿用`ENDPOINT_TEST_SAMPLE_MAX_BYTES`当前有效值，默认256KiB，按实际存储字节计算；不隐式调大已批准捕获护栏。配置/诊断应分别说明现有JSON序列化大小和二进制应用字节的不同测量口径。流读取必须有界，不能先缓冲任意大对象再检查大小；并发读取使用小的有界信号量（04B技术默认4），不表示磁盘配额治理。

不解压ZIP/PDF、不加载图片解码器或执行脚本，不根据MIME声称已脱敏。原始二进制可能含敏感信息，所以显式存储配置和受权内容读取是前置；JSON密钥脱敏器不能作为二进制脱敏证据。

## 4. 对象、引用与权限

新增专用样例对象记录（拟名`endpoint_test_sample_objects`），由sampleId+side=response独占，不跨样例按hash共享对象。字段包括opaque id、sampleId、私有objectKey、字节/摘要、生命周期state、createdAt及删除重试信息；对象目录/key永不作为HTTP输入或响应。

样例拥有引用；run只保存相同摘要及captureState，不拥有可下载对象引用，避免sample删除后run暗中延长原始对象留存。每次成功测试仍生成独立样例，不按hash合并。引用应为独立实体关联/服务端字段，不能塞入可由UpdateEndpointTestSampleDto.metadata修改的权限权威字段。

拟新增读取路由：`GET /api/v1/endpoint-testing/test-samples/:sampleId/binary-content`。该接口当前不存在。使用现有JwtAuthGuard/PermissionsGuard并要求server:manage；server:read仍可看脱敏列表摘要，但不因此获得无法脱敏的原始二进制。以sampleId查真实endpoint关联，再取对象；若系统已有额外资源范围检查，必须执行同一范围，不自行宣称当前全局权限已变成逐资产授权。

返回Content-Type=application/octet-stream、Content-Disposition=attachment（服务端固定安全文件名）、X-Content-Type-Options=nosniff、Cache-Control=no-store；声明mediaType仅在授权元数据内展示。04B不支持Range、内联预览、公共静态URL或可转发的未授权签名URL。未认证401、无权限403；授权后无sample/不存在对象404，已撤销引用410，损坏/临时存储失败503；不得泄露磁盘路径。

内部读取复用同一对象解析、状态和摘要验证逻辑，不从用户传入对象id或URL绕过sample归属。下载读取中再次核对引用有效性；删除先撤销引用阻断后续读取。已经交付给客户端的字节无法撤回，不能声称瞬时强撤销。

## 5. TTL与清理顺序

保持现行90天配置与选择规则：只有archived样例且`capturedAt < cutoff`由显式受保护cleanup清除，active样例不自动过期；归档本身不立即删除对象，明确DELETE仍可立即撤销该样例。没有新建按object.createdAt独立90天的TTL，避免改变已批准留存。run留存策略不在本子任务实现。

- 删除或cleanup的短事务先将sample设为不可读/待删除并将对象引用标记delete_pending；其后新读与回放不得获取原始内容。最终删除sample前保留必要的对象删除墓碑。列表与管理接口明确pending状态，不假报已回收磁盘。
- 事务提交后再unlink对象；ENOENT按对象已不存在处理，其他错误保留delete_pending及有限错误分类、下次显式cleanup可重试。unlink成功后再标记deleted/清除sample，DB终结失败不复活引用，下次重试幂等。
- 不能先删sample行再失去objectKey，也不能在数据库事务里执行长目录扫描。每批最多100对象并有时间预算，遍历失败保留检查点/失败状态；不自动启用后台GC。
- 读取先取得有界字节并关闭文件句柄，再校验摘要和引用状态后返回；删除竞争失败则返回不可用，不发送混合或截断成功正文。Windows文件占用与POSIX unlink差异必须在04C解释，失败重试不扩大删除路径。
- 待执行验证遇到样例被撤销/对象丢失需标记该case blocked/failed并保留上次可用发布版本；不借验证引用暗中延长留存，也不重放业务请求补样例。

## 6. 创建与失败补偿

文件与DB无分布式事务。04B必须显式实现staged→ready→delete_pending→deleted流程：

1. 服务端生成不可猜key，在配置根内独占创建临时普通文件；拒绝符号链接/目录替换，验证解析路径在根内，记录原始字节长度和摘要；文件/目录权限采用平台可用的最小权限，未验收NTFS ACL不得声称已经满足生产权限要求。
2. 完成写入后以同目录原子rename发布完整对象；只有完整对象存在且测量一致时，run/sample事务才可引用ready记录。准备阶段通过staged记录追踪，不把路径散落于日志。
3. 对象准备失败：仍按既有成功调用结果保存run与独立sample，captureState=storage_failed且无对象引用；不能把HTTP测试成功改称上游调用失败，也不能返回raw bytes绕过存储限制。
4. run/sample事务失败：回滚两者及引用，不再返回样例成功。对已写文件立即尽力清理；清理失败留下独立staged/deletion墓碑，不能丢失重试入口。失败记录不得引用半写对象。
5. 进程在上述任一阶段退出后，下一次显式整理只处理已知staged/delete_pending且超过安全宽限的对象；新鲜staged或ready对象不因“暂时找不到sample”被删。宽限期仅保护未完成写入，不改变样例90天保留目标。

## 7. 回放语义

requestPayload继续使用现有JSON参数，不支持把binary descriptor变成原始请求。响应二进制期望可采用显式status-only，或新增binary-exact（相同测量类型、完整长度与SHA-256）；不得把JSON对象schema/exact断言偷偷当作二进制hash验证。若04B尚未接入binary-exact的真实字节回放，必须显示unsupported/blocked，不自动降级为status-only通过。

二进制响应样例默认不自动打smoke/regression标签；保持既有样例自动生成、标签由操作方维护。已选为验证依据但不可完整读取的样例必须形成可解释阻断，不将缺失内容当作空响应或成功。

## 8. PROD-04B与04C

04B实施文件边界：

- asset-catalog测试HTTP采集路径：有界二进制来源识别、测量与内容分类；不得破坏已有JSON脱敏/成功标准。
- endpoint-testing DTO/service/controller/module：描述符、专用对象服务、下载授权、删除墓碑/有界显式整理、run与sample事务补偿。
- database：专用对象实体、当前实体注册和SQLite/PostgreSQL干净初始化；不做历史数据库原地迁移、不触碰OBS表。
- runtime-verification响应断言及Gateway/MCP回放：阻止不支持二进制样例伪成功，必要时实现明确binary-exact；不要扩展二进制请求上传。
- 样例UI/API类型：只显示摘要/状态、授权下载入口与未支持的回放说明，不渲染原始内容。

04C验收至少覆盖：

| 场景 | 所需证据 |
| --- | --- |
| 实际字节 | 隔离本地HTTP返回非UTF-8字节、PNG/PDF标识、未知类型、错误Content-Length；保存/下载逐字节一致，不能从JSON数组伪造 |
| 上限 | 阈值内/边界/超限、分块和压缩测量、有界读取；前缀不能宣称完整摘要 |
| 权限/路径 | 真实HTTP未认证/只读/管理身份；猜sample/object id、路径穿越、symlink和删除竞争；响应不含根目录 |
| 事务 | 文件写/rename失败、run/sample事务回滚、unlink失败及终结DB失败；无可读半对象，补偿可重试 |
| 留存 | active不自动过期；archived按capturedAt及现有90天设置；手工DELETE即时撤销；删除重试不延长引用 |
| 验证 | 二进制unsupported或缺失阻断；status-only必须显式；支持binary-exact时真实不同字节失败，旧发布版本保留 |
| 分离 | OBS正文目录、事件、TTL和配额不被本整理入口触碰 |

04A最初仅交付DOC；04B1已有第9节所述局部对象原语，04B2A/B/C、04B3及04C尚未完成。现有内部读取不等于HTTP受权下载；binary-exact、样例对象持久化与HTTP受权下载仍不得标为已实现。
## 9. 04B1限定实现快照（2026-09-16）

PROD-04B1已建立专用对象实体与SQLite/PostgreSQL空库初始化结构，新增默认关闭的私有对象根、staged→ready发布原语及有界内部读取；rename成功后数据库写入失败的重试/幂等恢复有专项覆盖。对象原语9/9、API构建通过；SQLite空库smoke核对67表且drift=0。04B2A已在显式开关下验证真实loopback响应字节的有界descriptor；默认仍关闭，未将字节落盘，也未提供HTTP下载或对象删除。04B2B/C、04B3引用撤销/整理与04C整体验收仍待完成。原始字节可能包含敏感信息，04B1的内部原语不构成生产配置启用或跨平台文件权限验收。
## 10. 04B2下一批拆分（2026-09-16）

原聚合04B2拆成三个独立代码出口：04B2A从真实HTTP响应取得字节并生成有界descriptor，仍默认关闭；04B2B将成功run/sample引用与对象发布、失败补偿放入一致事务边界；04B2C在server:manage权限与sample真实归属核验后提供内容读取。04B2A已通过27/27及API typecheck：未声明二进制类型只返回unavailable，JSON/text/HTTP失败与默认off保持旧行为；不落盘/下载。04B2B已解锁，04B2C仍待事务补偿完成；04B3现依赖B2C。任何描述符、内部对象原语或计划中的下载路由都不代表原始内容已可受权读取或04C验收通过。