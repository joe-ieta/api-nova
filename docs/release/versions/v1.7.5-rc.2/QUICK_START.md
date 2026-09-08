# ApiNova v1.7.5-rc.2 快速运行

本次仅提供 Windows x64 离线预发布包；不能用于 Linux 或 ARM64。不需要预装 Node.js，也不需要联网安装依赖。

## 启动

完整解压 `api-nova-release-v1.7.5-rc.2-win-x64.zip`，进入其唯一顶层目录，运行：

```bat
start.bat
```

浏览器访问 `http://127.0.0.1:9001/`。首次启动会从初始迁移创建 SQLite 结构并初始化账号；后续启动不会重建业务数据。

默认本地测试账号：`admin / admin@123456`。共享网络测试前，请修改 `.env` 中的 `SUPER_ADMIN_PASSWORD`、`JWT_SECRET` 和 `JWT_REFRESH_SECRET`。更改初始化密码不会覆盖已存在账号的密码。

## 验证

- UI：`http://127.0.0.1:9001/`
- 启动健康：`http://127.0.0.1:9001/api/health/live`，应返回 HTTP 200。
- 初始化状态：`http://127.0.0.1:9001/api/system/initialization`，应返回 HTTP 200。

## 文件位置

- 配置：包根目录 `.env`
- SQLite：`data/api-nova.db`
- 日志：`logs/`
- PID：`pids/`
- 内置运行时：`runtime/node/node.exe`

`DB_SYNCHRONIZE=false` 必须保留。不要把旧数据库复制到本次发布包；旧结构会被拒绝，不会自动转换或修补。

## 停止与回退

在启动终端按 `Ctrl+C`，进程停止后关闭窗口。回退时使用保留的旧包和旧包自己的数据库，不混用版本数据。

## 快速排查

- 确认系统是 Windows x64，且已完整解压，不在压缩软件内部运行。
- 确认端口 9001、9022 未被占用；若修改端口，请使用对应访问地址。
- 查看终端和 `logs/`；初始化失败时不会继续启动 API。
- 不要执行 `npm install`；缺少运行依赖说明包不完整。
- 本次实际发布物只在本地保存，远端标签不附带 ZIP 下载附件。
