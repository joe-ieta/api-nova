import { io, Socket } from "socket.io-client";
import type { SystemMetrics, MCPServer } from "@/types";

// 临时移除调试器导入，避免模块问题
// import { wsDebugger } from "@/utils/websocket-debug";

export interface WebSocketEvents {
  "runtime:overview": (payload: any) => void;
  "runtime:asset": (payload: any) => void;
  "runtime:event": (payload: any) => void;
  "runtime:log": (payload: any) => void;
  "runtime:alert": (payload: any) => void;
  "runtime:system-metrics": (metrics: SystemMetrics) => void;
  "runtime:server-metrics": (data: {
    serverId: string;
    metrics: SystemMetrics;
    summary?: any;
  }) => void;
  "runtime:server-status": (data: {
    serverId: string;
    status: MCPServer["status"];
    error?: string;
  }) => void;
  "runtime:process-info": (data: {
    serverId: string;
    processInfo: any;
  }) => void;
  "runtime:process-log": (data: {
    serverId: string;
    logData?: {
      id?: string;
      level?: string;
      message?: string;
      timestamp?: string | Date;
      source?: string;
      metadata?: Record<string, any>;
    };
    timestamp?: string | Date;
  }) => void;
  "server:created": (server: MCPServer) => void;
  "server:updated": (server: MCPServer) => void;
  "server:deleted": (serverId: string) => void;
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

  private mapRuntimeEventToServerStatus(payload: any): MCPServer["status"] | null {
    const family = String(payload?.family || "");
    const status = String(payload?.status || "").toLowerCase();

    if (family === "runtime.health") {
      return status === "failed" ? "error" : "running";
    }
    if (family === "runtime.lifecycle") {
      if (status === "failed") return "error";
      if (status === "offline") return "stopped";
      if (status === "degraded") return "starting";
      return "running";
    }

    return null;
  }

  private emitLegacyMetricsFromRuntimeOverview(payload: any): void {
    const metrics = payload?.data?.metrics;
    if (metrics) {
      this.emitEvent("runtime:system-metrics", metrics as SystemMetrics);
    }
  }

  private emitLegacyServerMetricsFromRuntimeAsset(payload: any): void {
    const observability = payload?.data?.normalizedObservability;
    const managedServerId =
      observability?.currentState?.managedServer?.id ||
      payload?.data?.runtimeSummary?.managedServer?.id;
    if (!managedServerId) {
      return;
    }

    const summary = observability?.metricsSummary || {};
    const eventPayload = {
      serverId: managedServerId,
      metrics: {
        totalRequests: Number(summary?.counters?.requestCount || 0),
        successfulRequests: Number(summary?.counters?.successCount || 0),
        failedRequests: Number(summary?.counters?.errorCount || 0),
        averageResponseTime: Number(summary?.latency?.averageMs || 0),
        activeConnections: 0,
        errorRate: 0,
        uptime: 0,
      } as any,
      summary,
    };

    this.emitEvent("runtime:server-metrics", eventPayload);
  }

  private emitLegacyProcessInfoFromRuntimeAsset(payload: any): void {
    const managedServerId =
      payload?.managedServerId ||
      payload?.data?.normalizedObservability?.currentState?.managedServer?.id ||
      payload?.data?.runtimeSummary?.managedServer?.id;
    const processInfo = payload?.liveProcessInfo;

    if (!managedServerId || !processInfo) {
      return;
    }

    const eventPayload = {
      serverId: managedServerId,
      processInfo,
    };

    this.emitEvent("runtime:process-info", eventPayload);
  }

  private emitLegacyServerStatusFromRuntimeEvent(payload: any): void {
    if (!payload?.managedServerId) {
      return;
    }

    const mappedStatus = this.mapRuntimeEventToServerStatus(payload);
    if (!mappedStatus) {
      return;
    }

    const eventPayload = {
      serverId: payload.managedServerId,
      status: mappedStatus,
      error:
        mappedStatus === "error"
          ? payload?.details?.errorMessage || payload?.summary
          : undefined,
    };

    this.emitEvent("runtime:server-status", eventPayload);
  }

