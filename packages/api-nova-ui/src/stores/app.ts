import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { GlobalSettings, Notification } from "@/types";
import { fetchSystemHealth, type HealthSnapshot } from "@/services/system-health";

export const useAppStore = defineStore("app", () => {
  // 状态
  const loading = ref(false);
  const error = ref<string | null>(null);
  const notifications = ref<Notification[]>([]);

  const globalSettings = ref<GlobalSettings>({
    theme: "light",
    language: "zh",
    autoRefresh: true,
    refreshInterval: 30000, // 30秒
    logLevel: "info",
    maxLogEntries: 1000,
    enableNotifications: true,
    enableWebSocket: true,
    enableSounds: false,
  });

  // 系统健康状态
  const systemHealth = ref<HealthSnapshot>({
    status: "unknown",
    errorCount: 0,
    lastCheck: null,
  });

  // 计算属性
  const hasError = computed(() => !!error.value);
  const isHealthy = computed(() => systemHealth.value.status === "healthy");
  const unreadNotifications = computed(() =>
    notifications.value.filter((n) => !n.read),
  );
  const criticalNotifications = computed(() =>
    notifications.value.filter((n) => n.type === "error" && !n.read),
  );

  // Actions
  const setLoading = (value: boolean) => {
    loading.value = value;
  };

  const setError = (errorMessage: string | null) => {
    error.value = errorMessage;
    if (errorMessage) {
      addNotification({
        type: "error",
        title: "系统错误",
        message: errorMessage,
        duration: 5000,
      });
    }
  };

  const clearError = () => {
    error.value = null;
  };

  // 通知管理
  const addNotification = (
    notification: Omit<Notification, "id" | "timestamp" | "read">,
  ) => {
    const newNotification: Notification = {
      ...notification,
      id: `notification-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      timestamp: new Date(),
      read: false,
    };

    notifications.value.unshift(newNotification);

    // 限制通知数量
    if (notifications.value.length > 100) {
      notifications.value = notifications.value.slice(0, 100);
    }

    // 自动移除通知
    if (notification.duration && notification.duration > 0) {
      setTimeout(() => {
        removeNotification(newNotification.id);
      }, notification.duration);
    }
  };

  const removeNotification = (id: string) => {
    const index = notifications.value.findIndex((n) => n.id === id);
    if (index > -1) {
      notifications.value.splice(index, 1);
    }
  };

  const markNotificationAsRead = (id: string) => {
    const notification = notifications.value.find((n) => n.id === id);
    if (notification) {
      notification.read = true;
    }
  };

  const markAllNotificationsAsRead = () => {
    notifications.value.forEach((n) => (n.read = true));
  };

  const clearAllNotifications = () => {
    notifications.value = [];
  };

  // 全局设置管理
  const updateGlobalSettings = (settings: Partial<GlobalSettings>) => {
    globalSettings.value = { ...globalSettings.value, ...settings };
    // 持久化到本地存储
    localStorage.setItem(
      "api-nova-settings",
      JSON.stringify(globalSettings.value),
    );
  };

  const loadGlobalSettings = () => {
    try {
      const saved = localStorage.getItem("api-nova-settings");
      if (saved) {
        const parsedSettings = JSON.parse(saved);
        globalSettings.value = { ...globalSettings.value, ...parsedSettings };
      }
    } catch (error) {
      console.warn("Failed to load global settings:", error);
    }
  };

  let healthRequest: Promise<boolean> | null = null;
  const checkSystemHealth = (): Promise<boolean> => {
    if (healthRequest) return healthRequest;
    healthRequest = fetchSystemHealth().then(snapshot => {
      systemHealth.value = snapshot;
      return true;
    }).catch(() => {
      systemHealth.value = { status: "unknown", errorCount: 0, lastCheck: new Date() };
      return false;
    }).finally(() => { healthRequest = null; });
    return healthRequest;
  };

  // Refresh only the current page's registered data loader, without remounting
  // the page or erasing an open form. Wait for both requests on partial failure.
  const refreshData = async (refreshPage?: () => Promise<void>) => {
    setLoading(true);
    try {
      const results = await Promise.allSettled([
        checkSystemHealth().then(available => {
          if (!available) throw new Error("Health unavailable");
        }),
        Promise.resolve().then(() => refreshPage?.()),
      ]);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      setLoading(false);
    }
  };

  // 初始化
  const initialize = () => {
    loadGlobalSettings();
    checkSystemHealth();
  };

  return {
    // 状态
    loading,
    error,
    notifications,
    globalSettings,
    systemHealth,

    // 计算属性
    hasError,
    isHealthy,
    unreadNotifications,
    criticalNotifications,

    // Actions
    setLoading,
    setError,
    clearError,
    addNotification,
    removeNotification,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    clearAllNotifications,
    updateGlobalSettings,
    loadGlobalSettings,
    checkSystemHealth,
    refreshData,
    initialize,
  };
});
