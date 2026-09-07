<template>
  <div class="config-manager">
    <div class="page-header">
      <div>
        <h2>{{ t("config.title") }}</h2>
        <p>{{ t("config.subtitle") }}</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="refreshData(true)">
          {{ t("config.refresh") }}
        </el-button>
        <el-button
          type="primary"
          :icon="Check"
          :loading="saving"
          :disabled="!hasDraftChanges"
          @click="saveSection"
        >
          {{ t("config.save") }}
        </el-button>
        <el-button :disabled="!hasDraftChanges" @click="resetSectionDraft">
          {{ t("config.reset") }}
        </el-button>
      </div>
    </div>

    <el-alert
      :title="t('config.summary')"
      :description="t('config.summaryDescription')"
      type="info"
      show-icon
      :closable="false"
      class="summary-alert"
    />

    <el-alert
      v-if="lastSaveSummary"
      :title="lastSaveSummary.title"
      :description="lastSaveSummary.detail"
      :type="lastSaveSummary.restartRequiredKeys.length ? 'warning' : 'success'"
      show-icon
      :closable="false"
      class="summary-alert"
    />

    <el-alert
      v-if="lastSaveSummary?.restartPlan?.length"
      :title="t('config.restartPlan')"
      :description="lastSaveSummary.restartPlan.join(', ')"
      type="warning"
      show-icon
      :closable="false"
      class="summary-alert"
    />

    <div class="summary-grid">
      <el-card shadow="never">
        <template #header>{{ t("config.currentEnvironment") }}</template>
        <div class="metric-value">{{ environmentInfo?.nodeEnv ?? "-" }}</div>
      </el-card>
      <el-card shadow="never">
        <template #header>{{ t("config.editableFields") }}</template>
        <div class="metric-value">{{ editableFieldCount }}</div>
      </el-card>
      <el-card shadow="never">
        <template #header>{{ t("config.restartRequiredFields") }}</template>
        <div class="metric-value">{{ restartRequiredCount }}</div>
      </el-card>
      <el-card shadow="never">
        <template #header>{{ t("config.sensitiveFields") }}</template>
        <div class="metric-value">{{ sensitiveCount }}</div>
      </el-card>
    </div>

    <el-tabs v-model="activeTab" class="content-tabs">
      <el-tab-pane :label="t('config.effectiveConfig')" name="overview">
        <div v-loading="loading" class="overview-layout">
          <el-card shadow="never" class="sections-card">
            <template #header>
              <div class="card-header">
                <span>{{ t("config.effectiveConfig") }}</span>
                <span class="muted">{{ t("config.reloadDetails") }}</span>
              </div>
            </template>

            <el-empty v-if="!sectionSummaries.length" :description="t('config.noConfig')" />

            <div v-else class="section-grid">
              <button
                v-for="section in sectionSummaries"
                :key="section.key"
                type="button"
                class="section-tile"
                :class="{ active: selectedSectionKey === section.key }"
                @click="selectedSectionKey = section.key"
              >
                <div class="tile-top">
                  <span class="tile-title">{{ section.title }}</span>
                  <span class="tile-count">{{ section.fieldCount }} {{ t("config.fields") }}</span>
                </div>
                <div class="tile-meta">
                  <span>{{ t("config.editableFields") }}: {{ section.editableCount }}</span>
                  <span>{{ t("config.restartRequired") }}: {{ section.restartRequiredCount }}</span>
                  <span>{{ t("config.sensitivity") }}: {{ section.sensitiveCount }}</span>
                </div>
              </button>
            </div>
          </el-card>

          <div class="details-stack">
            <el-card shadow="never" class="details-card">
              <template #header>
                <div class="card-header">
                  <span>{{ selectedSection?.title ?? t("config.effectiveConfig") }}</span>
                  <span class="muted">{{ selectedSection?.fieldCount ?? 0 }} {{ t("config.fields") }}</span>
                </div>
              </template>

              <el-empty v-if="!selectedSection" :description="t('config.noConfig')" />

              <el-table
                v-else
                :data="selectedSection.rows"
                size="small"
                stripe
                max-height="320"
              >
                <el-table-column prop="field" :label="t('config.field')" min-width="150" />
                <el-table-column prop="valueLabel" :label="t('config.value')" min-width="220" show-overflow-tooltip />
                <el-table-column prop="sourceLabel" :label="t('config.source')" min-width="120" />
                <el-table-column prop="sensitivityLabel" :label="t('config.sensitivity')" min-width="120" />
                <el-table-column prop="restartRequiredLabel" :label="t('config.restartRequired')" min-width="120" />
              </el-table>
            </el-card>

            <el-card shadow="never" class="editor-card">
              <template #header>
                <div class="card-header">
                  <span>{{ t("config.editableFields") }}</span>
                  <span class="muted">{{ editableRows.length }}</span>
                </div>
              </template>

              <el-empty v-if="!editableRows.length" :description="t('config.noEditableFields')" />

              <div v-else class="editor-list">
                <div v-for="row in editableRows" :key="row.field" class="editor-item">
                  <div class="editor-meta">
                    <div class="editor-title">
                      <span>{{ row.field }}</span>
                      <el-tag v-if="row.restartRequired" size="small" type="warning">
                        {{ t("config.restartRequired") }}
                      </el-tag>
                    </div>
                    <div class="editor-desc">{{ row.description }}</div>
                    <div class="editor-current">{{ t("config.value") }}: {{ row.valueLabel }}</div>
                  </div>

                  <div class="editor-input">
                    <el-switch
                      v-if="row.valueType === 'boolean'"
                      v-model="sectionDraft[row.field]"
                    />
                    <el-input-number
                      v-else-if="row.valueType === 'number'"
                      v-model="sectionDraft[row.field]"
                      :min="0"
                      :step="1"
                      controls-position="right"
                    />
                    <el-input
                      v-else
                      v-model="sectionDraft[row.field]"
                      :placeholder="t('config.newValue')"
                      clearable
                    />
                  </div>
                </div>

                <el-alert
                  v-if="restartDraftFields.length"
                  :title="t('config.pendingRestartHint')"
                  :description="restartDraftFields.join(', ')"
                  type="warning"
                  show-icon
                  :closable="false"
                />
              </div>
            </el-card>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane :label="t('config.environmentInfo')" name="environment">
        <el-card shadow="never" class="environment-card">
          <template #header>{{ t("config.environmentInfo") }}</template>
          <el-descriptions v-if="environmentInfo" :column="2" border>
            <el-descriptions-item label="NODE_ENV">{{ environmentInfo.nodeEnv }}</el-descriptions-item>
            <el-descriptions-item label="PORT">{{ environmentInfo.port }}</el-descriptions-item>
            <el-descriptions-item label="MCP_PORT">{{ environmentInfo.mcpPort }}</el-descriptions-item>
            <el-descriptions-item label="Timestamp">{{ environmentInfo.timestamp }}</el-descriptions-item>
            <el-descriptions-item label="isDevelopment">{{ environmentInfo.isDevelopment }}</el-descriptions-item>
            <el-descriptions-item label="isProduction">{{ environmentInfo.isProduction }}</el-descriptions-item>
            <el-descriptions-item label="isTest">{{ environmentInfo.isTest }}</el-descriptions-item>
          </el-descriptions>
          <el-empty v-else :description="t('config.noConfig')" />
        </el-card>
      </el-tab-pane>

      <el-tab-pane :label="t('config.systemBoundary')" name="boundary">
        <BackupManager />
      </el-tab-pane>
    </el-tabs>

    <el-card shadow="never" class="events-card">
      <template #header>{{ t("config.recentEvents") }}</template>
      <el-empty v-if="!operationHistory.length" :description="t('config.noEvents')" />
      <el-timeline v-else>
        <el-timeline-item
          v-for="item in operationHistory"
          :key="item.id"
          :timestamp="item.timestamp"
          :type="item.success ? 'success' : 'danger'"
        >
          <div class="event-title">{{ item.title }}</div>
          <div class="event-detail">{{ item.detail }}</div>
        </el-timeline-item>
      </el-timeline>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { Check, Refresh } from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
