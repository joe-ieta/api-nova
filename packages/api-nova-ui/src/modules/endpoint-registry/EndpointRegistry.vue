<template>
  <div class="endpoint-registry">
    <div class="page-header">
      <div>
        <h1>{{ t("endpointRegistry.title") }}</h1>
        <p class="muted">
          {{ activeSubtitle }}
        </p>
      </div>
      <div class="header-actions">
        <el-button
          type="warning"
          @click="openCreateDialog"
        >
          {{ t("endpointRegistry.actions.addManualEndpoint") }}
        </el-button>
        <el-button type="primary" @click="loadOverview" :loading="loading">
          {{ t("common.refresh") }}
        </el-button>
      </div>
    </div>

    <el-card shadow="never" class="toolbar-card">
      <el-row :gutter="12">
        <el-col :xs="24" :md="12">
            <el-radio-group v-model="selectedSourceType" size="small">
            <el-radio-button value="all">
              {{ sourceTypeLabel.all }}
            </el-radio-button>
            <el-radio-button value="manual">
              {{ sourceTypeLabel.manual }}
            </el-radio-button>
            <el-radio-button value="imported">
              {{ sourceTypeLabel.imported }}
            </el-radio-button>
          </el-radio-group>
        </el-col>
        <el-col :xs="24" :md="12">
          <el-input
            v-model="search"
            clearable
            :placeholder="t('endpointRegistry.searchPlaceholder')"
          />
        </el-col>
      </el-row>
    </el-card>

    <el-alert
      v-if="errorMessage"
      type="error"
      :title="errorMessage"
      show-icon
      class="mb-12"
    />
    <el-alert
      :title="activeModeHint"
      type="info"
      show-icon
      :closable="false"
      class="mb-12"
    />
    <el-empty
      v-if="!loading && filteredGroups.length === 0"
      :description="t('endpointRegistry.empty')"
    />

    <el-collapse v-else v-model="expandedGroupKeys">
      <el-collapse-item
        v-for="group in filteredGroups"
        :key="group.groupKey"
        :name="group.groupKey"
      >
        <template #title>
          <div class="group-title">
            <span class="group-name">{{ group.groupName }}</span>
            <el-tag type="info">{{ group.baseUrl }}</el-tag>
            <span class="count">{{
              t("endpointRegistry.groupCount", { count: group.endpoints.length })
            }}</span>
          </div>
        </template>

        <el-table :data="group.endpoints" size="small" border style="width: 100%" table-layout="auto">
          <el-table-column prop="name" :label="t('endpointRegistry.table.name')" min-width="180" />
          <el-table-column
            prop="sourceType"
            :label="t('endpointRegistry.table.source')"
            width="110"
          >
            <template #default="{ row }">
              <el-tag :type="row.sourceType === 'manual' ? 'warning' : 'primary'">
                {{ row.sourceType === "manual" ? sourceTypeLabel.manual : sourceTypeLabel.imported }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="methodPath"
            :label="t('endpointRegistry.table.methodPath')"
            min-width="220"
          />
          <el-table-column
            prop="lifecycleStatus"
            :label="t('endpointRegistry.table.lifecycle')"
            width="120"
          >
            <template #default="{ row }">
              <el-tag :type="getLifecycleTagType(row.lifecycleStatus)">
                {{ getLifecycleLabel(row.lifecycleStatus) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="lastProbeStatus" :label="t('endpointRegistry.table.probe')" width="120">
            <template #default="{ row }">
              <el-tag :type="getProbeTagType(row.lastProbeStatus)">
                {{ getProbeLabel(row.lastProbeStatus) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="lastProbeSummary"
            :label="probeDetailsLabel"
            min-width="280"
            show-overflow-tooltip
          />
          <el-table-column
            prop="publishEnabled"
            :label="t('endpointRegistry.table.publishEnabled')"
            width="130"
          >
            <template #default="{ row }">
              <el-tag :type="row.publishEnabled ? 'success' : 'info'">
                {{ row.publishEnabled ? t("common.yes") : t("common.no") }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="updatedAtText"
            :label="t('endpointRegistry.table.updatedAt')"
            min-width="180"
          />
          <el-table-column :label="t('endpointRegistry.table.actions')" width="360" fixed="right">
            <template #default="{ row }">
              <div class="row-actions">
                <el-button
                  size="small"
                  :icon="Connection"
                  class="action-btn"
                  @click="handleProbe(row)"
                  :loading="isActionLoading(row.id, 'probe')"
                >
                  {{ t("endpointRegistry.actions.probe") }}
                </el-button>
                <el-button
                  size="small"
                  :icon="CircleCheck"
                  class="action-btn"
                  @click="handleReadiness(row)"
                  :loading="isActionLoading(row.id, 'readiness')"
                >
                  {{ t("endpointRegistry.actions.readiness") }}
                </el-button>
                <el-button
                  size="small"
                  type="success"
                  :icon="UploadFilled"
                  class="action-btn"
                  @click="handlePublish(row)"
                  :loading="isActionLoading(row.id, 'publish')"
                >
                  {{ t("endpointRegistry.actions.publish") }}
                </el-button>
                <el-button
                  size="small"
                  type="warning"
                  :icon="SwitchButton"
                  class="action-btn"
                  @click="handleOffline(row)"
                  :loading="isActionLoading(row.id, 'offline')"
                >
                  {{ t("endpointRegistry.actions.offline") }}
                </el-button>
                <el-button
                  size="small"
                  type="primary"
                  plain
                  :icon="EditIcon"
                  class="action-btn"
                  @click="handleEdit(row)"
                  :loading="isActionLoading(row.id, 'edit')"
                >
                  {{
                    row.sourceType === "imported"
                      ? t("endpointRegistry.actions.governance")
                      : t("endpointRegistry.actions.edit")
                  }}
                </el-button>
                <el-button
                  v-if="row.sourceType === 'manual'"
                  size="small"
                  type="danger"
                  plain
                  :icon="DeleteIcon"
                  class="action-btn delete-action-btn"
                  @click="handleDelete(row)"
                  :loading="isActionLoading(row.id, 'delete')"
                >
                  {{ t("endpointRegistry.actions.delete") }}
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>

    <el-dialog
      v-model="showCreateDialog"
      :title="dialogTitle"
      width="640px"
      align-center
      @closed="resetCreateForm"
    >
      <el-form
        ref="createFormRef"
        :model="createForm"
        :rules="createFormRules"
        label-width="130px"
      >
        <el-alert
          v-if="isImportedGovernanceEdit"
          :title="t('endpointRegistry.messages.importedEditHint')"
          type="info"
          show-icon
          :closable="false"
          class="mb-12"
        />
        <el-form-item :label="t('endpointRegistry.form.name')" prop="name">
          <el-input
            v-model="createForm.name"
            clearable
            :disabled="isImportedGovernanceEdit"
            :placeholder="t('endpointRegistry.form.namePlaceholder')"
          />
        </el-form-item>
        <el-form-item
          v-if="!isImportedGovernanceEdit"
          :label="t('endpointRegistry.form.baseUrl')"
          prop="baseUrl"
        >
          <el-input
            v-model="createForm.baseUrl"
            clearable
            :placeholder="t('endpointRegistry.form.baseUrlPlaceholder')"
          />
        </el-form-item>
        <el-form-item
          v-if="!isImportedGovernanceEdit"
          :label="t('endpointRegistry.form.method')"
          prop="method"
        >
          <el-select v-model="createForm.method" style="width: 100%">
            <el-option label="GET" value="GET" />
            <el-option label="POST" value="POST" />
            <el-option label="PUT" value="PUT" />
            <el-option label="PATCH" value="PATCH" />
            <el-option label="DELETE" value="DELETE" />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="!isImportedGovernanceEdit"
          :label="t('endpointRegistry.form.path')"
          prop="path"
        >
          <el-input
            v-model="createForm.path"
            clearable
            :placeholder="t('endpointRegistry.form.pathPlaceholder')"
          />
        </el-form-item>
        <el-form-item v-if="!isImportedGovernanceEdit" :label="t('endpointRegistry.form.description')">
          <el-input v-model="createForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.businessDomain')">
          <el-input
            v-model="createForm.businessDomain"
            clearable
            :placeholder="t('endpointRegistry.form.businessDomainPlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.riskLevel')">
          <el-select v-model="createForm.riskLevel" style="width: 100%">
            <el-option label="low" value="low" />
            <el-option label="medium" value="medium" />
            <el-option label="high" value="high" />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="isImportedGovernanceEdit"
          :label="t('endpointRegistry.form.probeUrl')"
        >
          <el-input
            v-model="createForm.probeUrl"
            clearable
            :placeholder="t('endpointRegistry.form.probeUrlPlaceholder')"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="showCreateDialog = false">{{ t("common.cancel") }}</el-button>
          <el-button type="primary" :loading="creating" @click="submitCreateForm">
            {{
              creating
                ? t(isEditMode ? "common.updating" : "endpointRegistry.messages.submitting")
                : t(isEditMode ? "common.update" : "common.create")
            }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { FormInstance } from "element-plus";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Connection,
  CircleCheck,
  UploadFilled,
  SwitchButton,
  Edit as EditIcon,
  Delete as DeleteIcon,
} from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { serverAPI } from "@/services/api";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

type ApiCenterRow = {
  id: string;
  name: string;
  updatedAt?: string;
  endpoint?: {
    method?: string;
    path?: string;
  };
  endpoints?: Array<{
    method: string;
    path: string;
  }>;
  profile?: {
    sourceType?: "manual" | "imported";
    sourceRef?: string;
    probeUrl?: string;
    lifecycleStatus?: string;
    publishEnabled?: boolean;
    lastProbeStatus?: string;
    lastProbeError?: string;
    lastProbeHttpStatus?: number;
  };
};

type EndpointRow = {
  id: string;
  serverId: string;
  name: string;
  baseUrl: string;
  groupName: string;
  endpointPath: string;
  methodPath: string;
  sourceType: "manual" | "imported";
  lifecycleStatus: string;
  publishEnabled: boolean;
  lastProbeStatus: string;
  lastProbeSummary: string;
  updatedAtText: string;
};

type Group = {
  groupKey: string;
  baseUrl: string;
  groupName: string;
  endpoints: EndpointRow[];
};

const loading = ref(false);
const errorMessage = ref("");
const search = ref("");
const rows = ref<EndpointRow[]>([]);
const expandedGroupKeys = ref<string[]>([]);
const selectedSourceType = ref<"all" | "manual" | "imported">("all");
const actionLoading = ref<Record<string, string>>({});
const showCreateDialog = ref(false);
const creating = ref(false);
type FormMode = "create" | "edit-manual" | "edit-imported";
const formMode = ref<FormMode>("create");
const editingRowId = ref("");
const editingServerId = ref("");
const editingServerConfig = ref<Record<string, any> | null>(null);
const createFormRef = ref<FormInstance>();
const createForm = ref({
  name: "",
  baseUrl: "",
  method: "GET",
  path: "",
  description: "",
  businessDomain: "",
  riskLevel: "medium",
  probeUrl: "",
});

const isImportedGovernanceEdit = computed(() => formMode.value === "edit-imported");
const isEditMode = computed(() => formMode.value !== "create");

const createFormRules = computed(() => {
  const rules: Record<string, any[]> = {
    name: [
      {
        required: true,
        message: t("endpointRegistry.validation.nameRequired"),
        trigger: "blur",
      },
    ],
  };

  if (!isImportedGovernanceEdit.value) {
    rules.baseUrl = [
      {
        required: true,
        message: t("endpointRegistry.validation.baseUrlRequired"),
        trigger: "blur",
      },
      {
        type: "url",
        message: t("endpointRegistry.validation.baseUrlInvalid"),
        trigger: "blur",
      },
    ];
    rules.method = [
      {
        required: true,
        message: t("endpointRegistry.validation.methodRequired"),
        trigger: "change",
      },
    ];
    rules.path = [
      {
        required: true,
        message: t("endpointRegistry.validation.pathRequired"),
        trigger: "blur",
      },
      {
        validator: (_: unknown, value: string, callback: (err?: Error) => void) => {
          if (!value || value.startsWith("/")) {
            callback();
            return;
          }
          callback(new Error(t("endpointRegistry.validation.pathSlashRequired")));
        },
        trigger: "blur",
      },
    ];
  }

  return rules;
});

const isActionLoading = (
  rowId: string,
  action: "probe" | "readiness" | "publish" | "offline" | "edit" | "delete",
) => actionLoading.value[rowId] === action;

const setActionLoading = (
  rowId: string,
  action: "probe" | "readiness" | "publish" | "offline" | "edit" | "delete" | "",
) => {
  if (!action) {
    delete actionLoading.value[rowId];
    return;
  }
  actionLoading.value[rowId] = action;
};

const dialogTitle = computed(() => {
  if (formMode.value === "edit-imported") {
    return t("endpointRegistry.dialog.importedEditTitle");
  }
  if (formMode.value === "edit-manual") {
    return t("endpointRegistry.dialog.editTitle");
  }
  return t("endpointRegistry.dialog.title");
});

const activeSubtitle = computed(() =>
  t(
    selectedSourceType.value === "manual"
      ? "endpointRegistry.subtitleManual"
      : selectedSourceType.value === "imported"
        ? "endpointRegistry.subtitleImported"
        : "endpointRegistry.subtitleAll",
  ),
);

const activeModeHint = computed(() =>
  t(
    selectedSourceType.value === "manual"
      ? "endpointRegistry.modeHints.manual"
      : selectedSourceType.value === "imported"
        ? "endpointRegistry.modeHints.imported"
        : "endpointRegistry.modeHints.all",
  ),
);

const sourceTypeLabel = computed(() => ({
  all: t("endpointRegistry.sourceTypes.all"),
  manual: t("endpointRegistry.sourceTypes.manual"),
  imported: t("endpointRegistry.sourceTypes.imported"),
}));

const probeDetailsLabel = computed(() => t("endpointRegistry.table.probeDetails"));

const openCreateDialog = () => {
  resetCreateForm();
  formMode.value = "create";
  showCreateDialog.value = true;
};

const normalizeBaseUrl = (url?: string) => {
  if (!url) return "unknown";
  return url.trim().replace(/\/+$/, "").toLowerCase();
};

const deriveEndpointBaseUrl = (item: ApiCenterRow) => {
  const openApiServerUrl = String((item as any)?.openApiData?.servers?.[0]?.url || "").trim();
  if (openApiServerUrl) {
    return normalizeBaseUrl(openApiServerUrl);
  }

  const probeUrl = String(item.profile?.probeUrl || "").trim();
  if (probeUrl) {
    try {
      const parsed = new URL(probeUrl);
      return normalizeBaseUrl(`${parsed.protocol}//${parsed.host}`);
    } catch {
      return normalizeBaseUrl(probeUrl);
    }
  }

  return normalizeBaseUrl(item.profile?.sourceRef);
};

const deriveDisplayName = (item: ApiCenterRow) => {
  const openApiTitle = String((item as any)?.openApiData?.info?.title || "").trim();
  if (openApiTitle) {
    return openApiTitle;
  }

  const explicitName = String(item.name || "").trim();
  if (explicitName && explicitName !== "undefined") {
    return explicitName;
  }

  const sourceRef = String(item.profile?.sourceRef || "").trim();
  if (sourceRef) {
    try {
      const parsed = new URL(sourceRef);
      const pathname = parsed.pathname.replace(/\/+$/, "");
      const lastSegment = pathname.split("/").filter(Boolean).pop();
      return lastSegment || parsed.hostname || sourceRef;
    } catch {
      return sourceRef;
    }
  }

  const probeUrl = String(item.profile?.probeUrl || "").trim();
  if (probeUrl) {
    try {
      return new URL(probeUrl).hostname || probeUrl;
    } catch {
      return probeUrl;
    }
  }

  return item.id || "unknown";
};

const extractMethodAndPath = (openApiData: any): { method: string; path: string } => {
  const paths = openApiData?.paths;
  if (!paths || typeof paths !== "object") {
    return { method: "GET", path: "/" };
  }

  const firstPath = Object.keys(paths)[0];
  if (!firstPath) {
    return { method: "GET", path: "/" };
  }

  const firstMethods = paths[firstPath];
  const method = Object.keys(firstMethods || {})[0]?.toUpperCase() || "GET";
  return { method, path: firstPath };
};

const buildManualOpenApiData = (payload: {
  name: string;
  description?: string;
  baseUrl: string;
  method: string;
  path: string;
  version?: string;
}) => ({
  openapi: "3.0.3",
  info: {
    title: payload.name,
    version: payload.version || "1.0.0",
    description: payload.description || "Manual endpoint registration",
  },
  servers: [{ url: payload.baseUrl }],
  paths: {
    [payload.path]: {
      [payload.method.toLowerCase()]: {
        summary: payload.description || `${payload.method.toUpperCase()} ${payload.path}`,
        responses: {
          "200": { description: "OK" },
        },
      },
    },
  },
});

const buildProbeUrl = (baseUrl: string, path: string) => {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
};

const getLifecycleLabel = (status?: string) =>
  t(`endpointRegistry.lifecycleStatus.${status || "draft"}`);

const getLifecycleTagType = (status?: string) => {
  switch (status) {
    case "published":
      return "success";
    case "verified":
      return "primary";
    case "degraded":
      return "danger";
    case "offline":
      return "warning";
    case "retired":
      return "info";
    case "draft":
    default:
      return "info";
  }
};

const getProbeLabel = (status?: string) =>
  t(`endpointRegistry.probeStatus.${status || "unknown"}`);

const getProbeTagType = (status?: string) => {
  switch (status) {
    case "healthy":
      return "success";
    case "unhealthy":
      return "danger";
    case "unknown":
    default:
      return "info";
  }
};

const isValidationLikeProbe = (httpStatus?: number) =>
  [400, 401, 403, 405, 409, 415, 422, 429].includes(Number(httpStatus));

const formatProbeSummary = ({
  probeStatus,
  httpStatus,
  errorMessage,
}: {
  probeStatus?: string;
  httpStatus?: number;
  errorMessage?: string;
}) => {
  const normalizedStatus = probeStatus || "unknown";

  if (normalizedStatus === "healthy" && isValidationLikeProbe(httpStatus)) {
    return t("endpointRegistry.probeSummary.validationLikeHealthy", {
      httpStatus,
      details: errorMessage
        ? ` ${t("endpointRegistry.probeSummary.detailsPrefix", { error: errorMessage })}`
        : "",
    });
  }

  if (normalizedStatus === "healthy") {
    return t("endpointRegistry.probeSummary.healthy", {
      suffix: httpStatus ? ` (HTTP ${httpStatus})` : "",
    });
  }

  if (normalizedStatus === "unhealthy") {
    return t("endpointRegistry.probeSummary.unhealthy", {
      suffix: httpStatus ? ` (HTTP ${httpStatus})` : "",
      details: errorMessage ? `: ${errorMessage}` : "",
    });
  }

  return t("endpointRegistry.probeSummary.unknown");
};

const formatProbeFeedback = (result: {
  probe?: {
    status?: string;
    httpStatus?: number;
    errorMessage?: string;
  };
}) => {
  const probeStatus = result?.probe?.status || "unknown";
  const httpStatus = result?.probe?.httpStatus;
  const errorMessage = result?.probe?.errorMessage;

  if (probeStatus === "healthy" || probeStatus === "unhealthy") {
    return formatProbeSummary({
      probeStatus,
      httpStatus,
      errorMessage,
    });
  }

  return t("endpointRegistry.messages.probeFinished", { status: probeStatus });
};

const withGovernanceScopeHint = (message: string, row: EndpointRow, probeStatus?: string) =>
  row.sourceType === "imported" && probeStatus !== "unknown"
    ? `${message} ${t("endpointRegistry.messages.importedScopeSuffix")}`
    : message;

const detectMethodPath = (item: ApiCenterRow) => {
  if (item.endpoint?.method && item.endpoint?.path) {
    return `${item.endpoint.method} ${item.endpoint.path}`;
  }

  const paths = (item as any)?.openApiData?.paths;
  if (!paths || typeof paths !== "object") return "-";
  const firstPath = Object.keys(paths)[0];
  if (!firstPath) return "-";
  const methods = Object.keys(paths[firstPath] || {});
  const method = methods[0]?.toUpperCase() || "METHOD";
  return `${method} ${firstPath}`;
};

const mapRow = (item: ApiCenterRow): EndpointRow => {
  const baseUrl = deriveEndpointBaseUrl(item);
  const displayName = deriveDisplayName(item);
  return {
    id: item.id,
    serverId: item.id,
    name: displayName,
    baseUrl,
    groupName: displayName,
    endpointPath: item.endpoint?.path || "",
    methodPath: detectMethodPath(item),
    sourceType: (item.profile?.sourceType as "manual" | "imported") || "imported",
    lifecycleStatus: item.profile?.lifecycleStatus || "draft",
    publishEnabled: Boolean(item.profile?.publishEnabled),
    lastProbeStatus: item.profile?.lastProbeStatus || "unknown",
    lastProbeSummary: formatProbeSummary({
      probeStatus: item.profile?.lastProbeStatus,
      httpStatus: item.profile?.lastProbeHttpStatus,
      errorMessage: item.profile?.lastProbeError,
    }),
    updatedAtText: item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "-",
  };
};

const mapImportedRows = (item: ApiCenterRow): EndpointRow[] => {
  const baseUrl = deriveEndpointBaseUrl(item);
  const displayName = deriveDisplayName(item);
  const endpoints = Array.isArray(item.endpoints) && item.endpoints.length > 0
    ? item.endpoints
    : item.endpoint?.path
      ? [{ method: item.endpoint.method || "GET", path: item.endpoint.path }]
      : [];

  if (endpoints.length === 0) {
    return [mapRow(item)];
  }

  return endpoints.map((endpoint) => ({
    id: `${item.id}::${endpoint.method}::${endpoint.path}`,
    serverId: item.id,
    name: displayName,
    baseUrl,
    groupName: displayName,
    endpointPath: endpoint.path,
    methodPath: `${endpoint.method} ${endpoint.path}`,
    sourceType: (item.profile?.sourceType as "manual" | "imported") || "imported",
    lifecycleStatus: item.profile?.lifecycleStatus || "draft",
    publishEnabled: Boolean(item.profile?.publishEnabled),
    lastProbeStatus: item.profile?.lastProbeStatus || "unknown",
    lastProbeSummary: formatProbeSummary({
      probeStatus: item.profile?.lastProbeStatus,
      httpStatus: item.profile?.lastProbeHttpStatus,
      errorMessage: item.profile?.lastProbeError,
    }),
    updatedAtText: item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "-",
  }));
};

const grouped = computed<Group[]>(() => {
  const map = new Map<string, Group>();
  for (const row of rows.value) {
    const groupKey = row.serverId || `${row.groupName}::${row.baseUrl}`;
    if (!map.has(groupKey)) {
      map.set(groupKey, {
        groupKey,
        baseUrl: row.baseUrl,
        groupName: row.groupName,
        endpoints: [],
      });
    }
    map.get(groupKey)!.endpoints.push(row);
  }
  return Array.from(map.values())
    .map((group) => ({
      ...group,
      endpoints: group.endpoints.sort((a, b) => a.methodPath.localeCompare(b.methodPath)),
    }))
    .sort((a, b) =>
      `${a.groupName} ${a.baseUrl}`.localeCompare(`${b.groupName} ${b.baseUrl}`),
    );
});

const filteredGroups = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return grouped.value;
  return grouped.value
    .map((group) => ({
      ...group,
      endpoints: group.endpoints.filter(
        (ep) =>
          ep.baseUrl.includes(q) ||
          ep.name.toLowerCase().includes(q) ||
          ep.methodPath.toLowerCase().includes(q),
      ),
    }))
    .filter((group) => group.endpoints.length > 0);
});

const loadOverview = async () => {
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await serverAPI.getApiCenterOverview({
      sourceType: selectedSourceType.value === "all" ? undefined : selectedSourceType.value,
    });
    const data = Array.isArray(result?.data) ? result.data : [];
    rows.value = data.flatMap((item) =>
      ((item as ApiCenterRow)?.profile?.sourceType || "imported") === "imported"
        ? mapImportedRows(item as ApiCenterRow)
        : [mapRow(item as ApiCenterRow)],
    );
    expandedGroupKeys.value = grouped.value.map((g) => g.groupKey);
  } catch (error: any) {
    rows.value = [];
    errorMessage.value =
      error?.message || t("endpointRegistry.messages.loadFailed");
  } finally {
    loading.value = false;
  }
};

const resetCreateForm = () => {
  formMode.value = "create";
  editingRowId.value = "";
  editingServerId.value = "";
  editingServerConfig.value = null;
  createForm.value = {
    name: "",
    baseUrl: "",
    method: "GET",
    path: "",
    description: "",
    businessDomain: "",
    riskLevel: "medium",
    probeUrl: "",
  };
  createFormRef.value?.clearValidate();
};

const submitCreateForm = async () => {
  if (!createFormRef.value) return;
  try {
    await createFormRef.value.validate();
    creating.value = true;
    const normalizedBaseUrl = createForm.value.baseUrl.trim().replace(/\/+$/, "");
    const payload = {
      name: createForm.value.name.trim(),
      baseUrl: normalizedBaseUrl,
      method: createForm.value.method.toUpperCase(),
      path: createForm.value.path.trim(),
      description: createForm.value.description?.trim() || undefined,
      businessDomain: createForm.value.businessDomain?.trim() || undefined,
      riskLevel: createForm.value.riskLevel || undefined,
    };

    if (formMode.value === "edit-manual" && editingRowId.value) {
      const existingConfig = editingServerConfig.value || {};
      const existingManagement = (existingConfig.management || {}) as Record<string, any>;
      await serverAPI.updateServer(editingRowId.value, {
        name: payload.name,
        description: payload.description,
        openApiData: buildManualOpenApiData({
          name: payload.name,
          description: payload.description,
          baseUrl: payload.baseUrl,
          method: payload.method,
          path: payload.path,
        }),
        config: {
          ...existingConfig,
          management: {
            ...existingManagement,
            sourceType: "manual",
            sourceRef: payload.baseUrl,
            probeUrl: buildProbeUrl(payload.baseUrl, payload.path),
            businessDomain: payload.businessDomain,
            riskLevel: payload.riskLevel,
          },
        },
      });
      ElMessage.success(t("endpointRegistry.messages.updateSuccess"));
    } else if (formMode.value === "edit-imported" && editingServerId.value) {
      await serverAPI.updateApiCenterProfile(editingServerId.value, {
        businessDomain: payload.businessDomain,
        riskLevel: payload.riskLevel,
        probeUrl: createForm.value.probeUrl?.trim() || undefined,
      });
      ElMessage.success(t("endpointRegistry.messages.importedUpdateSuccess"));
    } else {
      await serverAPI.registerManualEndpoint(payload);
      ElMessage.success(t("endpointRegistry.messages.createSuccess"));
    }

    showCreateDialog.value = false;
    await loadOverview();
  } catch (error: any) {
    const messageKey = formMode.value === "edit-imported"
      ? "endpointRegistry.messages.importedUpdateFailed"
      : formMode.value === "edit-manual"
        ? "endpointRegistry.messages.updateFailed"
        : "endpointRegistry.messages.createFailed";
    ElMessage.error(error?.message || t(messageKey));
  } finally {
    creating.value = false;
  }
};

const handleEdit = async (row: EndpointRow) => {
  try {
    setActionLoading(row.id, "edit");
    const detail = await serverAPI.getServerDetails(row.serverId);
    const openApiData = (detail as any)?.openApiData || {};
    const methodPath = extractMethodAndPath(openApiData);
    const management = ((detail as any)?.config?.management || {}) as Record<string, any>;
    const serverBaseUrl = String(
      openApiData?.servers?.[0]?.url || management.sourceRef || "",
    ).replace(/\/+$/, "");
    const fallbackBaseUrl = serverBaseUrl || management.probeUrl || row.baseUrl;

    createForm.value = {
      name: (detail as any)?.name || row.name,
      baseUrl: String(fallbackBaseUrl || "").replace(/\/+$/, ""),
      method: methodPath.method || "GET",
      path: methodPath.path || "/",
      description: (detail as any)?.description || "",
      businessDomain: management.businessDomain || "",
      riskLevel: management.riskLevel || "medium",
      probeUrl:
        management.probeUrl ||
        buildProbeUrl(serverBaseUrl, row.endpointPath || methodPath.path || "/"),
    };
    editingRowId.value = row.serverId;
    editingServerId.value = row.serverId;
    editingServerConfig.value = ((detail as any)?.config || {}) as Record<string, any>;
    formMode.value = row.sourceType === "imported" ? "edit-imported" : "edit-manual";
    showCreateDialog.value = true;
  } catch (error: any) {
    ElMessage.error(error?.message || t("endpointRegistry.messages.updateFailed"));
  } finally {
    setActionLoading(row.id, "");
  }
};

const handleDelete = async (row: EndpointRow) => {
  try {
    await ElMessageBox.confirm(
      t("endpointRegistry.messages.confirmDeleteText", { name: row.name }),
      t("endpointRegistry.messages.confirmDeleteTitle"),
      { type: "warning" },
    );
    setActionLoading(row.id, "delete");
    await serverAPI.deleteServer(row.id);
    ElMessage.success(t("endpointRegistry.messages.deleteSuccess"));
    await loadOverview();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error?.message || t("endpointRegistry.messages.deleteFailed"));
  } finally {
    setActionLoading(row.id, "");
  }
};

const handleProbe = async (row: EndpointRow) => {
  try {
    setActionLoading(row.id, "probe");
    const result = await serverAPI.probeApiCenterEndpoint(row.serverId);
    const probeStatus = result?.probe?.status || "unknown";
    const feedback = withGovernanceScopeHint(
      formatProbeFeedback(result),
      row,
      probeStatus,
    );
    if (probeStatus === "healthy") {
      ElMessage.success(feedback);
    } else if (probeStatus === "unknown") {
      ElMessage.warning(feedback);
    } else {
      ElMessage.error(feedback);
    }
    await loadOverview();
  } catch (error: any) {
    ElMessage.error(error?.message || t("endpointRegistry.messages.probeFailed"));
  } finally {
    setActionLoading(row.id, "");
  }
};

const handleReadiness = async (row: EndpointRow) => {
  try {
    setActionLoading(row.id, "readiness");
    const result = await serverAPI.getApiCenterPublishReadiness(row.serverId);
    if (result.ready) {
      ElMessage.success(
        t(
          row.sourceType === "imported"
            ? "endpointRegistry.messages.readinessReadyImported"
            : "endpointRegistry.messages.readinessReady",
        ),
      );
      return;
    }
    ElMessage.warning(
      t(
        row.sourceType === "imported"
          ? "endpointRegistry.messages.readinessBlockedImported"
          : "endpointRegistry.messages.readinessBlocked",
        {
        reasons: (result.reasons || []).join("; ") || t("endpointRegistry.messages.unknownReason"),
        },
      ),
    );
  } catch (error: any) {
    ElMessage.error(
      error?.message || t("endpointRegistry.messages.readinessFailed"),
    );
  } finally {
    setActionLoading(row.id, "");
  }
};

const handlePublish = async (row: EndpointRow) => {
  try {
    await ElMessageBox.confirm(
      t(
        row.sourceType === "imported"
          ? "endpointRegistry.messages.confirmPublishImportedText"
          : "endpointRegistry.messages.confirmPublishText",
        { name: row.name, methodPath: row.methodPath },
      ),
      t("endpointRegistry.messages.confirmPublishTitle"),
      { type: "warning" },
    );
    setActionLoading(row.id, "publish");
    await serverAPI.changeApiCenterLifecycleState(row.serverId, { action: "publish" });
    ElMessage.success(
      t(
        row.sourceType === "imported"
          ? "endpointRegistry.messages.publishSuccessImported"
          : "endpointRegistry.messages.publishSuccess",
      ),
    );
    await loadOverview();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error?.message || t("endpointRegistry.messages.publishFailed"));
  } finally {
    setActionLoading(row.id, "");
  }
};

const handleOffline = async (row: EndpointRow) => {
  try {
    await ElMessageBox.confirm(
      t(
        row.sourceType === "imported"
          ? "endpointRegistry.messages.confirmOfflineImportedText"
          : "endpointRegistry.messages.confirmOfflineText",
        { name: row.name, methodPath: row.methodPath },
      ),
      t("endpointRegistry.messages.confirmOfflineTitle"),
      { type: "warning" },
    );
    setActionLoading(row.id, "offline");
    await serverAPI.changeApiCenterLifecycleState(row.serverId, { action: "offline" });
    ElMessage.success(
      t(
        row.sourceType === "imported"
          ? "endpointRegistry.messages.offlineSuccessImported"
          : "endpointRegistry.messages.offlineSuccess",
      ),
    );
    await loadOverview();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error?.message || t("endpointRegistry.messages.offlineFailed"));
  } finally {
    setActionLoading(row.id, "");
  }
};

