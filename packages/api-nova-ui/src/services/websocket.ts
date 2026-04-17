import { io, Socket } from "socket.io-client";
import type { SystemMetrics, LogEntry, MCPServer } from "@/types";

// 临时移除调试器导入，避免模块问题
// import { wsDebugger } from "@/utils/websocket-debug";

export interface WebSocketEvents {
  // 系统指标更新
  "metrics:system": (metrics: SystemMetrics) => void;
  "metrics:server": (data: {
    serverId: string;
    metrics: SystemMetrics;
  }) => void;

  // 服务器状态更新
  "server:status": (data: {
    serverId: string;
    status: MCPServer["status"];
    error?: string;
  }) => void;
  "server:created": (server: MCPServer) => void;
  "server:updated": (server: MCPServer) => void;
  "server:deleted": (serverId: string) => void;

  // 进程信息更新
  "process:info": (data: {
    serverId: string;
    processInfo: {
      process: {
        pid: number;
        name: string;
        status: string;
        startTime: Date;
        uptime: number;
      };
      resources: {
        cpu: number;
        memory: number;
        handles?: number;
        threads?: number;
      };
      system: {
        platform: string;
        arch: string;
        nodeVersion: string;
      };
      details: any;
    };
  }) => void;
  "process:logs": (data: {
    serverId: string;
    logs: Array<{
      serverId: string;
      pid: number;
      timestamp: Date;
      level: string;
      source: string;
      message: string;
      metadata?: Record<string, any>;
    }>;
  }) => void;

  // 日志更新
  "logs:new": (entry: LogEntry) => void;
  "logs:batch": (entries: LogEntry[]) => void;

  // 连接状态事件
  connect: () => void;
  disconnect: () => void;
  reconnect: () => void;
  connect_error: (error: Error) => void;
}

export class WebSocketService {
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isConnecting = false;
  private eventHandlers = new Map<keyof WebSocketEvents, Function[]>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private connectionCheckInterval: NodeJS.Timeout | null = null;

  // 调试开关（与后端 WS_DEBUG 对齐）
  private readonly DEBUG = (import.meta as any).env?.VITE_WS_DEBUG === "true";
  private d(...args: any[]) {
    if (this.DEBUG) console.log("[WebSocketService]", ...args);
  }

  constructor(private url: string = "/monitoring") {
    this.setupEventHandlers();
  }

  // 连接WebSocket
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.d("Attempting to connect to:", this.url);

      if (this.socket?.connected) {
        console.log("[WebSocketService] Already connected");
        resolve();
        return;
      }

      if (this.isConnecting) {
        console.log("[WebSocketService] Connection already in progress");
        reject(new Error("Connection already in progress"));
        return;
      }

      if (this.socket && !this.socket.connected) {
        console.log("[WebSocketService] Reusing existing socket connection...");
        this.isConnecting = true;
        this.socket.once("connect", () => {
          this.isConnecting = false;
          resolve();
        });
        this.socket.once("connect_error", (error) => {
          this.isConnecting = false;
          reject(error);
        });
        this.socket.connect();
        return;
      }

      this.isConnecting = true;

