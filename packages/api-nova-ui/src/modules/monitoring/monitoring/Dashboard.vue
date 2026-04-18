<template>
  <div class="monitoring-dashboard">
    <div class="dashboard-header">
      <div>
        <h2 class="dashboard-title">
          <el-icon><Monitor /></el-icon>
          Runtime Asset Monitoring
        </h2>
        <p class="dashboard-subtitle">
          Runtime-asset-first observability for MCP and Gateway assets.
        </p>
      </div>

      <div class="header-actions">
        <el-switch
          v-model="autoRefresh"
          active-text="Auto refresh"
          @change="handleAutoRefreshChange"
        />
        <el-button
          type="primary"
          :icon="Refresh"
          :loading="isRefreshing"
          @click="handleRefresh"
        >
          Refresh
        </el-button>
      </div>
    </div>

    <el-row :gutter="16" class="summary-row">
      <el-col :span="6">
        <MetricCard
          title="Runtime Assets"
          :value="summaryMetrics.totalRuntimeAssets"
          icon="server"
          :show-chart="true"
          :chart-data="networkInSeriesData"
        />
      </el-col>
      <el-col :span="6">
        <MetricCard
          title="Active Assets"
          :value="summaryMetrics.activeRuntimeAssets"
          icon="network"
          :show-chart="true"
          :chart-data="cpuSeriesData"
        />
      </el-col>
      <el-col :span="6">
        <MetricCard
          title="Degraded Assets"
          :value="summaryMetrics.degradedRuntimeAssets"
          icon="memory"
          :show-chart="true"
          :chart-data="memorySeriesData"
        />
      </el-col>
      <el-col :span="6">
        <MetricCard
          title="Unhealthy Assets"
          :value="summaryMetrics.unhealthyRuntimeAssets"
          icon="disk"
          :show-chart="true"
          :chart-data="diskSeriesData"
        />
      </el-col>
    </el-row>

    <div class="overview-section">
      <el-row :gutter="16">
        <el-col :span="8">
          <SystemStatusCard v-bind="systemStatusData" />
        </el-col>
        <el-col :span="16">
          <AlertsPanel
            :alerts="alerts"
            @acknowledge="handleAcknowledgeAlert"
            @dismiss="handleDismissAlert"
            @refresh="handleRefresh"
            @clearAcknowledged="handleClearAcknowledgedAlerts"
          />
        </el-col>
      </el-row>
    </div>

    <el-row :gutter="16" class="tables-row">
      <el-col :span="12">
        <el-card>
          <template #header>
            <div class="section-header">
              <span>Recent Runtime Events</span>
              <el-tag size="small" type="info">{{ runtimeEvents.length }}</el-tag>
            </div>
          </template>

          <el-table :data="runtimeEvents" stripe size="small" height="360">
            <el-table-column prop="occurredAt" label="Time" min-width="160">
              <template #default="{ row }">
                {{ formatDateTime(row.occurredAt || row.createdAt) }}
              </template>
            </el-table-column>
            <el-table-column prop="eventName" label="Event" min-width="150" />
            <el-table-column prop="severity" label="Severity" width="100">
              <template #default="{ row }">
                <el-tag :type="severityTagType(row.severity)" size="small">
                  {{ row.severity || "info" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="summary" label="Summary" min-width="220" />
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card>
          <template #header>
            <div class="section-header">
              <span>Runtime Assets</span>
              <el-tag size="small" type="success">{{ runtimeAssets.length }}</el-tag>
            </div>
          </template>

          <el-table :data="runtimeAssets" stripe size="small" height="360">
            <el-table-column label="Asset" min-width="180">
              <template #default="{ row }">
                <div class="asset-name">
                  <strong>{{ row.asset?.displayName || row.asset?.name }}</strong>
                  <span>{{ row.asset?.type }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="Status" width="120">
              <template #default="{ row }">
                <el-tag :type="runtimeStatusTagType(row.runtimeSummary?.runtimeStatus)" size="small">
                  {{ row.runtimeSummary?.runtimeStatus || "unknown" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="Healthy" width="100">
              <template #default="{ row }">
                <el-tag
                  size="small"
                  :type="row.runtimeSummary?.healthy === false ? 'danger' : 'success'"
                >
                  {{ row.runtimeSummary?.healthy === false ? "No" : "Yes" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="Members" width="100">
              <template #default="{ row }">
                {{ row.runtimeSummary?.membershipCount || row.membershipCount || 0 }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="logs-card">
      <template #header>
        <div class="section-header">
          <span>Normalized Management Logs</span>
          <el-button size="small" @click="exportLogs">Export</el-button>
        </div>
      </template>

      <el-table :data="logs" stripe size="small">
        <el-table-column label="Time" min-width="160">
          <template #default="{ row }">
            {{ formatDateTime(row.timestamp) }}
          </template>
        </el-table-column>
        <el-table-column prop="level" label="Level" width="100">
          <template #default="{ row }">
            <el-tag :type="logLevelTagType(row.level)" size="small">
              {{ row.level }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="source" label="Source" min-width="140" />
        <el-table-column prop="message" label="Message" min-width="320" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { Monitor, Refresh, Connection, Service, Grid, Promotion } from "@element-plus/icons-vue";
import MetricCard from "../components/monitoring/MetricCard.vue";
import SystemStatusCard from "../components/monitoring/SystemStatusCard.vue";
import AlertsPanel from "../components/monitoring/AlertsPanel.vue";
import { useMonitoringStore } from "@/stores/monitoring";
import { useWebSocketStore } from "@/stores/websocket";

const monitoringStore = useMonitoringStore();
const websocketStore = useWebSocketStore();
const autoRefresh = ref(true);
const isRefreshing = ref(false);

let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

const alerts = computed(() => monitoringStore.alerts);
const runtimeEvents = computed(() => monitoringStore.runtimeEvents.slice(0, 20));
const runtimeAssets = computed(() => monitoringStore.runtimeAssets.slice(0, 20));
const logs = computed(() => monitoringStore.filteredLogs.slice(0, 20));

const summaryMetrics = computed(() => ({
  totalRuntimeAssets: Number(monitoringStore.systemMetrics?.totalRuntimeAssets || 0),
  activeRuntimeAssets: Number(monitoringStore.systemMetrics?.activeRuntimeAssets || 0),
  degradedRuntimeAssets: Number(
    monitoringStore.systemMetrics?.degradedRuntimeAssets || 0,
  ),
  unhealthyRuntimeAssets: Number(
    monitoringStore.systemMetrics?.unhealthyRuntimeAssets || 0,
  ),
}));

const systemStatusData = computed(() => ({
  status: monitoringStore.systemHealth.status,
  services: [
    {
      name: "Gateway Runtime Assets",
      status: toServiceStatus(
        summaryMetrics.value.degradedRuntimeAssets > 0 ? "degraded" : "online",
      ),
      icon: Promotion,
    },
    {
      name: "MCP Runtime Assets",
      status: toServiceStatus(
        summaryMetrics.value.activeRuntimeAssets > 0 ? "online" : "offline",
      ),
      icon: Service,
    },
    {
      name: "Runtime Observability",
      status: toServiceStatus(
        monitoringStore.runtimeEvents.length > 0 ? "online" : "degraded",
      ),
      icon: Grid,
    },
    {
      name: "Management WebSocket",
      status: toServiceStatus(websocketStore.connected ? "online" : "degraded"),
      icon: Connection,
    },
  ],
  uptime: monitoringStore.systemHealth.uptime || undefined,
  lastUpdate: monitoringStore.lastUpdate,
}));

const cpuSeriesData = computed(() => monitoringStore.cpuSeries.data);
const memorySeriesData = computed(() => monitoringStore.memorySeries.data);
const networkInSeriesData = computed(() => monitoringStore.networkInSeries.data);
const diskSeriesData = computed(() => monitoringStore.diskSeries.data);

function severityTagType(severity?: string) {
  switch (String(severity || "").toLowerCase()) {
    case "critical":
    case "error":
      return "danger";
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

function runtimeStatusTagType(status?: string) {
  switch (String(status || "").toLowerCase()) {
    case "active":
      return "success";
    case "degraded":
      return "warning";
    case "offline":
      return "info";
    default:
      return "info";
  }
}

function toServiceStatus(status: "online" | "offline" | "degraded" | "connecting") {
  return status;
}

function logLevelTagType(level?: string) {
  switch (String(level || "").toLowerCase()) {
    case "error":
      return "danger";
    case "warn":
      return "warning";
    case "debug":
      return "info";
    default:
      return "success";
  }
}

function formatDateTime(value: Date | string) {
  return new Date(value).toLocaleString("zh-CN");
}

async function handleRefresh() {
  isRefreshing.value = true;
  try {
    await monitoringStore.refreshAll("dashboard");
  } catch (error) {
    ElMessage.error("Failed to refresh runtime monitoring.");
  } finally {
    isRefreshing.value = false;
  }
}

function handleAutoRefreshChange(enabled: boolean) {
  autoRefresh.value = enabled;
  monitoringStore.toggleRealTime();
  resetAutoRefresh();
}

function handleAcknowledgeAlert(alertId: string) {
  monitoringStore.acknowledgeAlert(alertId);
}

function handleDismissAlert(alertId: string) {
  monitoringStore.dismissAlert(alertId);
}

function handleClearAcknowledgedAlerts() {
  monitoringStore.clearAcknowledgedAlerts();
}

function exportLogs() {
  void monitoringStore.exportLogs("csv");
}

function resetAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (autoRefresh.value) {
    autoRefreshTimer = setInterval(() => {
      void monitoringStore.refreshAll("auto");
    }, monitoringStore.config.refreshInterval);
  }
}

onMounted(async () => {
  await websocketStore.initialize();
  await monitoringStore.refreshAll("mount");
  resetAutoRefresh();
});

onBeforeUnmount(() => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
});
</script>

<style scoped>
.monitoring-dashboard {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dashboard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px;
  border-radius: 16px;
  background: linear-gradient(135deg, #f4f8ff 0%, #eef7f2 100%);
  border: 1px solid #d8e6f7;
}

.dashboard-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.dashboard-subtitle {
  margin: 8px 0 0;
  color: var(--el-text-color-secondary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.summary-row,
.tables-row,
.overview-section {
  width: 100%;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.asset-name {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.logs-card {
  margin-bottom: 24px;
}

@media (max-width: 960px) {
  .dashboard-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
}
</style>
