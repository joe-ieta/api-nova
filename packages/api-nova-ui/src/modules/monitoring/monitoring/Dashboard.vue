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

    <el-row :gutter="16" class="summary-row">
      <el-col :span="6">
        <MetricCard
          :title="t('monitoring.dashboard.governance.gatewayAssets')"
          :value="governanceMetrics.gatewayAssetCount"
          icon="server"
        />
      </el-col>
      <el-col :span="6">
        <MetricCard
          :title="t('monitoring.dashboard.governance.cacheRoutes')"
          :value="governanceMetrics.cacheEnabledRoutes"
          icon="disk"
        />
      </el-col>
      <el-col :span="6">
        <MetricCard
          :title="t('monitoring.dashboard.governance.rateLimitedRoutes')"
          :value="governanceMetrics.rateLimitedRoutes"
          icon="network"
        />
      </el-col>
      <el-col :span="6">
        <MetricCard
          :title="t('monitoring.dashboard.governance.breakerRoutes')"
          :value="governanceMetrics.breakerProtectedRoutes"
          icon="memory"
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
              <div class="header-tags">
                <el-tag size="small" type="danger">
                  {{ t("monitoring.dashboard.events.authRejected", { count: governanceEventSummary.authRejected }) }}
                </el-tag>
                <el-tag size="small" type="warning">
                  {{ t("monitoring.dashboard.events.rateLimited", { count: governanceEventSummary.rateLimited }) }}
                </el-tag>
                <el-tag size="small" type="info">
                  {{ t("monitoring.dashboard.events.breakerOpened", { count: governanceEventSummary.breakerOpened }) }}
                </el-tag>
                <el-tag size="small" type="success">
                  {{ t("monitoring.dashboard.events.cacheHits", { count: governanceEventSummary.cacheHits }) }}
                </el-tag>
              </div>
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
            <el-table-column :label="t('monitoring.dashboard.governanceLabel')" min-width="260">
              <template #default="{ row }">
                <div v-if="row.asset?.type === 'gateway_service'" class="governance-cell">
                  <div class="governance-line">
                    <el-tag size="small" type="info">
                      {{ t("monitoring.dashboard.governance.routes", { count: row.runtimeSummary?.gatewayGovernance?.totalRoutes ?? 0 }) }}
                    </el-tag>
                    <el-tag size="small" type="success">
                      {{ t("monitoring.dashboard.governance.cacheHits", { count: row.runtimeSummary?.gatewayMetrics?.cacheHitCount ?? 0 }) }}
                    </el-tag>
                  </div>
                  <div class="governance-text">
                    {{ summarizeGovernance(row.runtimeSummary?.gatewayGovernance) }}
                  </div>
                </div>
                <span v-else class="governance-text">
                  {{ t("monitoring.dashboard.notApplicable") }}
                </span>
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

    <el-card class="logs-card">
      <template #header>
        <div class="logs-header">
          <div class="section-header">
            <span>{{ t("monitoring.dashboard.gatewayAccessLogs") }}</span>
            <el-tag size="small" type="info">{{ gatewayAccessLogs.length }}</el-tag>
          </div>
          <div class="filter-row">
            <el-select
              v-model="gatewayLogFilters.runtimeAssetId"
              clearable
              size="small"
              :placeholder="t('monitoring.dashboard.filters.runtimeAsset')"
              @change="applyGatewayLogFilters"
            >
              <el-option
                v-for="asset in gatewayRuntimeAssets"
                :key="asset.asset?.id"
                :label="asset.asset?.displayName || asset.asset?.name || asset.asset?.id"
                :value="asset.asset?.id"
              />
            </el-select>
            <el-select
              v-model="gatewayLogFilters.method"
              clearable
              size="small"
              :placeholder="t('monitoring.dashboard.filters.method')"
              @change="applyGatewayLogFilters"
            >
              <el-option
                v-for="method in gatewayLogMethodOptions"
                :key="method"
                :label="method"
                :value="method"
              />
            </el-select>
            <el-select
              v-model="gatewayLogFilters.statusCode"
              clearable
              size="small"
              :placeholder="t('monitoring.dashboard.filters.statusCode')"
              @change="applyGatewayLogFilters"
            >
              <el-option
                v-for="status in gatewayLogStatusOptions"
                :key="status"
                :label="String(status)"
                :value="status"
              />
            </el-select>
            <el-button size="small" @click="resetGatewayLogFilters">
              {{ t("monitoring.dashboard.filters.reset") }}
            </el-button>
          </div>
        </div>
      </template>

      <el-table :data="gatewayAccessLogs" stripe size="small">
        <el-table-column :label="t('monitoring.dashboard.time')" min-width="160">
          <template #default="{ row }">
            {{ formatDateTime(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column prop="method" :label="t('monitoring.dashboard.method')" width="100" />
        <el-table-column prop="routePath" :label="t('monitoring.dashboard.routePath')" min-width="220" />
        <el-table-column :label="t('monitoring.dashboard.statusCode')" width="110">
          <template #default="{ row }">
            {{ row.statusCode ?? "-" }}
          </template>
        </el-table-column>
        <el-table-column :label="t('monitoring.dashboard.latency')" width="120">
          <template #default="{ row }">
            {{ row.latencyMs != null ? `${row.latencyMs} ms` : "-" }}
          </template>
        </el-table-column>
        <el-table-column prop="requestBodyPreview" :label="t('monitoring.dashboard.requestPreview')" min-width="280" show-overflow-tooltip />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { Monitor, Refresh, Connection, Service, Grid, Promotion } from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import MetricCard from "../components/monitoring/MetricCard.vue";
import SystemStatusCard from "../components/monitoring/SystemStatusCard.vue";
import AlertsPanel from "../components/monitoring/AlertsPanel.vue";
import { useMonitoringStore } from "@/stores/monitoring";
import { useWebSocketStore } from "@/stores/websocket";

const monitoringStore = useMonitoringStore();
const websocketStore = useWebSocketStore();
const route = useRoute();
const { t, locale } = useI18n();
const autoRefresh = ref(true);
const isRefreshing = ref(false);
const gatewayLogFilters = ref<{
  runtimeAssetId?: string;
  method?: string;
  statusCode?: number;
}>({});

let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

const alerts = computed(() => monitoringStore.alerts);
const runtimeEvents = computed(() => monitoringStore.runtimeEvents.slice(0, 20));
const runtimeAssets = computed(() => monitoringStore.runtimeAssets.slice(0, 20));
const logs = computed(() => monitoringStore.filteredLogs.slice(0, 20));
const gatewayAccessLogs = computed(() => monitoringStore.gatewayAccessLogs.slice(0, 20));
const gatewayRuntimeAssets = computed(() =>
  runtimeAssets.value.filter((item: any) => item?.asset?.type === "gateway_service"),
);

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

const governanceMetrics = computed(() => {
  const gatewayAssets = gatewayRuntimeAssets.value;
  return gatewayAssets.reduce(
    (summary: any, item: any) => {
      const governance = item?.runtimeSummary?.gatewayGovernance || {};
      const metrics = item?.runtimeSummary?.gatewayMetrics || {};
      summary.gatewayAssetCount += 1;
      summary.cacheEnabledRoutes += Number(governance.cacheEnabledRoutes || 0);
      summary.rateLimitedRoutes += Number(governance.rateLimitedRoutes || 0);
      summary.breakerProtectedRoutes += Number(governance.breakerProtectedRoutes || 0);
      summary.cacheHitCount += Number(metrics.cacheHitCount || 0);
      summary.cacheMissCount += Number(metrics.cacheMissCount || 0);
      return summary;
    },
    {
      gatewayAssetCount: 0,
      cacheEnabledRoutes: 0,
      rateLimitedRoutes: 0,
      breakerProtectedRoutes: 0,
      cacheHitCount: 0,
      cacheMissCount: 0,
    },
  );
});
const governanceEventSummary = computed(() =>
  runtimeEvents.value.reduce(
    (summary: any, event: any) => {
      const eventName = String(event?.eventName || "").toLowerCase();
      if (eventName.includes("auth_rejected")) {
        summary.authRejected += 1;
      }
      if (eventName.includes("rate_limit_rejected")) {
        summary.rateLimited += 1;
      }
      if (eventName.includes("breaker_open")) {
        summary.breakerOpened += 1;
      }
      if (eventName.includes("cache_hit")) {
        summary.cacheHits += 1;
      }
      if (eventName.includes("cache_miss")) {
        summary.cacheMisses += 1;
      }
      return summary;
    },
    {
      authRejected: 0,
      rateLimited: 0,
      breakerOpened: 0,
      cacheHits: 0,
      cacheMisses: 0,
    },
  ),
);
const gatewayLogMethodOptions = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const gatewayLogStatusOptions = [200, 201, 204, 400, 401, 403, 404, 429, 500, 502, 503, 504];
const routeRuntimeAssetQuery = computed(() =>
  normalizeRouteQueryValue(route.query.runtimeAssetId),
);
const routeSearchQuery = computed(() => normalizeRouteQueryValue(route.query.q));

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

function summarizeGovernance(governance?: any) {
  if (!governance) {
    return t("monitoring.dashboard.notApplicable");
  }

  const authModes = governance.authModes || {};
  return t("monitoring.dashboard.governance.summaryText", {
    jwt: Number(authModes.jwt || 0),
    apiKey: Number(authModes.apiKey || authModes.api_key || 0),
    anonymous: Number(authModes.anonymous || 0),
    rateLimited: Number(governance.rateLimitedRoutes || 0),
    breaker: Number(governance.breakerProtectedRoutes || 0),
  });
}

async function handleRefresh() {
  isRefreshing.value = true;
  try {
    await refreshDashboard("dashboard");
  } catch (error) {
    ElMessage.error(t("monitoring.dashboard.refreshFailed"));
  } finally {
    isRefreshing.value = false;
  }
}

async function applyGatewayLogFilters() {
  await monitoringStore.fetchGatewayAccessLogs({
    limit: 20,
    runtimeAssetId: gatewayLogFilters.value.runtimeAssetId,
    method: gatewayLogFilters.value.method,
    statusCode: gatewayLogFilters.value.statusCode,
  });
}

async function resetGatewayLogFilters() {
  gatewayLogFilters.value = {};
  await applyGatewayLogFilters();
}

function normalizeRouteQueryValue(value: unknown) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

function resolveGatewayRuntimeAssetId(query?: string) {
  if (!query) {
    return undefined;
  }

  const normalizedQuery = query.toLowerCase();
  const matchedAsset = gatewayRuntimeAssets.value.find((item: any) => {
    const asset = item?.asset || {};
    return [asset.id, asset.name, asset.displayName]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery));
  });

  return matchedAsset?.asset?.id;
}

function applyRouteGatewayLogFilters() {
  const runtimeAssetId =
    routeRuntimeAssetQuery.value ||
    resolveGatewayRuntimeAssetId(routeSearchQuery.value);

  if (!runtimeAssetId) {
    return;
  }

  gatewayLogFilters.value = {
    ...gatewayLogFilters.value,
    runtimeAssetId,
  };
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

async function refreshDashboard(reason = "manual") {
  await monitoringStore.refreshAll(reason);
  applyRouteGatewayLogFilters();
  await applyGatewayLogFilters();
}

function resetAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (autoRefresh.value) {
    autoRefreshTimer = setInterval(() => {
      void refreshDashboard("auto");
    }, monitoringStore.config.refreshInterval);
  }
}

onMounted(async () => {
  await websocketStore.initialize();
  await refreshDashboard("mount");
  resetAutoRefresh();
});

watch([routeRuntimeAssetQuery, routeSearchQuery], async () => {
  applyRouteGatewayLogFilters();
  await applyGatewayLogFilters();
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

.header-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.asset-name {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.governance-cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.governance-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.governance-text {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.4;
}

.logs-card {
  margin-bottom: 24px;
}

.logs-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

@media (max-width: 960px) {
  .dashboard-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }

  .filter-row {
    flex-direction: column;
  }
}
</style>