      try {
        console.log("[WebSocketService] Creating socket.io connection...");
        this.socket = io(this.url, {
          transports: ["websocket", "polling"],
          timeout: 20000,
          reconnection: true,
          reconnectionAttempts: this.maxReconnectAttempts,
          reconnectionDelay: this.reconnectDelay,
          autoConnect: false,
          // 添加更多配置以提高连接稳定性
          upgrade: true,
          rememberUpgrade: true,
          // 添加详细的连接信息
          query: {
            clientType: "ui",
            timestamp: Date.now().toString(),
          },
        });

        this.setupSocketEventHandlers();

        console.log("[WebSocketService] Initiating connection...");
        this.socket.connect();

        this.socket.once("connect", () => {
          console.log("[WebSocketService] WebSocket connected successfully!");
          console.log("[WebSocketService] Socket ID:", this.socket?.id);
          console.log(
            "[WebSocketService] Transport:",
            this.socket?.io?.engine?.transport?.name,
          );
          console.log("[WebSocketService] Connection details:", {
            connected: this.socket?.connected,
            disconnected: this.socket?.disconnected,
            transport: this.socket?.io?.engine?.transport?.name,
          });

          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          this.startConnectionCheck();
          this.emitEvent("connect");
          resolve();
        });

        this.socket.once("connect_error", (error) => {
          console.error(
            "[WebSocketService] WebSocket connection error:",
            error,
          );
          console.error("[WebSocketService] Error details:", {
            message: error.message,
            description: (error as any).description,
            context: (error as any).context,
            type: (error as any).type,
            data: (error as any).data,
          });
          this.isConnecting = false;
          this.emitEvent("connect_error", error);
          reject(error);
        });

        // 添加更多调试事件
        this.socket.on("disconnect", (reason) => {
          console.log("[WebSocketService] Disconnected:", reason);
        });

        this.socket.on("reconnect_attempt", (attemptNumber) => {
          console.log("[WebSocketService] Reconnect attempt:", attemptNumber);
        });

        this.socket.on("reconnect_error", (error) => {
          console.error("[WebSocketService] Reconnect error:", error);
        });

        this.socket.on("reconnect_failed", () => {
          console.error("[WebSocketService] Reconnect failed");
        });

        // 添加连接状态事件监听
        this.socket.on(
          "connection-stats",
          (data: {
            totalClients: number;
            activeRooms: string[];
            timestamp: string;
          }) => {
            if (process.env.NODE_ENV === "development") {
              console.log(`[WebSocketService] Connection stats:`, data);
            }
          },
        );
      } catch (error) {
        console.error("[WebSocketService] Error creating socket:", error);
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  // 断开连接
  disconnect(): void {
    console.log("[WebSocketService] 🔌 Manually disconnecting WebSocket...");
    this.stopHeartbeat();
    this.stopConnectionCheck();

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnecting = false;
    this.reconnectAttempts = 0;
  }

  // 开始心跳检查
  private startHeartbeat(): void {
    this.stopHeartbeat(); // 确保没有重复的心跳
    this.heartbeatInterval = setInterval(() => {
      if (this.socket?.connected) {
        console.log("[WebSocketService] 💓 Sending heartbeat ping");
        this.socket.emit("ping", { timestamp: Date.now() });
      }
    }, 30000); // 每30秒发送一次心跳
  }

  // 停止心跳检查
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // 开始连接状态检查
  private startConnectionCheck(): void {
    this.stopConnectionCheck(); // 确保没有重复的检查
    this.connectionCheckInterval = setInterval(() => {
      if (!this.socket?.connected && !this.isConnecting) {
        console.log(
          "[WebSocketService] 🔍 Connection lost detected, attempting reconnect...",
        );
        this.attemptReconnect();
      }
    }, 10000); // 每10秒检查一次连接状态
  }

  // 停止连接状态检查
  private stopConnectionCheck(): void {
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
      this.connectionCheckInterval = null;
    }
  }

  // 检查连接状态
  isConnected(): boolean {
    return this.socket?.connected || false;
  }

