<template>
  <div class="runtime-asset-detail">
    <div class="detail-header">
      <el-page-header @back="goBack" :title="t('common.back')" :content="assetTitle">
        <template #extra>
          <div class="header-actions">
            <el-tag :type="statusTagType" size="large">
              {{ runtimeStatus }}
            </el-tag>
            <el-button-group>
              <el-button
                v-if="canStart"
                type="success"
                :icon="VideoPlay"
                :loading="actionLoading"
                @click="startRuntimeAsset"
              >
                {{ t("monitoring.runtimeAssets.actions.start") }}
              </el-button>
              <el-button
                v-if="canStop"
                type="warning"
                :icon="VideoPause"
                :loading="actionLoading"
                @click="stopRuntimeAsset"
              >
                {{ t("monitoring.runtimeAssets.actions.stop") }}
              </el-button>
              <el-button
                type="primary"
                :icon="Refresh"
                :loading="actionLoading"
                @click="redeployRuntimeAsset"
              >
                {{ t("monitoring.runtimeAssets.actions.redeploy") }}
              </el-button>
            </el-button-group>
          </div>
        </template>
      </el-page-header>
    </div>

    <el-alert
      v-if="errorMessage"
      type="error"
      :title="errorMessage"
      show-icon
      class="detail-alert"
    />

    <div v-loading="loading" class="detail-body">
      <el-row :gutter="16">
        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="detail-card">
            <template #header>{{ t("monitoring.runtimeAssets.detail.runtimeAsset") }}</template>
            <el-descriptions :column="1" border>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.id')">{{ asset?.id || "-" }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.name')">{{ assetTitle }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.type')">{{ asset?.type || "-" }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.status')">{{ runtimeStatus }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.members')">{{ runtimeSummary?.membershipCount ?? 0 }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.activeMembers')">
                {{ runtimeSummary?.activeMembershipCount ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.publicationRevision')">
                {{ runtimeSummary?.publicationRevision ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.policyBinding')">
                {{ runtimeSummary?.policyBindingRef || "-" }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.description')">
                {{ asset?.description || "-" }}
              </el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>

        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="detail-card">
            <template #header>{{ t("monitoring.runtimeAssets.detail.runtimeSummary") }}</template>
            <el-descriptions :column="1" border>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.health')">
                {{ observabilityState?.healthStatus || (runtimeSummary?.healthy ? t("monitoring.runtimeAssets.healthy") : t("monitoring.runtimeAssets.unknown")) }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.endpoint')">
                {{ runtimeSummary?.endpoint || "-" }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.tools')">
                {{ runtimeSummary?.toolsCount ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.recentEvents')">
                {{ runtimeSummary?.recentEventCount ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.recentMetrics')">
                {{ runtimeSummary?.recentMetricCount ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.currentStatus')">
                {{ observabilityState?.currentStatus || "-" }}
              </el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>
      </el-row>

      <el-row :gutter="16" class="detail-section">
        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="detail-card">
            <template #header>{{ t("monitoring.runtimeAssets.detail.managedServer") }}</template>
            <el-empty v-if="!managedServer" :description="t('monitoring.runtimeAssets.detail.noManagedServer')" :image-size="120" />
            <el-descriptions v-else :column="1" border>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.id')">{{ managedServer.id }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.name')">{{ managedServer.name }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.status')">{{ managedServer.status }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.port')">{{ managedServer.port ?? "-" }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.transport')">{{ managedServer.transport || "-" }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.endpoint')">{{ managedServer.endpoint || "-" }}</el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.tools')">{{ managedServer.toolsCount ?? 0 }}</el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>

        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="detail-card">
            <template #header>{{ t("monitoring.runtimeAssets.detail.recentObservability") }}</template>
            <el-empty
              v-if="!recentEvents.length"
              :description="t('monitoring.runtimeAssets.detail.noRecentEvents')"
              :image-size="120"
            />
            <div v-else class="event-list">
              <div v-for="event in recentEvents" :key="event.id || event.eventName" class="event-row">
                <div class="event-name">{{ event.eventName || "-" }}</div>
                <div class="event-summary">{{ event.summary || "-" }}</div>
                <div class="event-time">{{ formatDateTime(event.occurredAt || event.createdAt) }}</div>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="detail-card detail-section">
        <template #header>{{ t("monitoring.runtimeAssets.detail.memberships") }}</template>
        <el-table :data="memberships" border size="small">
          <el-table-column prop="endpointDefinition.method" :label="t('monitoring.runtimeAssets.detail.method')" width="100" />
          <el-table-column prop="endpointDefinition.path" :label="t('monitoring.runtimeAssets.detail.path')" min-width="220" />
          <el-table-column prop="membership.status" :label="t('monitoring.runtimeAssets.detail.status')" width="120" />
          <el-table-column prop="membership.publicationRevision" :label="t('monitoring.runtimeAssets.detail.revision')" width="100" />
          <el-table-column prop="sourceServiceAsset.sourceKey" :label="t('monitoring.runtimeAssets.detail.sourceService')" min-width="220" />
          <el-table-column prop="profile.intentName" :label="t('monitoring.runtimeAssets.detail.intent')" min-width="180" />
        </el-table>
      </el-card>

      <el-card shadow="never" class="detail-card detail-section">
        <template #header>{{ t("monitoring.runtimeAssets.detail.accessLogs") }}</template>
        <el-empty
          v-if="!accessLogs.length"
          :description="t('monitoring.runtimeAssets.detail.noAccessLogs')"
          :image-size="120"
        />
        <el-table v-else :data="accessLogs" border size="small">
          <el-table-column :label="t('monitoring.runtimeAssets.detail.accessTime')" min-width="170">
            <template #default="{ row }">
              {{ formatDateTime(row.createdAt) }}
            </template>
          </el-table-column>
          <el-table-column prop="method" :label="t('monitoring.runtimeAssets.detail.method')" width="100" />
          <el-table-column prop="routePath" :label="t('monitoring.runtimeAssets.detail.path')" min-width="220" />
          <el-table-column :label="t('monitoring.runtimeAssets.detail.accessStatus')" width="120">
            <template #default="{ row }">
              {{ row.statusCode ?? "-" }}
            </template>
          </el-table-column>
          <el-table-column :label="t('monitoring.runtimeAssets.detail.latency')" width="120">
            <template #default="{ row }">
              {{ row.latencyMs != null ? `${row.latencyMs} ms` : "-" }}
            </template>
          </el-table-column>
          <el-table-column prop="requestContentType" :label="t('monitoring.runtimeAssets.detail.contentType')" min-width="180" />
          <el-table-column prop="requestBodyPreview" :label="t('monitoring.runtimeAssets.detail.requestPreview')" min-width="260" show-overflow-tooltip />
        </el-table>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Refresh, VideoPause, VideoPlay } from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
import { runtimeAssetsAPI } from "@/services/api";
import { useWebSocketStore } from "@/stores/websocket";

const route = useRoute();
const router = useRouter();
const { t, locale } = useI18n();
const websocketStore = useWebSocketStore();

const loading = ref(false);
const actionLoading = ref(false);
const errorMessage = ref("");
const detail = ref<any>(null);
const observability = ref<any>(null);
const accessLogs = ref<any[]>([]);
const websocketReady = ref(false);
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let assetSubscriptionId: string | null = null;
let eventSubscriptionId: string | null = null;
let logSubscriptionId: string | null = null;

const runtimeAssetId = computed(() => String(route.params.id || ""));
const asset = computed(() => detail.value?.asset || null);
const managedServer = computed(() => detail.value?.managedServer || null);
const runtimeSummary = computed(() => observability.value?.runtimeSummary || detail.value?.runtimeSummary || null);
const observabilityState = computed(() => observability.value?.observability?.state || null);
const recentEvents = computed(() =>
  Array.isArray(observability.value?.observability?.recentEvents)
    ? observability.value.observability.recentEvents.slice(0, 8)
    : [],
);

const assetTitle = computed(
  () =>
    asset.value?.displayName ||
    asset.value?.name ||
    runtimeAssetId.value ||
    t("monitoring.runtimeAssets.detail.runtimeAsset"),
);
const runtimeStatus = computed(() => String(runtimeSummary.value?.runtimeStatus || asset.value?.status || "unknown"));
const canStart = computed(() => !["running", "active", "starting"].includes(runtimeStatus.value));
const canStop = computed(() => ["running", "active"].includes(runtimeStatus.value));
const statusTagType = computed(() => {
  switch (runtimeStatus.value) {
    case "running":
    case "active":
      return "success";
    case "starting":
    case "stopping":
      return "warning";
    case "error":
    case "degraded":
      return "danger";
    default:
      return "info";
  }
});
const memberships = computed(() =>
  Array.isArray(detail.value?.memberships) ? detail.value.memberships : [],
);

const formatDateTime = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(locale.value);
};

const scheduleRefresh = () => {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void loadDetail();
  }, 800);
};

const matchesRuntimeAsset = (payload: any) =>
  String(payload?.runtimeAssetId || "") === runtimeAssetId.value;

const detachRealtimeSubscriptions = () => {
  if (assetSubscriptionId) {
    websocketStore.unsubscribe("runtime:asset", assetSubscriptionId);
    assetSubscriptionId = null;
  }
  if (eventSubscriptionId) {
    websocketStore.unsubscribe("runtime:event", eventSubscriptionId);
    eventSubscriptionId = null;
  }
  if (logSubscriptionId) {
    websocketStore.unsubscribe("runtime:log", logSubscriptionId);
    logSubscriptionId = null;
  }
  if (runtimeAssetId.value && websocketReady.value) {
    websocketStore.unsubscribeFromRuntimeAsset(runtimeAssetId.value);
  }
};

const attachRealtimeSubscriptions = async () => {
  detachRealtimeSubscriptions();
  if (!runtimeAssetId.value) {
    return;
  }

  await websocketStore.initialize();
  websocketReady.value = true;
  websocketStore.subscribeToRuntimeAsset(runtimeAssetId.value);

  assetSubscriptionId = websocketStore.subscribe("runtime:asset", (payload: any) => {
    if (matchesRuntimeAsset(payload)) {
      scheduleRefresh();
    }
  });
  eventSubscriptionId = websocketStore.subscribe("runtime:event", (payload: any) => {
    if (matchesRuntimeAsset(payload)) {
      scheduleRefresh();
    }
  });
  logSubscriptionId = websocketStore.subscribe("runtime:log", (payload: any) => {
    if (matchesRuntimeAsset(payload)) {
      scheduleRefresh();
    }
  });
};

const loadDetail = async () => {
  if (!runtimeAssetId.value) return;
  loading.value = true;
  errorMessage.value = "";
  try {
    const [detailResult, observabilityResult, accessLogResult] = await Promise.all([
      runtimeAssetsAPI.getRuntimeAssetDetail(runtimeAssetId.value),
      runtimeAssetsAPI.getRuntimeAssetObservability(runtimeAssetId.value),
      runtimeAssetsAPI.getRuntimeAssetAccessLogs(runtimeAssetId.value, 20),
    ]);
    detail.value = detailResult;
    observability.value = observabilityResult;
    accessLogs.value = Array.isArray(accessLogResult) ? accessLogResult : [];
  } catch (error: any) {
    errorMessage.value = error?.message || t("monitoring.runtimeAssets.detail.loadFailed");
  } finally {
    loading.value = false;
  }
};

const runAction = async (
  action: "start" | "stop" | "redeploy",
  executor: () => Promise<any>,
  successMessage: string,
) => {
  actionLoading.value = true;
  try {
    await executor();
    ElMessage.success(successMessage);
    await loadDetail();
  } catch (error: any) {
    ElMessage.error(error?.message || t(`monitoring.runtimeAssets.actions.${action}Failed`));
  } finally {
    actionLoading.value = false;
  }
};

const startRuntimeAsset = async () =>
  runAction(
    "start",
    () => runtimeAssetsAPI.startRuntimeAsset(runtimeAssetId.value),
    t("monitoring.runtimeAssets.actions.startSuccess", { name: assetTitle.value }),
  );

const stopRuntimeAsset = async () =>
  runAction(
    "stop",
    () => runtimeAssetsAPI.stopRuntimeAsset(runtimeAssetId.value),
    t("monitoring.runtimeAssets.actions.stopSuccess", { name: assetTitle.value }),
  );

const redeployRuntimeAsset = async () =>
  runAction(
    "redeploy",
    () => runtimeAssetsAPI.redeployRuntimeAsset(runtimeAssetId.value),
    t("monitoring.runtimeAssets.actions.redeploySuccess", { name: assetTitle.value }),
  );

const goBack = () => {
  router.push("/runtime-assets");
};

watch(runtimeAssetId, () => {
  void loadDetail();
  void attachRealtimeSubscriptions();
});

onMounted(async () => {
  await loadDetail();
  await attachRealtimeSubscriptions();
});

onBeforeUnmount(() => {
  detachRealtimeSubscriptions();
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<style scoped>
.runtime-asset-detail {
  padding: 24px;
}

.detail-header {
  margin-bottom: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.detail-alert {
  margin-bottom: 16px;
}

.detail-body {
  min-height: 240px;
}

.detail-card {
  height: 100%;
}

.detail-section {
  margin-top: 16px;
}

.event-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.event-row {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.event-name {
  font-weight: 600;
  margin-bottom: 4px;
}

.event-summary {
  color: var(--el-text-color-regular);
  margin-bottom: 4px;
}

.event-time {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
