# ApiNova v1.7.6-rc.3 快速运行

本版本为候选测试版，尚未完成生产环境签收。仅使用与当前系统和CPU匹配的离线包：Windows x64、Ubuntu 24.04 x64或Ubuntu 24.04 ARM64。

## 启动

完整解压后，Windows运行 `start.bat`；Linux运行 `./start.sh`。首次启动无需下载依赖，也不要执行npm install。

浏览器访问 http://127.0.0.1:9001/ 。

默认本地测试账号：`admin / admin@123456`。共享网络使用前先修改.env中的管理员密码、JWT_SECRET和JWT_REFRESH_SECRET。公开默认JWT值分别为api-nova-local-release-change-me和api-nova-local-release-refresh-change-me。

## 验证

http://127.0.0.1:9001/api/health/live 返回200表示API存活。完整 http://127.0.0.1:9001/health 还检查内存、至少5GiB可用磁盘及MCP服务；MCP未启动时503不等于磁盘不足。顶部UI健康徽标仍含模拟数据，不作为签收依据。

## 文件位置与停止

配置在.env，SQLite在data/api-nova.db，日志在logs/，PID在pids/。在启动终端按Ctrl+C停止。升级前将运行数据备份到目录外，恢复旧版本时同时恢复对应数据备份。

## 排查

确认平台/CPU匹配、9001和9022端口未被占用、Windows C盘或Linux根目录可用空间至少5GiB；查看启动窗口和logs/。授权、Registry、MCP及观测开关按部署合同配置，详细限制见RELEASE_NOTES.md。
