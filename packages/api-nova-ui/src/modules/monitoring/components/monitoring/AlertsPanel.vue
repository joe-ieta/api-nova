<template>
  <el-card class="alerts-panel">
    <template #header>
      <div class="panel-header">
        <div class="header-left">
          <span class="panel-title">{{ t("monitoring.alertsPanel.title") }}</span>
          <el-badge
            :value="activeAlerts.length"
            :type="badgeType"
            :hidden="activeAlerts.length === 0"
          />
        </div>
        <div class="header-actions">
          <el-button size="small" :icon="Refresh" @click="$emit('refresh')">
            {{ t("monitoring.alertsPanel.refresh") }}
          </el-button>
          <el-button
            size="small"
            :icon="Delete"
            :disabled="acknowledgedCount === 0"
            @click="$emit('clearAcknowledged')"
          >
            {{ t("monitoring.alertsPanel.clearAcknowledged") }}
          </el-button>
        </div>
      </div>
    </template>

    <div v-if="alerts.length > 0" class="alerts-summary">
      <div class="summary-item critical">
        <el-icon><Warning /></el-icon>
        <span>{{ t("monitoring.alertsPanel.summary.critical") }}: {{ criticalCount }}</span>
      </div>
      <div class="summary-item warning">
        <el-icon><InfoFilled /></el-icon>
        <span>{{ t("monitoring.alertsPanel.summary.warning") }}: {{ warningCount }}</span>
      </div>
      <div class="summary-item info">
        <el-icon><SuccessFilled /></el-icon>
        <span>{{ t("monitoring.alertsPanel.summary.info") }}: {{ infoCount }}</span>
      </div>
    </div>

    <div v-if="alerts.length > 0" class="alerts-filters">
      <el-select
        v-model="selectedLevel"
        :placeholder="t('monitoring.alertsPanel.filters.level')"
        size="small"
        clearable
        style="width: 120px"
      >
        <el-option :label="t('monitoring.alertsPanel.levels.critical')" value="critical" />
        <el-option :label="t('monitoring.alertsPanel.levels.warning')" value="warning" />
        <el-option :label="t('monitoring.alertsPanel.levels.info')" value="info" />
      </el-select>

      <el-select
        v-model="selectedType"
        :placeholder="t('monitoring.alertsPanel.filters.type')"
        size="small"
        clearable
        style="width: 120px"
      >
        <el-option :label="t('monitoring.alertsPanel.types.cpu')" value="cpu" />
        <el-option :label="t('monitoring.alertsPanel.types.memory')" value="memory" />
        <el-option :label="t('monitoring.alertsPanel.types.disk')" value="disk" />
        <el-option :label="t('monitoring.alertsPanel.types.network')" value="network" />
        <el-option :label="t('monitoring.alertsPanel.types.error')" value="error" />
      </el-select>

      <el-checkbox v-model="showAcknowledged" size="small">
        {{ t("monitoring.alertsPanel.filters.showAcknowledged") }}
      </el-checkbox>
    </div>

    <div class="alerts-list">
      <div v-if="filteredAlerts.length === 0" class="empty-state">
        <el-empty :image-size="80" :description="t('monitoring.alertsPanel.empty')" />
      </div>

      <div
        v-for="alert in filteredAlerts"
        :key="alert.id"
        class="alert-item"
        :class="[`alert-${alert.level}`, { 'alert-acknowledged': alert.acknowledged }]"
      >
        <div class="alert-icon">
          <el-icon>
            <Warning v-if="alert.level === 'critical'" />
            <InfoFilled v-else-if="alert.level === 'warning'" />
            <SuccessFilled v-else />
          </el-icon>
        </div>

        <div class="alert-content">
          <div class="alert-header">
            <span class="alert-type">{{ getTypeLabel(alert.type) }}</span>
            <span class="alert-time">{{ formatTime(alert.timestamp) }}</span>
          </div>
          <div class="alert-message">{{ alert.message }}</div>
          <div v-if="alert.value !== undefined" class="alert-details">
            <span>{{ t("monitoring.alertsPanel.currentValue", { value: alert.value.toFixed(1) }) }}</span>
            <span>{{ t("monitoring.alertsPanel.threshold", { value: alert.threshold.toFixed(1) }) }}</span>
          </div>
        </div>

        <div class="alert-actions">
          <el-button
            v-if="!alert.acknowledged"
            size="small"
            type="primary"
            @click="$emit('acknowledge', alert.id)"
          >
            {{ t("monitoring.alertsPanel.acknowledge") }}
          </el-button>
          <el-button size="small" :icon="Delete" @click="$emit('dismiss', alert.id)" />
        </div>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  Warning,
  InfoFilled,
  SuccessFilled,
  Refresh,
  Delete,
} from "@element-plus/icons-vue";
import type { PerformanceAlert } from "@/types";

