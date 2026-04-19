<template>
  <div class="monitoring-dashboard">
    <div class="dashboard-header">
      <div>
        <h2 class="dashboard-title">
          <el-icon><Monitor /></el-icon>
          {{ t("monitoring.dashboard.title") }}
        </h2>
        <p class="dashboard-subtitle">
          {{ t("monitoring.dashboard.subtitle") }}
        </p>
      </div>

      <div class="header-actions">
        <el-switch
          v-model="autoRefresh"
          :active-text="t('monitoring.dashboard.autoRefresh')"
          @change="handleAutoRefreshChange"
        />
        <el-button
          type="primary"
          :icon="Refresh"
          :loading="isRefreshing"
          @click="handleRefresh"
        >
          {{ t("common.refresh") }}
        </el-button>
      </div>
    </div>

    <el-row :gutter="16" class="summary-row">
      <el-col :span="6">
        <MetricCard
          :title="t('monitoring.dashboard.summary.runtimeAssets')"
          :value="summaryMetrics.totalRuntimeAssets"
          icon="server"
          :show-chart="true"
          :chart-data="networkInSeriesData"
        />
      </el-col>
      <el-col :span="6">
        <MetricCard
          :title="t('monitoring.dashboard.summary.activeAssets')"
          :value="summaryMetrics.activeRuntimeAssets"
          icon="network"
          :show-chart="true"
          :chart-data="cpuSeriesData"
        />
      </el-col>
      <el-col :span="6">
        <MetricCard
          :title="t('monitoring.dashboard.summary.degradedAssets')"
          :value="summaryMetrics.degradedRuntimeAssets"
          icon="memory"
          :show-chart="true"
          :chart-data="memorySeriesData"
        />
      </el-col>
      <el-col :span="6">
        <MetricCard
          :title="t('monitoring.dashboard.summary.unhealthyAssets')"
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
              <span>{{ t("monitoring.dashboard.recentRuntimeEvents") }}</span>
              <el-tag size="small" type="info">{{ runtimeEvents.length }}</el-tag>
            </div>
          </template>

          <el-table :data="runtimeEvents" stripe size="small" height="360">
            <el-table-column prop="occurredAt" :label="t('monitoring.dashboard.time')" min-width="160">
              <template #default="{ row }">
                {{ formatDateTime(row.occurredAt || row.createdAt) }}
              </template>
            </el-table-column>
            <el-table-column prop="eventName" :label="t('monitoring.dashboard.event')" min-width="150" />
            <el-table-column prop="severity" :label="t('monitoring.dashboard.severity')" width="100">
              <template #default="{ row }">
                <el-tag :type="severityTagType(row.severity)" size="small">
                  {{ row.severity || t("monitoring.dashboard.info") }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="summary" :label="t('monitoring.dashboard.summaryLabel')" min-width="220" />
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card>
          <template #header>
            <div class="section-header">
              <span>{{ t("monitoring.dashboard.runtimeAssets") }}</span>
              <el-tag size="small" type="success">{{ runtimeAssets.length }}</el-tag>
            </div>
          </template>

          <el-table :data="runtimeAssets" stripe size="small" height="360">
            <el-table-column :label="t('monitoring.dashboard.asset')" min-width="180">
              <template #default="{ row }">
                <div class="asset-name">
                  <strong>{{ row.asset?.displayName || row.asset?.name }}</strong>
                  <span>{{ row.asset?.type }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('monitoring.dashboard.status')" width="120">
              <template #default="{ row }">
                <el-tag :type="runtimeStatusTagType(row.runtimeSummary?.runtimeStatus)" size="small">
                  {{ row.runtimeSummary?.runtimeStatus || t("monitoring.dashboard.unknown") }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('monitoring.dashboard.healthy')" width="100">
              <template #default="{ row }">
                <el-tag
                  size="small"
                  :type="row.runtimeSummary?.healthy === false ? 'danger' : 'success'"
                >
                  {{ row.runtimeSummary?.healthy === false ? t("common.no") : t("common.yes") }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('monitoring.dashboard.members')" width="100">
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
          <span>{{ t("monitoring.dashboard.normalizedManagementLogs") }}</span>
          <el-button size="small" @click="exportLogs">{{ t("monitoring.dashboard.export") }}</el-button>
        </div>
      </template>

      <el-table :data="logs" stripe size="small">
        <el-table-column :label="t('monitoring.dashboard.time')" min-width="160">
          <template #default="{ row }">
            {{ formatDateTime(row.timestamp) }}
          </template>
        </el-table-column>
        <el-table-column prop="level" :label="t('monitoring.dashboard.level')" width="100">
          <template #default="{ row }">
            <el-tag :type="logLevelTagType(row.level)" size="small">
              {{ row.level }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="source" :label="t('monitoring.dashboard.source')" min-width="140" />
        <el-table-column prop="message" :label="t('monitoring.dashboard.message')" min-width="320" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { Monitor, Refresh, Connection, Service, Grid, Promotion } from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
import MetricCard from "../components/monitoring/MetricCard.vue";
import SystemStatusCard from "../components/monitoring/SystemStatusCard.vue";
import AlertsPanel from "../components/monitoring/AlertsPanel.vue";
import { useMonitoringStore } from "@/stores/monitoring";
import { useWebSocketStore } from "@/stores/websocket";

const monitoringStore = useMonitoringStore();
const websocketStore = useWebSocketStore();
const { t, locale } = useI18n();
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
      name: t("monitoring.dashboard.services.gatewayAssets"),
      status: toServiceStatus(
        summaryMetrics.value.degradedRuntimeAssets > 0 ? "degraded" : "online",
      ),
      icon: Promotion,
    },
    {
      name: t("monitoring.dashboard.services.mcpAssets"),
      status: toServiceStatus(
        summaryMetrics.value.activeRuntimeAssets > 0 ? "online" : "offline",
      ),
      icon: Service,
    },
    {
      name: t("monitoring.dashboard.services.observability"),
      status: toServiceStatus(
        monitoringStore.runtimeEvents.length > 0 ? "online" : "degraded",
      ),
      icon: Grid,
    },
    {
      name: t("monitoring.dashboard.services.managementWebSocket"),
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
  return new Date(value).toLocaleString(locale.value);
}

async function handleRefresh() {
  isRefreshing.value = true;
  try {
    await monitoringStore.refreshAll("dashboard");
  } catch (error) {
    ElMessage.error(t("monitoring.dashboard.refreshFailed"));
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
