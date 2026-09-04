# ApiNova <tag> 快速运行

适用平台：`<win-x64|linux-x64|linux-arm64>`

这是完全离线包。启动前请完整解压，不要在压缩软件中直接运行，也不要在其他操作系统或 CPU 架构上使用。

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

在共享网络测试前，请修改 `.env` 中的默认密码和 JWT 密钥。

## 验证

访问 `http://127.0.0.1:9001/api/health/live`，成功启动应返回 HTTP `200`。

## 文件位置

- 配置：`.env`
- SQLite 数据库：`data/api-nova.db`
- 日志：`logs/`
- PID：`pids/`

## 停止

在启动终端按 `Ctrl+C`。Windows 下进程停止后可关闭 `start.bat` 窗口。

## 快速排查

- 确认包的平台与当前操作系统和 CPU 一致；
- 确认端口 `9001`、`9022` 未被占用；
- 查看启动窗口和 `logs/`；
- 不要执行 `npm install`，完整发布包已经包含全部运行依赖。
