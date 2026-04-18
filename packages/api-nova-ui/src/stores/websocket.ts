import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { websocketService, type WebSocketEvents } from "@/services/websocket";
import { useAppStore } from "./app";
import { useServerStore } from "./server";
import { useMonitoringStore } from "./monitoring";

export const useWebSocketStore = defineStore("websocket", () => {
  const appStore = useAppStore();

  // 状态
  const connected = ref(false);
  const connecting = ref(false);
  const reconnectAttempts = ref(0);
  const lastError = ref<string | null>(null);
  const subscriptions = ref<Set<string>>(new Set());
  const listenersInitialized = ref(false);

  // 计算属性
  const connectionStatus = computed(() => {
    if (connecting.value) return "connecting";
    if (connected.value) return "connected";
    return "disconnected";
  });

  const connectionInfo = computed(() => ({
    status: connectionStatus.value,
    connected: connected.value,
    reconnectAttempts: reconnectAttempts.value,
    lastError: lastError.value,
    subscriptions: Array.from(subscriptions.value),
  }));

  // Actions
  const setConnected = (value: boolean) => {
    connected.value = value;
  };

  const setConnecting = (value: boolean) => {
    connecting.value = value;
  };

  const setReconnectAttempts = (value: number) => {
    reconnectAttempts.value = value;
  };

  const setLastError = (error: string | null) => {
    lastError.value = error;
  };

  const normalizeEventType = (eventType: string) => {
    switch (eventType) {
      case "runtime:server-status":
        return "runtime:server-status";
      case "runtime:server-metrics":
        return "runtime:server-metrics";
      case "runtime:system-metrics":
        return "runtime:system-metrics";
      case "runtime:process-info":
        return "runtime:process-info";
      case "runtime:process-log":
        return "runtime:process-log";
      default:
        return eventType;
    }
  };

  // 连接WebSocket
  const connect = async (): Promise<boolean> => {
    if (connected.value || connecting.value) {
      return connected.value;
    }

    setConnecting(true);
    setLastError(null);

    try {
      await websocketService.connect();
      setConnected(true);
      setConnecting(false);

      appStore.addNotification({
        type: "success",
        title: "WebSocket连接成功",
        message: "实时数据更新已启用",
        duration:9000,
      });

      // 设置默认订阅
      await setupDefaultSubscriptions();

      return true;
    } catch (error) {
      setConnecting(false);
      const errorMessage =
        error instanceof Error ? error.message : "WebSocket连接失败";
      setLastError(errorMessage);

      appStore.addNotification({
        type: "error",
        title: "WebSocket连接失败",
        message: errorMessage,
        duration: 5000,
      });

      return false;
    }
  };

  // 重新连接后恢复订阅
  const restoreSubscriptions = () => {
    console.log("[WebSocketStore] Restoring subscriptions after reconnect");
    const currentSubscriptions = Array.from(subscriptions.value);

    currentSubscriptions.forEach((subscription) => {
      if (subscription.startsWith("runtime:process-info:")) {
        const serverId = subscription.replace("runtime:process-info:", "");
        if (!serverId) {
          return;
        }
        console.log(
          `[WebSocketStore] Restoring process info subscription for server: ${serverId}`,
        );
        websocketService.subscribeToProcessInfo(serverId);
      } else if (subscription.startsWith("runtime:process-log:")) {
        const serverId = subscription.replace("runtime:process-log:", "");
        if (!serverId) {
          return;
        }
        console.log(
          `[WebSocketStore] Restoring process logs subscription for server: ${serverId}`,
        );
        websocketService.subscribeToProcessLogs(serverId);
      }
    });
  };

  // 断开连接
  const disconnect = () => {
    websocketService.disconnect();
    setConnected(false);
    setConnecting(false);
    // 清理订阅状态
    subscriptions.value.clear();
    console.log("[WebSocketStore] Cleared all subscriptions on disconnect");

    appStore.addNotification({
      type: "info",
      title: "WebSocket已断开",
      message: "实时数据更新已停用",
      duration:9000,
    });
  };

  // 设置默认订阅
  const setupDefaultSubscriptions = async () => {
    // 订阅系统指标
    subscribeToMetrics();

    // 订阅日志
    subscribeToLogs();

    // 如果有选中的服务器，订阅其更新
    const serverStore = useServerStore();
    if (serverStore.selectedServerId) {
      subscribeToServer(serverStore.selectedServerId);
    }
  };

  // 订阅系统指标
  const subscribeToMetrics = () => {
    if (!connected.value) return;

    websocketService.subscribeToMetrics();
    subscriptions.value.add("metrics");
  };

  // 取消订阅系统指标
  const unsubscribeFromMetrics = () => {
    if (!connected.value) return;

    websocketService.unsubscribeFromMetrics();
    subscriptions.value.delete("metrics");
  };

  // 订阅服务器更新
  const subscribeToServer = (serverId: string) => {
    if (!connected.value || !serverId) return;

    websocketService.subscribeToServer(serverId);
    subscriptions.value.add(`server:${serverId}`);
  };

  // 取消订阅服务器更新
  const unsubscribeFromServer = (serverId: string) => {
    if (!connected.value || !serverId) return;

    websocketService.unsubscribeFromServer(serverId);
    subscriptions.value.delete(`server:${serverId}`);
  };

  // 订阅日志
  const subscribeToLogs = (filter?: {
    level?: string[];
    serverId?: string;
  }) => {
    if (!connected.value) return;

    websocketService.subscribeToLogs(filter);
    subscriptions.value.add("logs");
  };

  // 取消订阅日志
  const unsubscribeFromLogs = () => {
    if (!connected.value) return;

    websocketService.unsubscribeFromLogs();
    subscriptions.value.delete("logs");
  };

  // 订阅进程信息
  const subscribeToProcessInfo = (serverId: string) => {
    if (!serverId) {
      return;
    }

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[WebSocketStore] subscribeToProcessInfo called for server: ${serverId}`,
      );
    }

    if (!connected.value) {
      console.warn(
        "[WebSocketStore] Not connected, cannot subscribe to process info",
      );
      return;
    }

    const subscriptionKey = `runtime:process-info:${serverId}`;

    // 暂时移除重复订阅检查，确保订阅请求能够发送
    websocketService.subscribeToProcessInfo(serverId);
    subscriptions.value.add(subscriptionKey);
  };

  // 取消订阅进程信息
  const unsubscribeFromProcessInfo = (serverId: string) => {
    if (!connected.value || !serverId) return;

    websocketService.unsubscribeFromProcessInfo(serverId);
    subscriptions.value.delete(`runtime:process-info:${serverId}`);
  };

  // 订阅进程日志
  const subscribeToProcessLogs = (serverId: string) => {
    if (!serverId) {
      return;
    }

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[WebSocketStore] subscribeToProcessLogs called for server: ${serverId}`,
      );
    }

    if (!connected.value) {
      console.warn(
        "[WebSocketStore] Not connected, cannot subscribe to process logs",
      );
      return;
    }

    const subscriptionKey = `runtime:process-log:${serverId}`;

    // 暂时移除重复订阅检查，确保订阅请求能够发送
    websocketService.subscribeToProcessLogs(serverId);
    subscriptions.value.add(subscriptionKey);
  };

  // 取消订阅进程日志
  const unsubscribeFromProcessLogs = (serverId: string) => {
    if (!connected.value || !serverId) return;

    websocketService.unsubscribeFromProcessLogs(serverId);
    subscriptions.value.delete(`runtime:process-log:${serverId}`);
  };

  // 设置事件监听器
  const setupEventListeners = () => {
    const serverStore = useServerStore();
    const monitoringStore = useMonitoringStore();

    // 连接状态事件
    websocketService.on("connect", () => {
      setConnected(true);
      setConnecting(false);
      setReconnectAttempts(0);
      setLastError(null);
      monitoringStore.connectWebSocket();

      if (process.env.NODE_ENV === "development") {
        console.log(
          "[WebSocketStore] WebSocket connected, current subscriptions:",
          Array.from(subscriptions.value),
        );
      }

      // 不要清空订阅记录，这会导致重复订阅检查失效
      // 只在真正断开连接时才清空
    });

    websocketService.on("disconnect", () => {
      setConnected(false);
      setConnecting(false);
      monitoringStore.disconnectWebSocket();

      if (process.env.NODE_ENV === "development") {
        console.log("[WebSocketStore] WebSocket disconnected");
      }
    });

    websocketService.on("reconnect", () => {
      setConnected(true);
      setConnecting(false);
      setReconnectAttempts(0);
      monitoringStore.connectWebSocket();

      appStore.addNotification({
        type: "success",
        title: "WebSocket重连成功",
        message: "实时数据更新已恢复",
        duration:9000,
      });

      // 重连后恢复订阅
      restoreSubscriptions();
    });

    websocketService.on("connect_error", (error) => {
      setConnecting(false);
      const errorMessage = error.message || "WebSocket连接错误";
      setLastError(errorMessage);

      const info = websocketService.getConnectionInfo();
      setReconnectAttempts(info.reconnectAttempts);
    });

    // 系统指标事件
    websocketService.on("runtime:system-metrics", (metrics) => {
      monitoringStore.updateSystemMetrics(metrics);
      monitoringStore.scheduleRefresh("ws-metrics-system");
    });

    websocketService.on("runtime:overview", () => {
      monitoringStore.scheduleRefresh("ws-runtime-overview");
    });

    websocketService.on("runtime:asset", () => {
      monitoringStore.scheduleRefresh("ws-runtime-asset");
    });

    websocketService.on("runtime:event", () => {
      monitoringStore.scheduleRefresh("ws-runtime-event");
    });

    websocketService.on("runtime:log", (entry: any) => {
      monitoringStore.addLogEntry({
        id: entry.id,
        timestamp: new Date(entry.timestamp || Date.now()),
        level: entry.level || "info",
        message: entry.message,
        source: entry.source || "runtime",
        data: entry.details || null,
      } as any);
    });

    websocketService.on("runtime:alert", () => {
      monitoringStore.scheduleRefresh("ws-runtime-alert");
    });

    websocketService.on("runtime:server-metrics", (data) => {
      monitoringStore.updateServerMetrics(data.serverId, data.metrics);
      monitoringStore.scheduleRefresh("ws-metrics-server");
      serverStore.updateServerMetrics(data.serverId, {
        totalRequests: data.metrics.totalRequests,
        averageResponseTime: data.metrics.averageResponseTime,
      });
    });

    // 服务器状态事件
    websocketService.on("runtime:server-status", (data) => {
      serverStore.updateServerStatus(data.serverId, data.status, data.error);
      monitoringStore.scheduleRefresh("ws-server-status");

      if (data.status === "error" && data.error) {
        appStore.addNotification({
          type: "error",
          title: "服务器错误",
          message: `服务器 ${data.serverId} 发生错误: ${data.error}`,
          duration: 5000,
        });
      }
    });

    websocketService.on("server:created", (server) => {
      // 刷新服务器列表
      serverStore.fetchServers();

      appStore.addNotification({
        type: "success",
        title: "服务器已创建",
        message: `服务器 "${server.name}" 已创建`,
        duration:9000,
      });
    });

    websocketService.on("server:updated", (server) => {
      // 更新本地服务器数据
      const index = serverStore.servers.findIndex((s) => s.id === server.id);
      if (index > -1) {
        serverStore.servers[index] = server;
      }

      appStore.addNotification({
        type: "info",
        title: "服务器已更新",
        message: `服务器 "${server.name}" 配置已更新`,
        duration:9000,
      });
    });

    websocketService.on("server:deleted", (serverId) => {
      // 从本地列表中移除
      const index = serverStore.servers.findIndex((s) => s.id === serverId);
      if (index > -1) {
        const serverName = serverStore.servers[index].name;
        serverStore.servers.splice(index, 1);

        appStore.addNotification({
          type: "warning",
          title: "服务器已删除",
          message: `服务器 "${serverName}" 已被删除`,
          duration:9000,
        });
      }

      // 取消订阅
      unsubscribeFromServer(serverId);
    });

    // 日志事件
  };

  // 重连
  const reconnect = async (): Promise<boolean> => {
    if (connecting.value) return false;

    disconnect();
    await new Promise((resolve) => setTimeout(resolve, 1000)); // 等待1秒
    return await connect();
  };

  // 获取连接统计信息
  const getConnectionStats = () => {
    const info = websocketService.getConnectionInfo();
    return {
      ...info,
      subscriptions: Array.from(subscriptions.value),
    };
  };

  // 初始化
  const initialize = async () => {
    if (!listenersInitialized.value) {
      setupEventListeners();
      listenersInitialized.value = true;
    }

    // 如果全局设置启用了自动连接，则自动连接
    if (appStore.globalSettings.autoRefresh) {
      await connect();
    }
  };

  // 存储每个订阅的回调函数，用于精确取消订阅
  const subscriptionCallbacks = new Map<
    string,
    Map<string, (data: any) => void>
  >();

  // 通用订阅方法
  const subscribe = (
    eventType: string,
    callback: (data: any) => void,
    subscriptionId?: string,
  ) => {
    const normalizedEventType = normalizeEventType(eventType);
    // 生成唯一的订阅ID
    const id =
      subscriptionId ||
      `${normalizedEventType}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 存储回调函数
    if (!subscriptionCallbacks.has(normalizedEventType)) {
      subscriptionCallbacks.set(normalizedEventType, new Map());
    }
    subscriptionCallbacks.get(normalizedEventType)!.set(id, callback);

    switch (normalizedEventType) {
      case "runtime:server-status":
        websocketService.on("runtime:server-status", callback);
        break;
      case "runtime:server-metrics":
        websocketService.on("runtime:server-metrics", callback);
        break;
      case "runtime:system-metrics":
        websocketService.on("runtime:system-metrics", callback);
        break;
      case "runtime:process-info":
        websocketService.on("runtime:process-info", callback);
        break;
      case "runtime:process-log":
        websocketService.on("runtime:process-log", callback);
        break;
      default:
        // 对于其他事件类型，暂时不处理
        console.warn(`Unsupported event type: ${normalizedEventType}`);
        return null;
    }
    subscriptions.value.add(normalizedEventType);
    return id; // 返回订阅ID，用于后续取消订阅
  };

  // 通用取消订阅方法
  const unsubscribe = (eventType: string, subscriptionId?: string) => {
    const normalizedEventType = normalizeEventType(eventType);
    const callbacks = subscriptionCallbacks.get(normalizedEventType);

    if (subscriptionId && callbacks) {
      // 精确取消特定的订阅
      const callback = callbacks.get(subscriptionId);
      if (callback) {
        switch (normalizedEventType) {
          case "runtime:server-status":
            websocketService.off("runtime:server-status", callback);
            break;
          case "runtime:server-metrics":
            websocketService.off("runtime:server-metrics", callback);
            break;
          case "runtime:system-metrics":
            websocketService.off("runtime:system-metrics", callback);
            break;
          case "runtime:process-info":
            websocketService.off("runtime:process-info", callback);
            break;
          case "runtime:process-log":
            websocketService.off("runtime:process-log", callback);
            break;
        }
        callbacks.delete(subscriptionId);

        // 如果该事件类型没有更多回调，从订阅集合中移除
        if (callbacks.size === 0) {
          subscriptions.value.delete(normalizedEventType);
          subscriptionCallbacks.delete(normalizedEventType);
        }
      }
    } else {
      // 取消该事件类型的所有订阅（保持原有行为）
      switch (normalizedEventType) {
        case "runtime:server-status":
          websocketService.off("runtime:server-status");
          break;
        case "runtime:server-metrics":
          websocketService.off("runtime:server-metrics");
          break;
        case "runtime:system-metrics":
          websocketService.off("runtime:system-metrics");
          break;
        case "runtime:process-info":
          websocketService.off("runtime:process-info");
          break;
        case "runtime:process-log":
          websocketService.off("runtime:process-log");
          break;
        default:
          console.warn(`Unsupported event type: ${normalizedEventType}`);
      }
      subscriptions.value.delete(normalizedEventType);
      subscriptionCallbacks.delete(normalizedEventType);
    }
  };

  return {
    // 状态
    connected,
    connecting,
    reconnectAttempts,
    lastError,
    subscriptions,

    // 计算属性
    connectionStatus,
    connectionInfo,

    // WebSocket服务实例（用于调试）
    websocketService,

    // Actions
    connect,
    disconnect,
    reconnect,
    subscribe,
    unsubscribe,
    subscribeToMetrics,
    unsubscribeFromMetrics,
    subscribeToServer,
    unsubscribeFromServer,
    subscribeToLogs,
    unsubscribeFromLogs,
    subscribeToProcessInfo,
    unsubscribeFromProcessInfo,
    subscribeToProcessLogs,
    unsubscribeFromProcessLogs,
    getConnectionStats,
    initialize,
    restoreSubscriptions,
  };
});