import { configAPI } from "@/services/api";
import BackupManager from "./components/BackupManager.vue";

type ConfigValueSource = "env" | "override" | "derived";
type ConfigValueSensitivity = "public" | "sensitive";
type ConfigValueType = "string" | "number" | "boolean";

interface ConfigFieldMetadata {
  source: ConfigValueSource;
  restartRequired: boolean;
  sensitivity: ConfigValueSensitivity;
  description: string;
  editable: boolean;
}

interface ConfigEnvironmentInfo {
  nodeEnv: string;
  port: number;
  mcpPort: number;
  isDevelopment: boolean;
  isProduction: boolean;
  isTest: boolean;
  timestamp: string;
}

interface ConfigOverviewResponse {
  metadata: Record<string, Record<string, ConfigFieldMetadata>>;
  [section: string]: unknown;
}

interface ConfigUpdateResponse {
  config: ConfigOverviewResponse;
  updatedKeys: string[];
  restartRequiredKeys: string[];
  restartPlan: string[];
}

interface ConfigSectionRow {
  field: string;
  value: unknown;
  valueLabel: string;
  valueType: ConfigValueType;
  sourceLabel: string;
  sensitivityLabel: string;
  restartRequiredLabel: string;
  restartRequired: boolean;
  description: string;
  editable: boolean;
}