onMounted(async () => {
  const sourceType = route.query.sourceType;
  const keyword = route.query.q;
  if (sourceType === "all" || sourceType === "imported" || sourceType === "manual") {
    selectedSourceType.value = sourceType;
  }
  if (typeof keyword === "string") {
    search.value = keyword;
  }
  await loadOverview();
});

watch(selectedSourceType, async (value) => {
  await router.replace({
    query: {
      ...route.query,
      sourceType: value,
    },
  });
  await loadOverview();
});

watch(search, async (value) => {
  const keyword = value.trim();
  const nextQuery = {
    ...route.query,
    sourceType: selectedSourceType.value,
  } as Record<string, string>;

  if (keyword) {
    nextQuery.q = keyword;
  } else {
    delete nextQuery.q;
  }

  await router.replace({ query: nextQuery });
});
</script>

<style scoped>
.endpoint-registry {
  padding: 20px 24px 24px;
  box-sizing: border-box;
  height: calc(100vh - 60px);
  overflow: auto;
  scrollbar-gutter: stable both-edges;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

.header-actions {
  display: inline-flex;
  gap: 8px;
}

.page-header h1 {
  margin: 0;
  font-size: 24px;
}

.muted {
  margin: 8px 0 0;
  color: #606266;
}

.toolbar-card {
  margin-bottom: 12px;
}

.mb-12 {
  margin-bottom: 12px;
}

.group-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.group-name {
  font-weight: 600;
  color: #303133;
}

.count {
  color: #606266;
}

.row-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.action-btn {
  min-width: 58px;
  margin-left: 0 !important;
}

:deep(.delete-action-btn.el-button--danger.is-plain) {
  color: #fff;
  background-color: #d64545;
  border-color: #d64545;
}

:deep(.delete-action-btn.el-button--danger.is-plain:hover),
:deep(.delete-action-btn.el-button--danger.is-plain:focus-visible) {
  color: #fff;
  background-color: #bb2f2f;
  border-color: #bb2f2f;
}
</style>
