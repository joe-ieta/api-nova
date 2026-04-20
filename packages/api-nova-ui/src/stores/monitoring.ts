import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  ChartSeries,
  DetailedSystemMetrics,
  MonitoringConfig,
  PerformanceAlert,
} from "@/types";
import { runtimeAssetsAPI, runtimeObservabilityAPI } from "@/services/api";

interface LogEntry {
  id: string;
  timestamp: Date;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  source?: string;
  data?: any;
}

interface LogFilter {
  level?: string;
  source?: string;
  search?: string;
  startTime?: Date;
  endTime?: Date;
}

interface LogStats {
  total: number;
  info: number;
  warn: number;
  error: number;
  debug: number;
}

interface SystemHealthView {
  status: "healthy" | "warning" | "critical" | "unknown";
  uptime: number;
  lastCheck: Date;
  issues: string[];
}

type RuntimeMetricsSnapshot = {
  timestamp: Date;
  totalRuntimeAssets: number;
  activeRuntimeAssets: number;
  degradedRuntimeAssets: number;
  unhealthyRuntimeAssets: number;
};

const DEFAULT_CONFIG: MonitoringConfig = {
  refreshInterval: 15000,
  alerts: {
    cpu: { warning: 1, critical: 2 },
    memory: { warning: 1, critical: 2 },
    disk: { warning: 1, critical: 2 },
    network: { warning: 1, critical: 2 },
  },
  enableAlerts: true,
  enableSound: false,
};

