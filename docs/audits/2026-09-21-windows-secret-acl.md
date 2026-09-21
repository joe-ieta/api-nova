---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-C2-02 Windows秘密文件ACL验收

起点d38976e，最终代码版本为包含本报告的提交。Windows、Node24.15.0，本地NTFS合成目录；没有读取现有秘密或修改仓库/系统权限。锁文件SHA256 `9eb15cc0265e1366483cc340ee6e7e55638af3ed558eb09dc1a5bb032f3f2a54`。

读取使用固定PowerShell/C# helper调用原生CreateFile/GetSecurityInfo，路径只作为数据。受保护根及其下目录/文件由当前用户拥有，仅允许当前用户、SYSTEM、Administrators；祖先拒绝陌生主体删除子项或改ACL/所有者。检查原生句柄、拒绝重解析点和硬链接、读前后核对ACL与文件元数据，固定错误不泄漏秘密和路径。

主任务执行 `node packages/api-nova-parser/scripts/test-upstream-secret-provider-windows.cjs`：28/28、0跳过、47.1秒、退出0。包含合法读取/轮换、Everyone文件/目录越权、继承、祖先权限、junction、硬链接、写句柄冲突、大小/编码/换行/设备名/ADS及4 helper并发时无关docs文件可持续写入。原Provider基线83项中52通过、31平台跳过；30个Linux场景并未在Linux运行。Parser构建通过。

执行者原始日志：`tmp/windows-secret-acl-acceptance.log`和`tmp/windows-secret-provider-base-regression.log`，本地临时文件不随发布保证交付。脚本：[Windows专项](../../packages/api-nova-parser/scripts/test-upstream-secret-provider-windows.cjs)，实现：[原生读取](../../packages/api-nova-parser/src/credentials/windows-secret-file.ts)。

仅支持本地驱动器，拒绝UNC及未知ACE。依赖系统Windows PowerShell5.1与Add-Type，不可用时拒绝读取；每次读取启动helper，有启动开销，未完成吞吐验收。只关闭C2-02，C2-01 Linux权限仍NEED_ENV。