interface ConfigSectionSummary {
  key: string;
  title: string;
  fieldCount: number;
  editableCount: number;
  restartRequiredCount: number;
  sensitiveCount: number;
  rows: ConfigSectionRow[];
}

interface OperationHistoryItem {
  id: string;
  title: string;
  detail: string;
  timestamp: string;
  success: boolean;
}

interface SaveSummary {
  title: string;
  detail: string;
  updatedKeys: string[];
  restartRequiredKeys: string[];
  restartPlan: string[];
}

const SECTION_KEYS = [
  "app",
  "cors",
  "throttle",
  "security",
  "logging",
  "performance",
  "process",
  "runtime",
  "mcp",
  "openapi",
  "monitoring",
  "development",
] as const;

const { t } = useI18n();

const loading = ref(false);
const saving = ref(false);
const activeTab = ref("overview");
const overview = ref<ConfigOverviewResponse | null>(null);
const environmentInfo = ref<ConfigEnvironmentInfo | null>(null);
const selectedSectionKey = ref<string>("logging");
const operationHistory = ref<OperationHistoryItem[]>([]);
const sectionDraft = ref<Record<string, string | number | boolean | null>>({});
const lastSaveSummary = ref<SaveSummary | null>(null);

const translateSource = (source: ConfigValueSource) => {
  if (source === "override") return t("config.sourceOverride");
  return source === "env" ? t("config.sourceEnv") : t("config.sourceDerived");
};

const translateSensitivity = (sensitivity: ConfigValueSensitivity) =>
  sensitivity === "sensitive"
    ? t("config.sensitivitySensitive")
    : t("config.sensitivityPublic");

const inferValueType = (value: unknown): ConfigValueType => {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
};

const formatValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") {
    return t("config.emptyValue");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.length ? value.join(", ") : t("config.emptyValue");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const sectionSummaries = computed<ConfigSectionSummary[]>(() => {
  if (!overview.value?.metadata) return [];

  return SECTION_KEYS.map((sectionKey) => {
    const sectionValues = (overview.value?.[sectionKey] as Record<string, unknown>) || {};
    const sectionMetadata = overview.value?.metadata?.[sectionKey] || {};
    const rows = Object.entries(sectionMetadata).map(([field, metadata]) => ({
      field,
      value: sectionValues[field],
      valueLabel: formatValue(sectionValues[field]),
      valueType: inferValueType(sectionValues[field]),
      sourceLabel: translateSource(metadata.source),
      sensitivityLabel: translateSensitivity(metadata.sensitivity),
      restartRequiredLabel: metadata.restartRequired ? t("config.yes") : t("config.no"),
      restartRequired: metadata.restartRequired,
      description: metadata.description,
      editable: metadata.editable,
    }));

    return {
      key: sectionKey,
      title: t(`config.sections.${sectionKey}`),
      fieldCount: rows.length,
      editableCount: rows.filter((row) => row.editable).length,
      restartRequiredCount: rows.filter((row) => row.restartRequired).length,
      sensitiveCount: rows.filter((row) => row.sensitivityLabel === t("config.sensitivitySensitive")).length,
      rows,
    };
  }).filter((section) => section.fieldCount > 0);
});

const selectedSection = computed(
  () =>
    sectionSummaries.value.find((section) => section.key === selectedSectionKey.value) ||
    sectionSummaries.value[0],
);

const editableRows = computed(() => selectedSection.value?.rows.filter((row) => row.editable) || []);

const restartDraftFields = computed(() =>
  editableRows.value
    .filter((row) => row.restartRequired && sectionDraft.value[row.field] !== row.value)
    .map((row) => row.field),
);

const editableFieldCount = computed(() =>
  sectionSummaries.value.reduce((total, section) => total + section.editableCount, 0),
);

const restartRequiredCount = computed(() =>
  sectionSummaries.value.reduce((total, section) => total + section.restartRequiredCount, 0),
);

const sensitiveCount = computed(() =>
  sectionSummaries.value.reduce((total, section) => total + section.sensitiveCount, 0),
);

const hasDraftChanges = computed(() =>
  editableRows.value.some((row) => sectionDraft.value[row.field] !== row.value),
);

const addHistory = (title: string, detail: string, success: boolean) => {
  operationHistory.value.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    detail,
    timestamp: new Date().toLocaleString(),
    success,
  });
  operationHistory.value = operationHistory.value.slice(0, 10);
};

const syncSectionDraft = () => {
  const nextDraft: Record<string, string | number | boolean | null> = {};
  for (const row of editableRows.value) {
    nextDraft[row.field] = (row.value ?? "") as string | number | boolean | null;
  }
  sectionDraft.value = nextDraft;
};

