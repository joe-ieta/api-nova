import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { websocketService, type WebSocketEvents } from "@/services/websocket";
import type { MCPServer } from "@/types";
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

  const runtimeEvents = new Set<keyof WebSocketEvents>([
    "runtime:overview", "runtime:asset", "runtime:event", "runtime:log", "runtime:alert",
  ]);

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
        const runtimeAssetId = subscription.replace("runtime:process-info:", "");
        if (!runtimeAssetId) {
          return;
        }
        console.log(
          `[WebSocketStore] Restoring process info subscription for runtime asset: ${runtimeAssetId}`,
        );
        websocketService.subscribeToProcessInfo(runtimeAssetId);
      } else if (subscription.startsWith("runtime:process-log:")) {
        const runtimeAssetId = subscription.replace("runtime:process-log:", "");
        if (!runtimeAssetId) {
          return;
        }
        console.log(
          `[WebSocketStore] Restoring process logs subscription for runtime asset: ${runtimeAssetId}`,
        );
        websocketService.subscribeToProcessLogs(runtimeAssetId);
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
  const subscribeToRuntimeAsset = (runtimeAssetId: string) => {
    if (!connected.value || !runtimeAssetId) return;

    websocketService.subscribeToRuntimeAsset(runtimeAssetId);
    subscriptions.value.add(`runtime-asset:${runtimeAssetId}`);
  };

  // 取消订阅服务器更新
  const unsubscribeFromRuntimeAsset = (runtimeAssetId: string) => {
    if (!connected.value || !runtimeAssetId) return;

    websocketService.unsubscribeFromRuntimeAsset(runtimeAssetId);
    subscriptions.value.delete(`runtime-asset:${runtimeAssetId}`);
  };

  // 订阅日志
  const subscribeToLogs = (filter?: {
    level?: string[];
    runtimeAssetId?: string;
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
  const subscribeToProcessInfo = (runtimeAssetId: string) => {
    if (!runtimeAssetId) {
      return;
    }

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[WebSocketStore] subscribeToProcessInfo called for runtime asset: ${runtimeAssetId}`,
      );
    }

    if (!connected.value) {
      console.warn(
        "[WebSocketStore] Not connected, cannot subscribe to process info",
      );
      return;
    }

    const subscriptionKey = `runtime:process-info:${runtimeAssetId}`;

    // 暂时移除重复订阅检查，确保订阅请求能够发送
    websocketService.subscribeToProcessInfo(runtimeAssetId);
    subscriptions.value.add(subscriptionKey);
  };

  // 取消订阅进程信息
  const unsubscribeFromProcessInfo = (runtimeAssetId: string) => {
    if (!connected.value || !runtimeAssetId) return;

    websocketService.unsubscribeFromProcessInfo(runtimeAssetId);
    subscriptions.value.delete(`runtime:process-info:${runtimeAssetId}`);
  };

  // 订阅进程日志
  const subscribeToProcessLogs = (runtimeAssetId: string) => {
    if (!runtimeAssetId) {
      return;
    }

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[WebSocketStore] subscribeToProcessLogs called for runtime asset: ${runtimeAssetId}`,
      );
    }

    if (!connected.value) {
      console.warn(
        "[WebSocketStore] Not connected, cannot subscribe to process logs",
      );
      return;
    }

    const subscriptionKey = `runtime:process-log:${runtimeAssetId}`;

    // 暂时移除重复订阅检查，确保订阅请求能够发送
    websocketService.subscribeToProcessLogs(runtimeAssetId);
    subscriptions.value.add(subscriptionKey);
  };

  // 取消订阅进程日志
  const unsubscribeFromProcessLogs = (runtimeAssetId: string) => {
    if (!connected.value || !runtimeAssetId) return;

    websocketService.unsubscribeFromProcessLogs(runtimeAssetId);
    subscriptions.value.delete(`runtime:process-log:${runtimeAssetId}`);
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

    websocketService.on("runtime:overview", (payload) => {
      if (payload?.data?.metrics) monitoringStore.updateSystemMetrics(payload.data.metrics);
      monitoringStore.scheduleRefresh("ws-runtime-overview");
    });

    websocketService.on("runtime:asset", (payload) => {
      const observability = payload?.data?.normalizedObservability;
      const managedServerId = observability?.currentState?.managedServer?.id ||
        payload?.data?.runtimeSummary?.managedServer?.id;
      if (managedServerId) {
        const summary = observability?.metricsSummary;
        if (summary) serverStore.updateServerMetrics(managedServerId, {
          totalRequests: Number(summary.counters?.requestCount || 0),
          successfulRequests: Number(summary.counters?.successCount || 0),
          failedRequests: Number(summary.counters?.errorCount || 0),
          averageResponseTime: Number(summary.latency?.averageMs || 0),
        });
      }
      monitoringStore.scheduleRefresh("ws-runtime-asset");
    });

    websocketService.on("runtime:event", (payload) => {
      if (payload?.managedServerId && ["runtime.lifecycle", "runtime.health"].includes(payload.family)) {
        const status = payload.status === "failed" ? "error" :
          payload.status === "offline" ? "stopped" :
          payload.status === "degraded" ? "starting" : "running";
        const error = status === "error" ? payload.details?.errorMessage || payload.summary : undefined;
        serverStore.updateServerStatus(payload.managedServerId, status, error);
        if (error) appStore.addNotification({
          type: "error", title: "Runtime error", message: error, duration: 5000,
        });
      }
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
      const index = serverStore.servers.findIndex(
        (s: MCPServer) => s.id === server.id,
      );
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
      const index = serverStore.servers.findIndex(
        (s: MCPServer) => s.id === serverId,
      );
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

  const subscribe = (eventType: string, callback: (data: any) => void, subscriptionId?: string) => {
    const event = eventType as keyof WebSocketEvents;
    if (!runtimeEvents.has(event)) return null;
    const id = subscriptionId || `${event}_${crypto.randomUUID()}`;
    let callbacks = subscriptionCallbacks.get(event);
    if (!callbacks) {
      callbacks = new Map();
      subscriptionCallbacks.set(event, callbacks);
    }
    const previous = callbacks.get(id);
    if (previous) websocketService.off(event, previous);
    callbacks.set(id, callback);
    websocketService.on(event, callback);
    subscriptions.value.add(event);
    return id;
  };

  const unsubscribe = (eventType: string, subscriptionId?: string) => {
    const event = eventType as keyof WebSocketEvents;
    const callbacks = subscriptionCallbacks.get(event);
    if (!callbacks) return;
    for (const [id, callback] of [...callbacks]) {
      if (subscriptionId && id !== subscriptionId) continue;
      websocketService.off(event, callback);
      callbacks.delete(id);
    }
    if (!callbacks.size) {
      subscriptions.value.delete(event);
      subscriptionCallbacks.delete(event);
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
    subscribeToRuntimeAsset,
    unsubscribeFromRuntimeAsset,
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
