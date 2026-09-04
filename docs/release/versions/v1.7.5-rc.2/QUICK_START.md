# ApiNova v1.7.5-rc.2 快速运行

选择与当前系统和 CPU 一致的完整离线包。请先完整解压，不要在压缩软件中直接运行。

## 启动

Windows x64：

```bat
start.bat
```

Linux x64 或 ARM64：

```bash
./start.sh
```

浏览器访问 `http://127.0.0.1:9001/`。

默认本地测试账号：

```text
用户名：admin
密码：admin@123456
```

在共享网络测试前，请修改 `.env` 中的默认密码、`JWT_SECRET` 和 `JWT_REFRESH_SECRET`。

## 验证

访问 `http://127.0.0.1:9001/api/health/live`，成功启动应返回 HTTP `200`。

## 文件位置

- 配置：`.env`
- SQLite 数据库：`data/api-nova.db`
- 日志：`logs/`
- PID：`pids/`

## 停止

在启动终端按 `Ctrl+C`。

## 快速排查

- 确认包的平台与当前操作系统和 CPU 一致；
- 确认端口 `9001`、`9022` 未被占用；
- 查看启动窗口和 `logs/`；
- 不要执行 `npm install`，包内已经包含 Node.js 和全部运行依赖。