watch(selectedSectionKey, () => {
  syncSectionDraft();
});

watch(editableRows, () => {
  syncSectionDraft();
});

const refreshData = async (manual = false) => {
  loading.value = true;
  try {
    const [configResponse, environmentResponse] = await Promise.all([
      configAPI.getConfigOverview(),
      configAPI.getConfigEnvironment(),
    ]);
    overview.value = configResponse;
    environmentInfo.value = environmentResponse;

    if (!selectedSectionKey.value || !sectionSummaries.value.some((item) => item.key === selectedSectionKey.value)) {
      selectedSectionKey.value = sectionSummaries.value.find((item) => item.editableCount > 0)?.key || sectionSummaries.value[0]?.key || "logging";
    }

    syncSectionDraft();

    addHistory(
      manual ? t("config.events.manualRefresh") : t("config.events.initialLoad"),
      `${sectionSummaries.value.length} ${t("config.section")}`,
      true,
    );

    if (manual) {
      ElMessage.success(t("config.refreshSuccess"));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : t("config.refreshFailed");
    addHistory(t("config.events.loadFailed"), message, false);
    ElMessage.error(t("config.refreshFailed"));
  } finally {
    loading.value = false;
  }
};

const saveSection = async () => {
  if (!selectedSection.value || !hasDraftChanges.value) return;

  const payload: Record<string, Record<string, unknown>> = {
    [selectedSection.value.key]: {},
  };

  for (const row of editableRows.value) {
    if (sectionDraft.value[row.field] !== row.value) {
      payload[selectedSection.value.key][row.field] = sectionDraft.value[row.field];
    }
  }

  saving.value = true;
  try {
    const updated: ConfigUpdateResponse = await configAPI.updateConfigOverview(payload);
    overview.value = updated.config;
    syncSectionDraft();
    const updatedKeys = updated.updatedKeys || [];
    const restartRequiredKeys = updated.restartRequiredKeys || [];
    const restartPlan = updated.restartPlan || [];
    const updatedLabel = updatedKeys.length
      ? `${t("config.updatedFields")}: ${updatedKeys.join(", ")}`
      : t("config.noChangesSaved");
    const restartLabel = restartRequiredKeys.length
      ? ` ${t("config.restartRequiredSaved")}: ${restartRequiredKeys.join(", ")}`
      : "";
    const planLabel = restartPlan.length
      ? ` ${t("config.restartPlan")}: ${restartPlan.join(", ")}`
      : "";
    const detail = `${selectedSection.value.title} · ${updatedLabel}${restartLabel}${planLabel}`;

    lastSaveSummary.value = {
      title: restartRequiredKeys.length
        ? t("config.saveSuccessRestartRequired")
        : t("config.saveSuccess"),
      detail,
      updatedKeys,
      restartRequiredKeys,
      restartPlan,
    };

    addHistory(t("config.save"), detail, true);
    ElMessage.success(t("config.saveSuccess"));
  } catch (error) {
    const message = error instanceof Error ? error.message : t("config.saveFailed");
    lastSaveSummary.value = null;
    addHistory(t("config.save"), message, false);
    ElMessage.error(t("config.saveFailed"));
  } finally {
    saving.value = false;
  }
};

const resetSectionDraft = () => {
  syncSectionDraft();
};

onMounted(() => {
  void refreshData(false);
});
</script>

<style scoped>
.config-manager {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.page-header h2 {
  margin: 0 0 8px;
}

.page-header p {
  margin: 0;
  color: var(--el-text-color-regular);
}

.header-actions {
  display: flex;
  gap: 12px;
}

.summary-alert {
  margin-bottom: 4px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.metric-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
}

.content-tabs {
  margin-top: 4px;
}

.overview-layout {
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  gap: 16px;
}

.details-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.section-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-tile {
  width: 100%;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--el-bg-color);
  padding: 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.section-tile:hover,
.section-tile.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.18);
}

.tile-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.tile-title {
  font-weight: 600;
}

.tile-count {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.tile-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--el-text-color-regular);
  font-size: 12px;
}

.editor-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.editor-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.editor-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.editor-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-weight: 600;
}

.editor-desc,
.editor-current {
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.5;
}

.editor-input {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.environment-card,
.events-card {
  width: 100%;
}

.event-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.event-detail {
  color: var(--el-text-color-regular);
  font-size: 13px;
}

@media (max-width: 1100px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .overview-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .page-header {
    flex-direction: column;
    align-items: stretch;
  }

  .header-actions {
    flex-wrap: wrap;
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }

  .editor-item {
    grid-template-columns: 1fr;
  }

  .editor-input {
    justify-content: flex-start;
  }
}
</style>
