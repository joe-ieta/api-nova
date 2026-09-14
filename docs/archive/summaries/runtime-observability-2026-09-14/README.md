# 可观测性文档历史归档：2026-09-14

> Document status: Active archive index
> 本目录的历史文件均为 archived，只用于追溯，不能定义当前实现或任务状态。

## 归档原因

远端优先整合已经完成，但原有文件混排了合并前待办、多个阶段的任务计数、曾经失败的测试和后续通过结论。本轮保留这些原始记录，将当前文档整理为单一有效结论。

历史文件按文档版本清单的既有规则原样保留，不改写历史正文或追加元数据。文件内旧 `active`、日期、状态、相对路径和待办均属于当时上下文；归档分类以本索引和版本清单为准。历史相对路径应按下表的原始位置解释，当前使用请进入对应的活跃文档。

## 文件目录

| 历史文件 | 原始位置 | 归档类型与当前入口 |
| --- | --- | --- |
| [合并前未完成工作报告](./runtime-observability-remaining-work-2026-09-14.md) | `docs/guides/runtime-observability-remaining-work-2026-09-14.md` | 已过期报告，移出 guides；由[当前完成情况](../../../guides/runtime-observability-completion-review.md)替代 |
| [完成情况整理前快照](./runtime-observability-completion-review.md) | `docs/guides/runtime-observability-completion-review.md` | 历史快照；[当前版本](../../../guides/runtime-observability-completion-review.md) |
| [执行状态及历史流水](./runtime-observability-development-execution-status.md) | `docs/guides/runtime-observability-development-execution-status.md` | 历史快照；[当前证据登记](../../../guides/runtime-observability-development-execution-status.md) |
| [任务计划整理前快照](./runtime-observability-development-task-plan.md) | `docs/guides/runtime-observability-development-task-plan.md` | 历史快照；[当前任务计划](../../../guides/runtime-observability-development-task-plan.md) |
| [API 契约整理前快照](./runtime-observability-api-endpoints.md) | `docs/reference/runtime-observability-api-endpoints.md` | 历史快照；[当前 API 契约](../../../reference/runtime-observability-api-endpoints.md) |
| [存储基础整理前快照](./runtime-observability-storage-foundation.md) | `docs/reference/runtime-observability-storage-foundation.md` | 历史快照；[当前存储基础](../../../reference/runtime-observability-storage-foundation.md) |
| [契约映射整理前快照](./runtime-observability-contract-mapping.md) | `docs/reference/runtime-observability-contract-mapping.md` | 历史快照；[当前契约映射](../../../reference/runtime-observability-contract-mapping.md) |
| [设计整理前快照](./runtime-observability-design.md) | `docs/reference/runtime-observability-design.md` | 历史快照；[当前设计基线](../../../reference/runtime-observability-design.md) |

## 不归档的基线

已批准的需求、设计、仍有效的管理侧观测边界和未完成任务退出条件继续维护在 guides/reference。日期较早不等于内容过期；设计中的目标与未完成能力需要标注，不能被当作已经实现。

归档文件不参与当前任务数、接口数和测试总数统计；历史各次专项可能重复覆盖，不可累加为新的验收总数。