  // 设置Socket事件处理器
  private setupSocketEventHandlers(): void {
    if (!this.socket) return;

    this.d("Setting up socket event handlers");

    // 连接状态事件
    this.socket.on("disconnect", (reason) => {
      console.log("[WebSocketService] WebSocket disconnected:", reason);
      console.log("[WebSocketService] Disconnect details:", {
        reason,
        connected: this.socket?.connected,
        disconnected: this.socket?.disconnected,
        transport: this.socket?.io?.engine?.transport?.name,
      });

      this.emitEvent("disconnect");

      // 根据断开原因决定是否重连
      if (reason === "io server disconnect") {
        console.log(
          "[WebSocketService] Server initiated disconnect, attempting reconnect...",
        );
        this.attemptReconnect();
      } else if (reason === "transport close" || reason === "transport error") {
        console.log(
          "[WebSocketService] Transport issue, attempting reconnect...",
        );
        this.attemptReconnect();
      } else {
        console.log(
          "[WebSocketService] Client initiated disconnect, no reconnect needed",
        );
      }
    });

    this.socket.on("reconnect", () => {
      console.log("WebSocket reconnected");
      this.reconnectAttempts = 0;
      this.emitEvent("reconnect");
    });

    // 系统指标事件（修复事件名称不匹配问题）
    this.socket.on(
      "system-metrics-update",
      (data: { data: SystemMetrics; timestamp: string }) => {
        this.emitEvent("metrics:system", data.data);
      },
    );

    this.socket.on(
      "initial-system-metrics",
      (data: { data: SystemMetrics; timestamp: string }) => {
        this.emitEvent("metrics:system", data.data);
      },
    );

    // 服务器指标事件已在下方处理

    // 服务器状态事件（修复事件名称不匹配问题）
    this.socket.on(
      "server-status-changed",
      (data: { serverId: string; status: string; timestamp: string }) => {
        this.emitEvent("server:status", {
          serverId: data.serverId,
          status: data.status as MCPServer["status"],
        });
      },
    );

    this.socket.on(
      "server-health-changed",
      (data: {
        serverId: string;
        healthy: boolean;
        error?: string;
        timestamp: string;
      }) => {
        this.emitEvent("server:status", {
          serverId: data.serverId,
          status: data.healthy ? "running" : ("error" as MCPServer["status"]),
          error: data.error,
        });
      },
    );

    // 服务器CRUD事件（这些可能需要后端添加支持）
    this.socket.on("server:created", (server: MCPServer) => {
      this.emitEvent("server:created", server);
    });

    this.socket.on("server:updated", (server: MCPServer) => {
      this.emitEvent("server:updated", server);
    });

    this.socket.on("server:deleted", (serverId: string) => {
      this.emitEvent("server:deleted", serverId);
    });

    // 进程信息事件
    this.socket.on(
      "process:info",
      (data: { serverId: string; processInfo: any }) => {
        this.emitEvent("process:info", data);
      },
    );

    this.socket.on(
      "process:logs",
      (data: { serverId: string; logs: any[] }) => {
        this.emitEvent("process:logs", data);
      },
    );

    // 移除server-metrics-update事件监听器，因为后端现在直接发送process:info事件
    // 保留注释以备将来参考
    // this.socket.on("server-metrics-update", (data: {
    //   serverId: string;
    //   data: any;
    //   timestamp: string;
    // }) => {
    //   this.d('server-metrics-update <-', data.serverId, 'ts', data.timestamp);
    //   this.emitEvent("process:info", {
    //     serverId: data.serverId,
    //     processInfo: data.data
    //   });
    // });

    // 订阅确认事件（修复事件名称不匹配问题）
    this.socket.on(
      "subscription-confirmed",
      (data: {
        room: string;
        serverId?: string;
        interval?: number;
        timestamp: string;
      }) => {
        if (this.DEBUG)
          console.log(`[WebSocketService] Subscription confirmed:`, data);
      },
    );

    // 取消订阅确认事件
    this.socket.on(
      "unsubscription-confirmed",
      (data: { room: string; timestamp: string }) => {
        if (process.env.NODE_ENV === "development") {
          console.log(`[WebSocketService] Unsubscription confirmed:`, data);
        }
      },
    );

    // 日志事件（修复事件名称不匹配问题）
    this.socket.on(
      "server-log",
      (data: {
        serverId: string;
        level: string;
        message: string;
        source: string;
        timestamp: string;
      }) => {
        const logEntry: LogEntry = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date(data.timestamp),
          level: data.level as LogEntry["level"],
          message: data.message,
          source: data.source,
          serverId: data.serverId,
        };
        this.emitEvent("logs:new", logEntry);
      },
    );

    // 告警事件
    this.socket.on(
      "alert",
      (data: {
        id: string;
        type: string;
        severity: string;
        serverId?: string;
        message: string;
        source?: string;
        timestamp: string;
      }) => {
        const logEntry: LogEntry = {
          id: data.id,
          timestamp: new Date(data.timestamp),
          level: data.severity as LogEntry["level"],
          message: data.message,
          source: data.source || "alert",
          serverId: data.serverId,
        };
        this.emitEvent("logs:new", logEntry);
      },
    );

