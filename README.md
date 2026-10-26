---
doc-version: 1.2.0
doc-status: active
doc-updated: 2026-10-26
---
# ApiNova · 达雅

**语言**：中文 | [English](./README_EN.md)

ApiNova把已有HTTP API整理为可治理的能力资产，通过HTTP Gateway提供应用调用，通过MCP Tools提供模型和Agent接入。产品流程是注册→测试→治理→发布→运行观察。

仓库包含Parser共享内核、Server MCP运行时、API控制面/Gateway和UI。默认SQLite，也支持PostgreSQL；MCP支持stdio、streamable、sse。定位为应用内部的API能力交付，不承诺企业全流量网关或任意协议转换。

当前候选 **v1.7.6-rc.6** 是人工测试预发布，生产签收仍开放。2026-10-26合并后依赖审计有7个high、9个moderate包节点，处置见[open-items](./docs/reference/open-items.md)；本版本在main执行三平台完整候选发布，生产签收另行保留。

## 从这里阅读

| 需要 | 文档 |
| --- | --- |
| 第一次了解项目 | [能力定位](./docs/overview/PRODUCT.md)、[总体设计](./docs/architecture/OVERALL_DESIGN.md) |
| 安装和使用 | [部署手册](./docs/guides/DEPLOYMENT.md)、[使用手册](./docs/guides/USER_GUIDE.md) |
| 自定义UI/系统集成 | [开发手册](./docs/development/DEVELOPER_GUIDE.md)、[API手册](./docs/api/README.md) |
| 当前剩余与验收 | [open-items](./docs/reference/open-items.md)、[项目基线](./docs/baseline/PROJECT_BASELINE.md) |
| 最新文档和阅读顺序 | [文档中心](./docs/README.md)、[现行清单](./docs/VERSIONS.md) |
| 发布交付 | [发布规范](./RELEASE_STANDARD.md)、[当前版本指南](./docs/release/versions/v1.7.6-rc.6/QUICK_START.md) |

## 运行

下载匹配OS/CPU的[rc.6离线包](https://github.com/joe-ieta/api-nova/releases/tag/v1.7.6-rc.6)，完整解压；Windows执行start.bat，Linux执行./start.sh，打开`http://127.0.0.1:9001/`。公开本地测试账号为admin / admin@123456，网络共享前修改管理员密码和独立JWT秘密；完整步骤见部署手册。

源码开发从根目录执行`npm ci`、`npm run build`，再按部署手册分别启动API/UI/Server。根dev命令不启动完整产品API。不要把npm workspace版本当作产品Git标签，也不要混用不同平台依赖。

## 来源与维护

ApiNova起源于[mcp-swagger-server](https://github.com/zaizaizhao/mcp-swagger-server)，在OpenAPI/Swagger解析与MCP工具生成基础上独立演进。顶层约束见[产品约束](./docs/baseline/PRODUCT_CONSTRAINTS.md)。历史计划、审计和旧版本说明已归档到[历史索引](./docs/archive/README.md)，不作为当前功能或签收结论。