export const useMonitoringStore = defineStore("monitoring", () => {
  const config = ref<MonitoringConfig>({ ...DEFAULT_CONFIG });
  const isConnected = ref(false);
  const isLoading = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const realTimeEnabled = ref(true);
  const lastUpdate = ref<Date>(new Date());
  const isMonitoring = ref(false);

  const overview = ref<any | null>(null);
  const runtimeAssets = ref<any[]>([]);
  const runtimeEvents = ref<any[]>([]);
  const runtimeAudit = ref<any[]>([]);
  const gatewayAccessLogs = ref<any[]>([]);
  const acknowledgedAlertIds = ref<Set<string>>(new Set());
  const dismissedAlertIds = ref<Set<string>>(new Set());
  const metricsHistory = ref<RuntimeMetricsSnapshot[]>([]);
  const logs = ref<LogEntry[]>([]);
  const logFilter = ref<LogFilter>({});
  const runtimeAssetMetrics = ref<Record<string, any>>({});
  const systemMetrics = ref<any | null>(null);
  const currentMetrics = ref<DetailedSystemMetrics | null>(null);
  const managementApiAvailable = ref(true);
  const systemHealth = ref<SystemHealthView>({
    status: "unknown",
    uptime: 0,
    lastCheck: new Date(),
    issues: [],
  });

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pollingTimer: ReturnType<typeof setInterval> | null = null;

  const metrics = computed(() =>
    metricsHistory.value.map(snapshot => ({
      timestamp: snapshot.timestamp,
      cpu: {
        usage:
          snapshot.totalRuntimeAssets > 0
            ? (snapshot.activeRuntimeAssets / snapshot.totalRuntimeAssets) * 100
            : 0,
        cores: snapshot.totalRuntimeAssets,
        temperature: 0,
        frequency: 0,
      },
      memory: {
        total: snapshot.totalRuntimeAssets,
        used: snapshot.degradedRuntimeAssets,
        free: Math.max(
          0,
          snapshot.totalRuntimeAssets - snapshot.degradedRuntimeAssets,
        ),
        usage:
          snapshot.totalRuntimeAssets > 0
            ? (snapshot.degradedRuntimeAssets / snapshot.totalRuntimeAssets) * 100
            : 0,
      },
      network: {
        bytesIn: snapshot.activeRuntimeAssets,
        bytesOut: snapshot.degradedRuntimeAssets,
        packetsIn: snapshot.totalRuntimeAssets,
        packetsOut: snapshot.unhealthyRuntimeAssets,
        connections: snapshot.totalRuntimeAssets,
      },
      disk: {
        total: snapshot.totalRuntimeAssets,
        used: snapshot.unhealthyRuntimeAssets,
        free: Math.max(
          0,
          snapshot.totalRuntimeAssets - snapshot.unhealthyRuntimeAssets,
        ),
        usage:
          snapshot.totalRuntimeAssets > 0
            ? (snapshot.unhealthyRuntimeAssets / snapshot.totalRuntimeAssets) * 100
            : 0,
        readOps: snapshot.activeRuntimeAssets,
        writeOps: snapshot.degradedRuntimeAssets,
      },
      process: {
        pid: 0,
        uptime: 0,
        memory: snapshot.degradedRuntimeAssets,
        cpu: snapshot.activeRuntimeAssets,
      },
    })),
  );

  const alerts = computed<PerformanceAlert[]>(() => {
    if (!config.value.enableAlerts) {
      return [];
    }

    return runtimeEvents.value
      .filter(event => {
        if (dismissedAlertIds.value.has(String(event?.id))) {
          return false;
        }
        const severity = String(event?.severity || "");
        const status = String(event?.status || "");
        return (
          severity === "warning" ||
          severity === "error" ||
          severity === "critical" ||
          status === "failed" ||
          status === "degraded"
        );
      })
      .slice(0, 50)
      .map(event => ({
        id: String(event.id),
        type: thisEventType(event),
        level: thisAlertLevel(event),
        message: event.summary || event.description || event.eventName || "Runtime alert",
        value: Number(event.details?.statusCode || event.details?.latencyMs || 1),
        threshold: 1,
        timestamp: new Date(event.occurredAt || event.createdAt || Date.now()),
        acknowledged: acknowledgedAlertIds.value.has(String(event.id)),
      }));
  });

  const activeAlerts = computed(() =>
    alerts.value.filter(alert => !alert.acknowledged),
  );
  const criticalAlerts = computed(() =>
    activeAlerts.value.filter(alert => alert.level === "critical"),
  );
  const warningAlerts = computed(() =>
    activeAlerts.value.filter(alert => alert.level === "warning"),
  );

  const systemStatus = computed(() => systemHealth.value.status);

  const filteredLogs = computed(() => {
    let filtered = logs.value.slice();

    if (logFilter.value.level) {
      filtered = filtered.filter(log => log.level === logFilter.value.level);
    }
    if (logFilter.value.source) {
      filtered = filtered.filter(log => log.source === logFilter.value.source);
    }
    if (logFilter.value.search) {
      const search = logFilter.value.search.toLowerCase();
      filtered = filtered.filter(log =>
        log.message.toLowerCase().includes(search),
      );
    }
    if (logFilter.value.startTime) {
      filtered = filtered.filter(log => log.timestamp >= logFilter.value.startTime!);
    }
    if (logFilter.value.endTime) {
      filtered = filtered.filter(log => log.timestamp <= logFilter.value.endTime!);
    }

    return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  });

  const logStats = computed<LogStats>(() => {
    const stats: LogStats = {
      total: logs.value.length,
      info: 0,
      warn: 0,
      error: 0,
      debug: 0,
    };
    logs.value.forEach(log => {
      stats[log.level] += 1;
    });
    return stats;
  });

  const cpuSeries = computed<ChartSeries>(() => ({
    name: "Active Runtime Assets",
    data: metricsHistory.value.map(item => ({
      timestamp: item.timestamp,
      value: item.activeRuntimeAssets,
    })),
    color: "#409EFF",
  }));

  const memorySeries = computed<ChartSeries>(() => ({
    name: "Degraded Runtime Assets",
    data: metricsHistory.value.map(item => ({
      timestamp: item.timestamp,
      value: item.degradedRuntimeAssets,
    })),
    color: "#E6A23C",
  }));

  const networkInSeries = computed<ChartSeries>(() => ({
    name: "Total Runtime Assets",
    data: metricsHistory.value.map(item => ({
      timestamp: item.timestamp,
      value: item.totalRuntimeAssets,
    })),
    color: "#67C23A",
  }));

  const networkOutSeries = computed<ChartSeries>(() => ({
    name: "Unhealthy Runtime Assets",
    data: metricsHistory.value.map(item => ({
      timestamp: item.timestamp,
      value: item.unhealthyRuntimeAssets,
    })),
    color: "#F56C6C",
  }));

  const diskSeries = computed<ChartSeries>(() => ({
    name: "Degraded Runtime Assets",
    data: metricsHistory.value.map(item => ({
      timestamp: item.timestamp,
      value: item.degradedRuntimeAssets,
    })),
    color: "#909399",
  }));

  const buildFallbackOverview = (runtimeAssetList: any[]) => {
    const assets = Array.isArray(runtimeAssetList) ? runtimeAssetList : [];
    const totalRuntimeAssets = assets.length;
    const activeRuntimeAssets = assets.filter((item: any) => {
      const status = String(item?.runtimeSummary?.runtimeStatus || "").toLowerCase();
      return status === "active" || status === "online" || item?.runtimeSummary?.healthy === true;
    }).length;
    const degradedRuntimeAssets = assets.filter((item: any) => {
      const status = String(item?.runtimeSummary?.runtimeStatus || "").toLowerCase();
      return status === "degraded";
    }).length;
    const unhealthyRuntimeAssets = assets.filter((item: any) => {
      const status = String(item?.runtimeSummary?.runtimeStatus || "").toLowerCase();
      return (
        status === "unhealthy" ||
        status === "error" ||
        status === "failed" ||
        item?.runtimeSummary?.healthy === false
      );
    }).length;
    const offlineRuntimeAssets = assets.filter((item: any) => {
      const status = String(item?.runtimeSummary?.runtimeStatus || "").toLowerCase();
      return status === "offline";
    }).length;

    return {
      metrics: {
        totalRuntimeAssets,
        activeRuntimeAssets,
        degradedRuntimeAssets,
        unhealthyRuntimeAssets,
        healthyRuntimeAssets: Math.max(
          0,
          totalRuntimeAssets - degradedRuntimeAssets - unhealthyRuntimeAssets - offlineRuntimeAssets,
        ),
        offlineRuntimeAssets,
      },
      health: {
        status:
          unhealthyRuntimeAssets > 0
            ? "critical"
            : degradedRuntimeAssets > 0
              ? "warning"
              : totalRuntimeAssets > 0
                ? "healthy"
                : "unknown",
      },
      recentRuntimeEvents: [],
      recentManagementLogs: [],
    };
  };

  async function fetchOverview() {
    loading.value = true;
    isLoading.value = true;
    error.value = null;

    try {
      const runtimeAssetList = await runtimeAssetsAPI.listRuntimeAssets();
      runtimeAssets.value = Array.isArray(runtimeAssetList?.data)
        ? runtimeAssetList.data
        : [];

      let overviewData: any;
      if (managementApiAvailable.value) {
        try {
          overviewData = await runtimeObservabilityAPI.getManagementOverview({
            days: 7,
            eventLimit: 50,
          });
        } catch (overviewError: any) {
          if (isMissingManagementApi(overviewError)) {
            managementApiAvailable.value = false;
            overviewData = buildFallbackOverview(runtimeAssets.value);
          } else {
            throw overviewError;
          }
        }
      } else {
        overviewData = buildFallbackOverview(runtimeAssets.value);
      }

      overview.value = overviewData;
      runtimeEvents.value = Array.isArray(overviewData?.recentRuntimeEvents)
        ? overviewData.recentRuntimeEvents
        : [];
      runtimeAudit.value = [];

      const nextLogs = Array.isArray(overviewData?.recentManagementLogs)
        ? overviewData.recentManagementLogs.map(normalizeLogEntry)
        : [];
      logs.value = nextLogs;

      const metricsSnapshot: RuntimeMetricsSnapshot = {
        timestamp: new Date(),
        totalRuntimeAssets: Number(overviewData?.metrics?.totalRuntimeAssets || 0),
        activeRuntimeAssets: Number(overviewData?.metrics?.activeRuntimeAssets || 0),
        degradedRuntimeAssets: Number(
          overviewData?.metrics?.degradedRuntimeAssets || 0,
        ),
        unhealthyRuntimeAssets: Number(
          overviewData?.metrics?.unhealthyRuntimeAssets || 0,
        ),
      };

      metricsHistory.value.push(metricsSnapshot);
      if (metricsHistory.value.length > 200) {
        metricsHistory.value = metricsHistory.value.slice(-200);
      }

      systemMetrics.value = {
        ...metricsSnapshot,
        healthyRuntimeAssets: Number(
          overviewData?.metrics?.healthyRuntimeAssets || 0,
        ),
        offlineRuntimeAssets: Number(
          overviewData?.metrics?.offlineRuntimeAssets || 0,
        ),
      };

      systemHealth.value = {
        status: mapOverviewHealthStatus(overviewData?.health?.status),
        uptime: 0,
        lastCheck: new Date(),
        issues: runtimeEvents.value
          .filter((event: any) =>
            ["warning", "error", "critical"].includes(String(event?.severity || "")),
          )
          .slice(0, 5)
          .map((event: any) => String(event.summary || event.eventName || "Runtime issue")),
      };

      lastUpdate.value = new Date();
    } catch (fetchError: any) {
      error.value = fetchError?.message || "Failed to fetch monitoring overview";
      throw fetchError;
    } finally {
      loading.value = false;
      isLoading.value = false;
    }
  }

  async function fetchSystemMetrics() {
    await fetchOverview();
  }

  async function fetchRuntimeAssetMetrics(runtimeAssetId?: string) {
    if (!runtimeAssetId) {
      return systemMetrics.value;
    }
    const response = await runtimeAssetsAPI.getRuntimeAssetObservability(
      runtimeAssetId,
    );
    runtimeAssetMetrics.value[runtimeAssetId] =
      response.normalizedObservability?.metricsSummary || null;
    return runtimeAssetMetrics.value[runtimeAssetId];
  }

  async function fetchLogs(options?: {
    limit?: number;
    level?: string;
    runtimeAssetId?: string;
  }) {
    loading.value = true;
    try {
      if (!managementApiAvailable.value) {
        logs.value = [];
        runtimeEvents.value = [];
        lastUpdate.value = new Date();
        return;
      }

      let response: any;
      try {
        response = await runtimeObservabilityAPI.getManagementEvents({
          page: 1,
          limit: options?.limit || 50,
          level: options?.level,
          runtimeAssetId: options?.runtimeAssetId,
        });
      } catch (fetchError: any) {
        if (isMissingManagementApi(fetchError)) {
          managementApiAvailable.value = false;
          logs.value = [];
          runtimeEvents.value = [];
          lastUpdate.value = new Date();
          return;
        }
        throw fetchError;
      }
      logs.value = Array.isArray(response?.data)
        ? response.data.map(normalizeLogEntry)
        : [];
      runtimeEvents.value = Array.isArray(response?.data) ? response.data : [];
      lastUpdate.value = new Date();
    } finally {
      loading.value = false;
    }
  }

  async function fetchAudit(options?: { limit?: number; status?: string }) {
    if (!managementApiAvailable.value) {
      runtimeAudit.value = [];
      return runtimeAudit.value;
    }

    let response: any;
    try {
      response = await runtimeObservabilityAPI.getManagementAudit({
        page: 1,
        limit: options?.limit || 50,
        status: options?.status,
      });
    } catch (fetchError: any) {
      if (isMissingManagementApi(fetchError)) {
        managementApiAvailable.value = false;
        runtimeAudit.value = [];
        return runtimeAudit.value;
      }
      throw fetchError;
    }
    runtimeAudit.value = Array.isArray(response?.data) ? response.data : [];
    return runtimeAudit.value;
  }

  async function fetchGatewayAccessLogs(options?: {
    page?: number;
    limit?: number;
    runtimeAssetId?: string;
    runtimeMembershipId?: string;
    routeBindingId?: string;
    requestId?: string;
    statusCode?: number;
    method?: string;
  }) {
    if (!managementApiAvailable.value) {
      gatewayAccessLogs.value = [];
      return gatewayAccessLogs.value;
    }

    let response: any;
    try {
      response = await runtimeObservabilityAPI.getGatewayAccessLogs({
        page: options?.page || 1,
        limit: options?.limit || 20,
        runtimeAssetId: options?.runtimeAssetId,
        runtimeMembershipId: options?.runtimeMembershipId,
        routeBindingId: options?.routeBindingId,
        requestId: options?.requestId,
        statusCode: options?.statusCode,
        method: options?.method,
      });
    } catch (fetchError: any) {
      if (isMissingManagementApi(fetchError)) {
        managementApiAvailable.value = false;
        gatewayAccessLogs.value = [];
        return gatewayAccessLogs.value;
      }
      throw fetchError;
    }
    gatewayAccessLogs.value = Array.isArray(response?.data) ? response.data : [];
    return gatewayAccessLogs.value;
  }

  function scheduleRefresh(reason = "websocket") {
    if (!realTimeEnabled.value) {
      return;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshAll(reason);
    }, 1200);
  }

  async function refreshAll(_reason = "manual") {
    await Promise.all([
      fetchOverview(),
      fetchAudit({ limit: 50 }),
      fetchGatewayAccessLogs({ limit: 20 }),
    ]);
  }

  function connectWebSocket() {
    isConnected.value = true;
  }

  function disconnectWebSocket() {
    isConnected.value = false;
  }

  function updateMetrics(_newMetrics: DetailedSystemMetrics) {
    lastUpdate.value = new Date();
  }

  function addAlert(_alert: PerformanceAlert) {
    lastUpdate.value = new Date();
  }

  function acknowledgeAlert(alertId: string) {
    acknowledgedAlertIds.value = new Set(acknowledgedAlertIds.value).add(alertId);
  }

  function clearAcknowledgedAlerts() {
    const nextDismissed = new Set(dismissedAlertIds.value);
    alerts.value.forEach(alert => {
      if (alert.acknowledged) {
        nextDismissed.add(alert.id);
      }
    });
    dismissedAlertIds.value = nextDismissed;
  }

  function dismissAlert(alertId: string) {
    dismissedAlertIds.value = new Set(dismissedAlertIds.value).add(alertId);
  }

  async function refreshMetrics() {
    await fetchOverview();
  }

  function startMonitoring(interval?: number) {
    if (interval) {
      config.value.refreshInterval = interval;
    }
    isMonitoring.value = true;
    if (pollingTimer) {
      clearInterval(pollingTimer);
    }
    pollingTimer = setInterval(() => {
      if (realTimeEnabled.value) {
        void refreshAll("polling");
      }
    }, config.value.refreshInterval);
  }

  function stopMonitoring() {
    isMonitoring.value = false;
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }

  function updateConfig(newConfig: Partial<MonitoringConfig>) {
    config.value = {
      ...config.value,
      ...newConfig,
      alerts: {
        ...config.value.alerts,
        ...(newConfig.alerts || {}),
      },
    };
  }

  function startMockData() {
    return () => undefined;
  }

  function setLogFilter(filter: Partial<LogFilter>) {
    logFilter.value = { ...logFilter.value, ...filter };
  }

  function clearLogFilter() {
    logFilter.value = {};
  }

  async function exportLogs(format: "json" | "csv" = "json") {
    const logsToExport = filteredLogs.value;
    if (format === "json") {
      const dataBlob = new Blob([JSON.stringify(logsToExport, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `runtime-monitoring-${new Date().toISOString().split("T")[0]}.json`;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }

    const csvHeader = "Timestamp,Level,Source,Message\n";
    const csvContent = logsToExport
      .map(
        log =>
          `${log.timestamp.toISOString()},${log.level},${log.source || ""},"${log.message.replace(/"/g, '""')}"`,
      )
      .join("\n");

    const dataBlob = new Blob([csvHeader + csvContent], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `runtime-monitoring-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function clearLogs() {
    logs.value = [];
  }

  function toggleRealTime() {
    realTimeEnabled.value = !realTimeEnabled.value;
  }

  function updateRuntimeAssetMetrics(runtimeAssetId: string, metricsPayload: any) {
    runtimeAssetMetrics.value[runtimeAssetId] = metricsPayload;
    lastUpdate.value = new Date();
  }

  function updateSystemMetrics(metricsPayload: any) {
    runtimeAssetMetrics.value.__websocket_system__ = metricsPayload;
    lastUpdate.value = new Date();
  }

  function addLogEntry(entry: any) {
    logs.value.unshift(normalizeLogEntry(entry));
    logs.value = logs.value.slice(0, 200);
    scheduleRefresh("log-entry");
  }

  function addLogEntries(entries: any[]) {
    logs.value.unshift(...entries.map(normalizeLogEntry));
    logs.value = logs.value.slice(0, 200);
    scheduleRefresh("log-batch");
  }

  return {
    metrics,
    currentMetrics,
    alerts,
    config,
    isConnected,
    isLoading,
    error,
    systemMetrics,
    runtimeAssetMetrics,
    systemHealth,
    metricsHistory,
    logs,
    logFilter,
    realTimeEnabled,
    lastUpdate,
    loading,
    isMonitoring,
    overview,
    runtimeAssets,
    runtimeEvents,
    runtimeAudit,
    gatewayAccessLogs,
    cpuSeries,
    memorySeries,
    networkInSeries,
    networkOutSeries,
    diskSeries,
    activeAlerts,
    criticalAlerts,
    warningAlerts,
    systemStatus,
    filteredLogs,
    logStats,
    connectWebSocket,
    disconnectWebSocket,
    updateMetrics,
    addAlert,
    acknowledgeAlert,
    clearAcknowledgedAlerts,
    dismissAlert,
    refreshMetrics,
    startMonitoring,
    stopMonitoring,
    updateConfig,
    startMockData,
    fetchSystemMetrics,
    fetchRuntimeAssetMetrics,
    fetchLogs,
    fetchAudit,
    fetchGatewayAccessLogs,
    fetchOverview,
    setLogFilter,
    clearLogFilter,
    exportLogs,
    clearLogs,
    toggleRealTime,
    refreshAll,
    scheduleRefresh,
    updateRuntimeAssetMetrics,
    updateSystemMetrics,
    addLogEntry,
    addLogEntries,
  };
});

function normalizeLogEntry(entry: any): LogEntry {
  return {
    id: String(entry?.id || `${entry?.eventName || "event"}-${entry?.occurredAt || Date.now()}`),
    timestamp: new Date(entry?.occurredAt || entry?.createdAt || Date.now()),
    level: mapSeverityToLogLevel(entry?.level || entry?.severity),
    message: String(entry?.description || entry?.summary || entry?.eventName || "Runtime event"),
    source: String(entry?.capability || entry?.eventFamily || "runtime_observability"),
    data: entry?.details || entry?.dimensions || null,
  };
}

function mapSeverityToLogLevel(
  severity?: string,
): "info" | "warn" | "error" | "debug" {
  switch (String(severity || "").toLowerCase()) {
    case "critical":
    case "error":
      return "error";
    case "warning":
      return "warn";
    case "debug":
      return "debug";
    default:
      return "info";
  }
}

function mapOverviewHealthStatus(
  status?: string,
): "healthy" | "warning" | "critical" | "unknown" {
  switch (String(status || "").toLowerCase()) {
    case "healthy":
      return "healthy";
    case "degraded":
    case "warning":
      return "warning";
    case "critical":
    case "error":
    case "failed":
      return "critical";
    default:
      return "unknown";
  }
}

function thisAlertLevel(event: any): "info" | "warning" | "critical" {
  const severity = String(event?.severity || "").toLowerCase();
  if (severity === "critical" || severity === "error") {
    return "critical";
  }
  if (severity === "warning" || String(event?.status || "") === "degraded") {
    return "warning";
  }
  return "info";
}

function thisEventType(event: any): "cpu" | "memory" | "disk" | "network" | "error" {
  const family = String(event?.eventFamily || "").toLowerCase();
  if (family.includes("request") || family.includes("route")) {
    return "network";
  }
  if (family.includes("error")) {
    return "error";
  }
  return "error";
}

function isMissingManagementApi(error: any): boolean {
  const status = Number(error?.status || error?.response?.status || 0);
  const code = String(error?.code || error?.response?.data?.code || "").toUpperCase();
  return status === 404 || code === "NOT_FOUND";
}