    // 保留原有的批量日志事件（如果后端有发送）
    this.socket.on("logs:batch", (entries: LogEntry[]) => {
      this.emitEvent("logs:batch", entries);
    });
  }

  // 尝试重连
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // 指数退避

    console.log(
      `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms`,
    );

    setTimeout(() => {
      if (!this.isConnected()) {
        this.connect().catch((error) => {
          console.error("Reconnection failed:", error);
        });
      }
    }, delay);
  }

  // 设置事件处理器
  private setupEventHandlers(): void {
    // 初始化事件处理器映射
    const eventKeys: (keyof WebSocketEvents)[] = [
      "metrics:system",
      "metrics:server",
      "server:status",
      "server:created",
      "server:updated",
      "server:deleted",
      "process:info",
      "process:logs",
      "logs:new",
      "logs:batch",
      "connect",
      "disconnect",
      "reconnect",
      "connect_error",
    ];

    eventKeys.forEach((event) => {
      this.eventHandlers.set(event, []);
    });
  }

  // 注册事件监听器
  on<K extends keyof WebSocketEvents>(
    event: K,
    handler: WebSocketEvents[K],
  ): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  // 移除事件监听器
  off<K extends keyof WebSocketEvents>(
    event: K,
    handler?: WebSocketEvents[K],
  ): void {
    const handlers = this.eventHandlers.get(event) || [];

    if (handler) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    } else {
      // 如果没有指定处理器，清除所有处理器
      this.eventHandlers.set(event, []);
    }
  }

  // 触发事件
  private emitEvent<K extends keyof WebSocketEvents>(
    event: K,
    ...args: Parameters<WebSocketEvents[K]>
  ): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach((handler) => {
      try {
        (handler as Function)(...args);
      } catch (error) {
        console.error(`Error in WebSocket event handler for ${event}:`, error);
      }
    });
  }

  // 发送消息到服务器（增强版本）
  emit(event: string, data?: any): void {
    if (this.socket?.connected) {
      this.d("emit", event, data);
      this.socket.emit(event, data);
      if (event.includes("subscribe") && this.DEBUG) {
        setTimeout(() => {
          this.d("post-subscription status check for", event);
          this.socket?.emit("get-connection-status");
        }, 3000);
      }
    } else if (this.DEBUG) {
      console.warn("[WebSocketService] emit while disconnected", event, data);
    }
  }

  // 订阅特定服务器的更新
  subscribeToServer(serverId: string): void {
    this.emit("subscribe:server", { serverId });
  }

  // 取消订阅特定服务器的更新
  unsubscribeFromServer(serverId: string): void {
    this.emit("unsubscribe:server", { serverId });
  }

  // 订阅系统指标更新
  subscribeToMetrics(): void {
    this.emit("subscribe:metrics");
  }

  // 取消订阅系统指标更新
  unsubscribeFromMetrics(): void {
    this.emit("unsubscribe:metrics");
  }

  // 订阅日志更新
  subscribeToLogs(filter?: { level?: string[]; serverId?: string }): void {
    this.emit("subscribe:logs", filter);
  }

  // 取消订阅日志更新
  unsubscribeFromLogs(): void {
    this.emit("unsubscribe:logs");
  }

  // 订阅进程信息更新（强化版本）
  subscribeToProcessInfo(serverId: string): void {
    if (!this.socket?.connected) {
      if (this.DEBUG)
        console.warn(
          "[WebSocketService] Socket not connected, defer subscribeToProcessInfo",
          serverId,
        );
      this.connect()
        .then(() =>
          setTimeout(() => this.subscribeToProcessInfo(serverId), 500),
        )
        .catch(() => {});
      return;
    }
    this.emit("subscribe-server-metrics", { serverId, interval: 5000 });
  }

  // 取消订阅进程信息更新
  unsubscribeFromProcessInfo(serverId: string): void {
    // 兼容旧通用unsubscribe & 新事件
    this.emit("unsubscribe", { room: `server-metrics-${serverId}` });
    this.emit("unsubscribe-server-metrics", { serverId });
  }

  // 订阅进程日志更新
  subscribeToProcessLogs(serverId: string, level?: string): void {
    this.emit("subscribe-server-logs", { serverId, level });
  }

  // 取消订阅进程日志更新
  unsubscribeFromProcessLogs(serverId: string): void {
    this.emit("unsubscribe", { room: `server-logs-${serverId}` });
    this.emit("unsubscribe-server-logs", { serverId });
  }

  // 获取连接状态信息
  getConnectionInfo(): {
    connected: boolean;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
    isConnecting: boolean;
  } {
    return {
      connected: this.isConnected(),
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      isConnecting: this.isConnecting,
    };
  }
}

// 创建全局WebSocket服务实例
export const websocketService = new WebSocketService("/monitoring");

// 导出类型已在文件顶部定义
