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
                v-if="canRedeploy"
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

      <el-card
        v-if="asset?.type === 'gateway_service'"
        shadow="never"
        class="detail-card detail-section"
      >
        <template #header>{{ t("monitoring.runtimeAssets.detail.gatewayGovernance") }}</template>
        <el-row :gutter="16">
          <el-col :xs="24" :lg="12">
            <el-descriptions :column="1" border>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.totalRoutes')">
                {{ gatewayGovernance?.totalRoutes ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.cacheEnabledRoutes')">
                {{ gatewayGovernance?.cacheEnabledRoutes ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.rateLimitedRoutes')">
                {{ gatewayGovernance?.rateLimitedRoutes ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.breakerProtectedRoutes')">
                {{ gatewayGovernance?.breakerProtectedRoutes ?? 0 }}
              </el-descriptions-item>
            </el-descriptions>
          </el-col>
          <el-col :xs="24" :lg="12">
            <el-descriptions :column="1" border>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.cacheHits')">
                {{ gatewayMetrics?.cacheHitCount ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.cacheMisses')">
                {{ gatewayMetrics?.cacheMissCount ?? 0 }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.authModes')">
                <div class="metric-inline">
                  <el-tag size="small" type="info">
                    {{ t("monitoring.runtimeAssets.detail.jwtRoutes", { count: gatewayGovernance?.authModes?.jwt ?? 0 }) }}
                  </el-tag>
                  <el-tag size="small" type="warning">
                    {{ t("monitoring.runtimeAssets.detail.apiKeyRoutes", { count: gatewayGovernance?.authModes?.apiKey ?? gatewayGovernance?.authModes?.api_key ?? 0 }) }}
                  </el-tag>
                  <el-tag size="small" type="success">
                    {{ t("monitoring.runtimeAssets.detail.anonymousRoutes", { count: gatewayGovernance?.authModes?.anonymous ?? 0 }) }}
                  </el-tag>
                </div>
              </el-descriptions-item>
              <el-descriptions-item :label="t('monitoring.runtimeAssets.detail.policyCounts')">
                <div class="metric-inline">
                  <el-tag
                    v-for="(count, name) in gatewayPolicyCounts"
                    :key="name"
                    size="small"
                    type="danger"
                  >
                    {{ `${name}: ${count}` }}
                  </el-tag>
                  <span v-if="!Object.keys(gatewayPolicyCounts).length">-</span>
                </div>
              </el-descriptions-item>
            </el-descriptions>
          </el-col>
        </el-row>
      </el-card>

      <el-card shadow="never" class="detail-card detail-section">
        <template #header>{{ t("monitoring.runtimeAssets.detail.memberships") }}</template>
        <el-table :data="memberships" border size="small">
          <el-table-column prop="endpointDefinition.method" :label="t('monitoring.runtimeAssets.detail.method')" width="100" />
          <el-table-column prop="endpointDefinition.path" :label="t('monitoring.runtimeAssets.detail.path')" min-width="220" />
          <el-table-column prop="membership.status" :label="t('monitoring.runtimeAssets.detail.status')" width="120" />
          <el-table-column prop="membership.publicationRevision" :label="t('monitoring.runtimeAssets.detail.revision')" width="100" />
          <el-table-column prop="sourceServiceAsset.sourceKey" :label="t('monitoring.runtimeAssets.detail.sourceService')" min-width="220" />
          <el-table-column prop="profile.intentName" :label="t('monitoring.runtimeAssets.detail.intent')" min-width="180" />
          <el-table-column
            v-if="asset?.type === 'gateway_service'"
            :label="t('monitoring.runtimeAssets.detail.governance')"
            min-width="260"
          >
            <template #default="{ row }">
              <div class="membership-governance">
                <el-tag size="small" type="info">
                  {{ row.gatewayRouteBinding?.authPolicyRef || t("monitoring.runtimeAssets.detail.anonymousPolicy") }}
                </el-tag>
                <el-tag
                  v-if="row.gatewayRouteBinding?.cachePolicyRef"
                  size="small"
                  type="success"
                >
                  {{ row.gatewayRouteBinding.cachePolicyRef }}
                </el-tag>
                <el-tag
                  v-if="row.gatewayRouteBinding?.rateLimitPolicyRef"
                  size="small"
                  type="warning"
                >
                  {{ row.gatewayRouteBinding.rateLimitPolicyRef }}
                </el-tag>
                <el-tag
                  v-if="row.gatewayRouteBinding?.circuitBreakerPolicyRef"
                  size="small"
                  type="danger"
                >
                  {{ row.gatewayRouteBinding.circuitBreakerPolicyRef }}
                </el-tag>
              </div>
            </template>
          </el-table-column>
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

      <el-card
        v-if="asset?.type === 'gateway_service'"
        shadow="never"
        class="detail-card detail-section"
      >
        <template #header>
          <div class="section-header">
            <span>{{ t("monitoring.runtimeAssets.detail.apiKeys") }}</span>
            <el-button type="primary" size="small" @click="openCredentialDialog">
              {{ t("monitoring.runtimeAssets.detail.createApiKey") }}
            </el-button>
          </div>
        </template>

        <el-alert
          v-if="createdApiKey"
          type="success"
          :closable="true"
          :title="t('monitoring.runtimeAssets.detail.apiKeyCreated')"
          class="detail-inline-alert"
          @close="createdApiKey = ''"
        >
          <template #default>
            <div class="api-key-created">
              <div>{{ t("monitoring.runtimeAssets.detail.apiKeyCreatedHint") }}</div>
              <el-input :model-value="createdApiKey" readonly />
            </div>
          </template>
        </el-alert>

        <el-empty
          v-if="!credentials.length"
          :description="t('monitoring.runtimeAssets.detail.noApiKeys')"
          :image-size="120"
        />
        <el-table v-else :data="credentials" border size="small">
          <el-table-column prop="name" :label="t('monitoring.runtimeAssets.detail.name')" min-width="180" />
          <el-table-column prop="keyId" :label="t('monitoring.runtimeAssets.detail.keyId')" min-width="160" />
          <el-table-column prop="label" :label="t('monitoring.runtimeAssets.detail.label')" min-width="140" />
          <el-table-column prop="status" :label="t('monitoring.runtimeAssets.detail.status')" width="120" />
          <el-table-column :label="t('monitoring.runtimeAssets.detail.scope')" min-width="220">
            <template #default="{ row }">
              {{ routeScopeLabel(row.routeBindingId) }}
            </template>
          </el-table-column>
          <el-table-column :label="t('monitoring.runtimeAssets.detail.lastUsedAt')" min-width="170">
            <template #default="{ row }">
              {{ formatDateTime(row.lastUsedAt) }}
            </template>
          </el-table-column>
          <el-table-column :label="t('monitoring.runtimeAssets.detail.actions')" width="140" fixed="right">
            <template #default="{ row }">
              <el-button
                type="danger"
                link
                :disabled="row.status === 'revoked'"
                @click="revokeCredential(row)"
              >
                {{ t("monitoring.runtimeAssets.detail.revoke") }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <el-dialog
      v-model="credentialDialogVisible"
      :title="t('monitoring.runtimeAssets.detail.createApiKey')"
      width="560px"
    >
      <el-form label-position="top">
        <el-form-item :label="t('monitoring.runtimeAssets.detail.name')">
          <el-input v-model="credentialForm.name" />
        </el-form-item>
        <el-form-item :label="t('monitoring.runtimeAssets.detail.label')">
          <el-input v-model="credentialForm.label" />
        </el-form-item>
        <el-form-item :label="t('monitoring.runtimeAssets.detail.scope')">
          <el-select
            v-model="credentialForm.routeBindingId"
            clearable
            style="width: 100%"
            :placeholder="t('monitoring.runtimeAssets.detail.runtimeWideScope')"
          >
            <el-option
              v-for="option in routeScopeOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="credentialDialogVisible = false">
          {{ t("common.cancel") }}
        </el-button>
        <el-button
          type="primary"
          :loading="credentialActionLoading"
          @click="createCredential"
        >
          {{ t("monitoring.runtimeAssets.detail.createApiKey") }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
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
const credentials = ref<any[]>([]);
const createdApiKey = ref("");
const credentialDialogVisible = ref(false);
const credentialActionLoading = ref(false);
const credentialForm = ref({
  name: "",
  label: "",
  routeBindingId: "",
});
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
const gatewayGovernance = computed(
  () => runtimeSummary.value?.gatewayGovernance || detail.value?.runtimeSummary?.gatewayGovernance || null,
);
const gatewayMetrics = computed(
  () => runtimeSummary.value?.gatewayMetrics || detail.value?.runtimeSummary?.gatewayMetrics || null,
);
const gatewayPolicyCounts = computed(
  () => gatewayMetrics.value?.policyCounts || {},
);
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
const hasManagedDeployment = computed(
  () => asset.value?.type === "gateway_service" || Boolean(managedServer.value?.id),
);
const isRunning = computed(() => ["running", "active"].includes(runtimeStatus.value));
const isTransitioning = computed(() => ["starting", "stopping"].includes(runtimeStatus.value));
const canOperateAfterStop = computed(() => !isRunning.value && !isTransitioning.value);
const canStart = computed(() => hasManagedDeployment.value && canOperateAfterStop.value);
const canStop = computed(() => hasManagedDeployment.value && isRunning.value);
const canRedeploy = computed(() => hasManagedDeployment.value && isRunning.value);
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
const routeScopeOptions = computed(() =>
  memberships.value
    .filter((item: any) => item?.gatewayRouteBinding?.id)
    .map((item: any) => ({
      value: item.gatewayRouteBinding.id,
      label: `${item.endpointDefinition?.method || "-"} ${item.endpointDefinition?.path || item.gatewayRouteBinding?.routePath || "-"}`,
    })),
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
    const detailResult = await runtimeAssetsAPI.getRuntimeAssetDetail(runtimeAssetId.value);
    const [observabilityResult, accessLogResult, credentialResult] = await Promise.all([
      runtimeAssetsAPI.getRuntimeAssetObservability(runtimeAssetId.value),
      runtimeAssetsAPI.getRuntimeAssetAccessLogs(runtimeAssetId.value, 20),
      detailResult?.asset?.type === "gateway_service"
        ? runtimeAssetsAPI
            .listGatewayConsumerCredentials(runtimeAssetId.value)
            .catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] }),
    ]);
    detail.value = detailResult;
    observability.value = observabilityResult;
    accessLogs.value = Array.isArray(accessLogResult) ? accessLogResult : [];
    credentials.value = Array.isArray(credentialResult?.data) ? credentialResult.data : [];
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

const openCredentialDialog = () => {
  credentialForm.value = {
    name: "",
    label: "",
    routeBindingId: "",
  };
  credentialDialogVisible.value = true;
};

const routeScopeLabel = (routeBindingId?: string) => {
  if (!routeBindingId) {
    return t("monitoring.runtimeAssets.detail.runtimeWideScope");
  }
  const option = routeScopeOptions.value.find((item: any) => item.value === routeBindingId);
  return option?.label || routeBindingId;
};

const createCredential = async () => {
  if (!credentialForm.value.name.trim()) {
    ElMessage.warning(t("monitoring.runtimeAssets.detail.nameRequired"));
    return;
  }

  credentialActionLoading.value = true;
  try {
    const result = await runtimeAssetsAPI.createGatewayConsumerCredential(runtimeAssetId.value, {
      name: credentialForm.value.name.trim(),
      label: credentialForm.value.label.trim() || undefined,
      routeBindingId: credentialForm.value.routeBindingId || undefined,
    });
    createdApiKey.value = String(result?.apiKey || "");
    credentialDialogVisible.value = false;
    ElMessage.success(t("monitoring.runtimeAssets.detail.apiKeyCreateSuccess"));
    await loadDetail();
  } catch (error: any) {
    ElMessage.error(error?.message || t("monitoring.runtimeAssets.detail.apiKeyCreateFailed"));
  } finally {
    credentialActionLoading.value = false;
  }
};

const revokeCredential = async (credential: any) => {
  try {
    await ElMessageBox.confirm(
      t("monitoring.runtimeAssets.detail.revokeConfirm", {
        name: credential?.name || credential?.keyId || "-",
      }),
      t("common.warning"),
      {
        type: "warning",
      },
    );
  } catch {
    return;
  }

  credentialActionLoading.value = true;
  try {
    await runtimeAssetsAPI.revokeGatewayConsumerCredential(
      runtimeAssetId.value,
      credential.id,
      {},
    );
    ElMessage.success(t("monitoring.runtimeAssets.detail.apiKeyRevokeSuccess"));
    await loadDetail();
  } catch (error: any) {
    ElMessage.error(error?.message || t("monitoring.runtimeAssets.detail.apiKeyRevokeFailed"));
  } finally {
    credentialActionLoading.value = false;
  }
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

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.detail-section {
  margin-top: 16px;
}

.detail-inline-alert {
  margin-bottom: 16px;
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

.metric-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.membership-governance {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.api-key-created {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
