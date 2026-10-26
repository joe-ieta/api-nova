---
doc-version: 1.3.0
doc-status: active
doc-updated: 2026-10-26
---
# 发布构建操作说明

发布契约唯一来源为[RELEASE_STANDARD](../../RELEASE_STANDARD.md)，本文只提供操作导航，不重复维护另一套发布标准。三平台需要同一tag/commit/锁文件/Node精确版本，全部原生离线验证后才能归档、晋升、推标签和上传。

## Run From A Source Checkout

源码准备、环境文件、数据库初始化与三个终端命令统一见[部署手册](../guides/DEPLOYMENT.md#源码启动)。源启动不是离线包验收，根npm run dev不能单独启动完整产品。

## Official Release Packaging

1. 核对授权范围、发布分支、干净同步提交和不存在的目标标签。
2. 按templates提交`docs/release/versions/<tag>/RELEASE_NOTES.md`、QUICK_START.md；构建器替换实际commit占位符。
3. 按发布规范完成package-manager/runtime-closure/test/type-check/lint/build门禁，并保留warning及依赖风险说明。
4. 在各匹配原生平台执行`build-release-artifact.ps1`；底层`package-release.ps1 -Mode OfflineCurrentPlatform -IncludeNode`只能输出全新.staging目录。
5. 检查暂存及最终新解压离线启动、默认账号/秘密、空data/logs/pids、版本/平台/锁哈希、文档和校验和。
6. 三个平台齐备后生成Manifest/SHA256，完整保留旧latest/data到backups，原子晋升后最后写CURRENT_RELEASE.json。
7. 对精确源commit创建注释tag，推送并上传同字节七附件；没有完整产物不能称发布完成。

已有脚本：`scripts/build-release-artifact.ps1`、`scripts/test-release-package.ps1`、`scripts/create-release-manifest.ps1`、`scripts/promote-release-set.ps1`，CI为`.github/workflows/release-artifacts.yml`。所需参数以脚本param块及标准为准，不能把包含尖括号的路径示意直接当运行命令。

发布容器的latest/archive/backups/evidence不得作为底层打包输出。只在.staging新目录构建；已发布版本不原地覆盖，历史业务库不清理。完整文档随下一次新版本构建交付，见[文档交付说明](./DOCUMENTATION.md)。