  private emitLegacyProcessLogFromRuntimeLog(payload: any): void {
    if (!payload?.managedServerId) {
      return;
    }

    const eventPayload = {
      serverId: payload.managedServerId,
      logData: {
        id: payload.id,
        level: payload.level,
        message: payload.message,
        timestamp: payload.timestamp,
        source: payload.source,
        metadata: payload.details || undefined,
      },
      timestamp: payload.timestamp,
    };

    this.emitEvent("runtime:process-log", eventPayload);
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

    this.socket.on("runtime-overview", (data: any) => {
      this.emitEvent("runtime:overview", data);
      this.emitLegacyMetricsFromRuntimeOverview(data);
    });

    this.socket.on("runtime-asset-observability", (data: any) => {
      this.emitEvent("runtime:asset", data);
      this.emitLegacyServerMetricsFromRuntimeAsset(data);
      this.emitLegacyProcessInfoFromRuntimeAsset(data);
    });

    this.socket.on("runtime-event", (data: any) => {
      this.emitEvent("runtime:event", data);
      this.emitLegacyServerStatusFromRuntimeEvent(data);
    });

    this.socket.on("runtime-log", (data: any) => {
      this.emitEvent("runtime:log", data);
      this.emitLegacyProcessLogFromRuntimeLog(data);
    });

    this.socket.on("runtime-alert", (data: any) => {
      this.emitEvent("runtime:alert", data);
    });

    // 系统指标事件（修复事件名称不匹配问题）


    // 服务器指标事件已在下方处理

    // 服务器状态事件（修复事件名称不匹配问题）


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
  }

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
      "runtime:overview",
      "runtime:asset",
      "runtime:event",
      "runtime:log",
      "runtime:alert",
      "runtime:system-metrics",
      "runtime:server-metrics",
      "runtime:server-status",
      "runtime:process-info",
      "runtime:process-log",
      "server:created",
      "server:updated",
      "server:deleted",
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
    if (!serverId) return;
    this.emit("subscribe-runtime-asset", { serverId, interval: 5000 });
  }

  // 取消订阅特定服务器的更新
  unsubscribeFromServer(serverId: string): void {
    if (!serverId) return;
    this.emit("unsubscribe-runtime-asset", { serverId });
  }

  // 订阅系统指标更新
  subscribeToMetrics(): void {
    this.emit("subscribe-runtime-overview", { interval: 5000 });
  }

  // 取消订阅系统指标更新
  unsubscribeFromMetrics(): void {
    this.emit("unsubscribe-runtime-overview");
  }

  // 订阅日志更新
  subscribeToLogs(filter?: { level?: string[]; serverId?: string }): void {
    this.emit("subscribe-runtime-events", filter);
    this.emit("subscribe-runtime-alerts", {
      severity: ["warning", "error", "critical"],
    });
  }

  // 取消订阅日志更新
  unsubscribeFromLogs(): void {
    this.emit("unsubscribe-runtime-events");
  }

  // 订阅进程信息更新（强化版本）
  subscribeToProcessInfo(serverId: string): void {
    if (!serverId) return;
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
    this.emit("subscribe-runtime-asset", { serverId, interval: 5000 });
  }

  // 取消订阅进程信息更新
  unsubscribeFromProcessInfo(serverId: string): void {
    if (!serverId) return;
    // 兼容旧通用unsubscribe & 新事件
    this.emit("unsubscribe-runtime-asset", { serverId });
  }

  // 订阅进程日志更新
  subscribeToProcessLogs(serverId: string, level?: string): void {
    if (!serverId) return;
    this.emit("subscribe-runtime-events", {
      serverId,
      level: level ? [level] : undefined,
    });
  }

  // 取消订阅进程日志更新
  unsubscribeFromProcessLogs(serverId: string): void {
    if (!serverId) return;
    this.emit("unsubscribe-runtime-events", { serverId });
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
