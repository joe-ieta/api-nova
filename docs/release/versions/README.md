# Product Release Documents

> Document status: Active release history location

每个产品 Git 标签创建一个目录：

```text
docs/release/versions/<tag>/
├── RELEASE_NOTES.md
└── QUICK_START.md
```

从 `docs/release/templates/` 中的模板开始，完成后必须在创建版本标签前提交。这些文件是版本归档目录和远端 Release 描述的长期事实来源。

发布后不要重写历史版本文档。会改变包行为或使用方式的修正应发布新标签；纯文字修正必须明确标注为发布后的文档更正。


## 版本索引

- `v1.7.5-rc.2`：三平台统一离线发布规范首个候选版本。