interface Props {
  alerts: PerformanceAlert[];
}

interface Emits {
  (e: "acknowledge", alertId: string): void;
  (e: "dismiss", alertId: string): void;
  (e: "refresh"): void;
  (e: "clearAcknowledged"): void;
}

const props = defineProps<Props>();
defineEmits<Emits>();
const { t, locale } = useI18n();

const selectedLevel = ref<string>("");
const selectedType = ref<string>("");
const showAcknowledged = ref(false);

const activeAlerts = computed(() => props.alerts.filter((alert) => !alert.acknowledged));

const criticalCount = computed(
  () => activeAlerts.value.filter((alert) => alert.level === "critical").length,
);

const warningCount = computed(
  () => activeAlerts.value.filter((alert) => alert.level === "warning").length,
);

const infoCount = computed(
  () => activeAlerts.value.filter((alert) => alert.level === "info").length,
);

const acknowledgedCount = computed(
  () => props.alerts.filter((alert) => alert.acknowledged).length,
);

const badgeType = computed(() => {
  if (criticalCount.value > 0) return "danger";
  if (warningCount.value > 0) return "warning";
  return "primary";
});

const filteredAlerts = computed(() => {
  let filtered = props.alerts;

  if (!showAcknowledged.value) {
    filtered = filtered.filter((alert) => !alert.acknowledged);
  }

  if (selectedLevel.value) {
    filtered = filtered.filter((alert) => alert.level === selectedLevel.value);
  }

  if (selectedType.value) {
    filtered = filtered.filter((alert) => alert.type === selectedType.value);
  }

  const levelOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };

  return filtered.sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) {
      return a.acknowledged ? 1 : -1;
    }

    const levelDiff = (levelOrder[a.level] ?? 99) - (levelOrder[b.level] ?? 99);
    if (levelDiff !== 0) {
      return levelDiff;
    }

    return b.timestamp.getTime() - a.timestamp.getTime();
  });
});

const getTypeLabel = (type: string) => {
  const knownTypes = ["cpu", "memory", "disk", "network", "error"];
  return knownTypes.includes(type) ? t(`monitoring.alertsPanel.types.${type}`) : type;
};

const formatTime = (date: Date) => {
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60_000) {
    return t("monitoring.alertsPanel.justNow");
  }

  if (diff < 3_600_000) {
    return t("monitoring.alertsPanel.minutesAgo", {
      count: Math.floor(diff / 60_000),
    });
  }

  if (diff < 86_400_000) {
    return t("monitoring.alertsPanel.hoursAgo", {
      count: Math.floor(diff / 3_600_000),
    });
  }

  return date.toLocaleDateString(locale.value);
};
</script>

<style scoped>
.alerts-panel {
  height: 100%;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-title {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.header-actions {
  display: flex;
  gap: 8px;
}

.alerts-summary {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  padding: 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}

.summary-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
}

.summary-item.critical {
  color: var(--el-color-danger);
}

.summary-item.warning {
  color: var(--el-color-warning);
}

.summary-item.info {
  color: var(--el-color-info);
}

.alerts-filters {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}

.alerts-list {
  max-height: 400px;
  overflow-y: auto;
}

.empty-state {
  padding: 20px;
  text-align: center;
}

.alert-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  border-radius: 6px;
  border-left: 4px solid transparent;
  margin-bottom: 8px;
  background: var(--el-fill-color-light);
  transition: all 0.3s ease;
}

.alert-item:hover {
  background: var(--el-fill-color);
}

.alert-critical {
  border-left-color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
}

.alert-warning {
  border-left-color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}

.alert-info {
  border-left-color: var(--el-color-info);
  background: var(--el-color-info-light-9);
}

.alert-acknowledged {
  opacity: 0.6;
}

.alert-icon {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.alert-critical .alert-icon {
  color: var(--el-color-danger);
}

.alert-warning .alert-icon {
  color: var(--el-color-warning);
}

.alert-info .alert-icon {
  color: var(--el-color-info);
}

.alert-content {
  flex: 1;
}

.alert-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.alert-type {
  font-size: 12px;
  font-weight: 500;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color);
  padding: 2px 6px;
  border-radius: 3px;
}

.alert-time {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.alert-message {
  font-size: 14px;
  color: var(--el-text-color-primary);
  margin-bottom: 4px;
}

.alert-details {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--el-text-color-regular);
}

.alert-actions {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
