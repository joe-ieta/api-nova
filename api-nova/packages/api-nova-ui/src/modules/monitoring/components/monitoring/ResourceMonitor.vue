<template>
  <el-card class="resource-monitor">
    <template #header>
      <div class="monitor-header">
        <div>
          <span class="monitor-title">{{ t("monitoring.resourceMonitor.title") }}</span>
          <p class="monitor-subtitle">
            {{ t("monitoring.resourceMonitor.subtitle") }}
          </p>
        </div>
        <el-button size="small" :icon="Refresh" @click="refreshData" :loading="loading">
          {{ t("common.refresh") }}
        </el-button>
      </div>
    </template>

    <el-alert
      class="resource-alert"
      type="info"
      :closable="false"
      :title="t('monitoring.resourceMonitor.alert')"
    />

    <el-row :gutter="16" class="resource-summary">
      <el-col :span="8">
        <div class="summary-card">
          <div class="summary-label">{{ t("monitoring.resourceMonitor.summary.runtimeAssets") }}</div>
          <div class="summary-value">{{ metrics.totalRuntimeAssets }}</div>
        </div>
      </el-col>
      <el-col :span="8">
        <div class="summary-card warning">
          <div class="summary-label">{{ t("monitoring.resourceMonitor.summary.degradedAssets") }}</div>
          <div class="summary-value">{{ metrics.degradedRuntimeAssets }}</div>
        </div>
      </el-col>
      <el-col :span="8">
        <div class="summary-card danger">
          <div class="summary-label">{{ t("monitoring.resourceMonitor.summary.unhealthyAssets") }}</div>
          <div class="summary-value">{{ metrics.unhealthyRuntimeAssets }}</div>
        </div>
      </el-col>
    </el-row>

    <el-table
      :data="runtimeAssetRows"
      class="runtime-assets-table"
      size="small"
      max-height="420"
      :empty-text="t('monitoring.resourceMonitor.empty')"
    >
      <el-table-column :label="t('monitoring.resourceMonitor.columns.runtimeAsset')" min-width="220">
        <template #default="{ row }">
          <div class="asset-name">
            <strong>{{ row.name }}</strong>
            <span>{{ row.type }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column :label="t('monitoring.resourceMonitor.columns.status')" width="120">
        <template #default="{ row }">
          <el-tag :type="runtimeStatusType(row.runtimeStatus)" size="small">
            {{ row.runtimeStatus }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('monitoring.resourceMonitor.columns.health')" width="100">
        <template #default="{ row }">
          <el-tag :type="row.healthy === false ? 'danger' : 'success'" size="small">
            {{ row.healthy === false ? t("monitoring.resourceMonitor.unhealthy") : t("monitoring.resourceMonitor.healthy") }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="membershipCount" :label="t('monitoring.resourceMonitor.columns.members')" width="100" />
      <el-table-column prop="managedServerName" :label="t('monitoring.resourceMonitor.columns.managedServer')" min-width="160" />
      <el-table-column prop="lastEventAt" :label="t('monitoring.resourceMonitor.columns.lastEvent')" min-width="180">
        <template #default="{ row }">
          {{ row.lastEventAt ? formatDateTime(row.lastEventAt) : t("monitoring.resourceMonitor.na") }}
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
import { useMonitoringStore } from "@/stores/monitoring";

const monitoringStore = useMonitoringStore();
const { t, locale } = useI18n();
const loading = ref(false);

const metrics = computed(() => ({
  totalRuntimeAssets: Number(monitoringStore.systemMetrics?.totalRuntimeAssets || 0),
  degradedRuntimeAssets: Number(
    monitoringStore.systemMetrics?.degradedRuntimeAssets || 0,
  ),
  unhealthyRuntimeAssets: Number(
    monitoringStore.systemMetrics?.unhealthyRuntimeAssets || 0,
  ),
}));

const runtimeAssetRows = computed(() =>
  (monitoringStore.runtimeAssets || []).map((item: any) => ({
    id: item.asset?.id,
    name: item.asset?.displayName || item.asset?.name || t("monitoring.resourceMonitor.unnamed"),
    type: item.asset?.type || t("monitoring.resourceMonitor.unknown"),
    runtimeStatus: item.runtimeSummary?.runtimeStatus || t("monitoring.resourceMonitor.unknown"),
    healthy: item.runtimeSummary?.healthy,
    membershipCount: item.runtimeSummary?.membershipCount || item.membershipCount || 0,
    managedServerName: item.managedServer?.name || t("monitoring.resourceMonitor.na"),
    lastEventAt: item.runtimeSummary?.observabilityState?.lastEventAt || null,
  })),
);

async function refreshData() {
  loading.value = true;
  try {
    await monitoringStore.refreshAll("resource-monitor");
  } catch {
    ElMessage.error(t("monitoring.resourceMonitor.refreshFailed"));
  } finally {
    loading.value = false;
  }
}

function runtimeStatusType(status?: string) {
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

function formatDateTime(value: string | Date) {
  return new Date(value).toLocaleString(locale.value);
}
</script>

<style scoped>
.resource-monitor {
  height: 100%;
}

.monitor-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.monitor-title {
  font-weight: 600;
}

.monitor-subtitle {
  margin: 6px 0 0;
  color: var(--el-text-color-secondary);
  max-width: 640px;
}

.resource-alert {
  margin-bottom: 16px;
}

.resource-summary {
  margin-bottom: 16px;
}

.summary-card {
  padding: 16px;
  border-radius: 12px;
  background: #f4f8ff;
  border: 1px solid #dbe7ff;
}

.summary-card.warning {
  background: #fff8eb;
  border-color: #f3ddb0;
}

.summary-card.danger {
  background: #fff0f0;
  border-color: #f1c6c6;
}

.summary-label {
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}

.summary-value {
  font-size: 28px;
  font-weight: 700;
}

.asset-name {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
