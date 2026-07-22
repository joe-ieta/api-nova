<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('monitoring.runtimeAssets.verification.title')"
    width="1180px"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
    @open="loadRuns"
  >
    <div class="verification-toolbar">
      <span>{{ t('monitoring.runtimeAssets.verification.hint') }}</span>
      <el-button :loading="loading" @click="loadRuns">
        {{ t('common.refresh') }}
      </el-button>
    </div>

    <el-alert
      v-if="errorMessage"
      type="error"
      :title="errorMessage"
      show-icon
      class="verification-alert"
    />

    <el-table v-loading="loading" :data="runs" border size="small" max-height="310">
      <el-table-column :label="t('monitoring.runtimeAssets.verification.createdAt')" min-width="170">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column prop="trigger" :label="t('monitoring.runtimeAssets.verification.trigger')" width="110" />
      <el-table-column :label="t('monitoring.runtimeAssets.verification.status')" width="120">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('monitoring.runtimeAssets.verification.activation')" width="160">
        <template #default="{ row }">
          <el-tag :type="activationTagType(row.activationStatus)" effect="plain">
            {{ row.activationStatus || '-' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('monitoring.runtimeAssets.verification.cases')" width="150">
        <template #default="{ row }">
          <span class="case-count passed">{{ row.passedCount || 0 }}</span>
          / <span class="case-count failed">{{ row.failedCount || 0 }}</span>
          / {{ row.totalCount || 0 }}
        </template>
      </el-table-column>
      <el-table-column :label="t('monitoring.runtimeAssets.verification.revision')" min-width="180">
        <template #default="{ row }">
          <el-tooltip :content="row.candidateRevision || '-'">
            <code>{{ shortRevision(row.candidateRevision) }}</code>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column :label="t('monitoring.runtimeAssets.verification.actions')" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :loading="detailLoading && selectedRunId === row.id" @click="loadRun(row.id)">
            {{ t('monitoring.runtimeAssets.verification.view') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty
      v-if="!loading && !runs.length"
      :description="t('monitoring.runtimeAssets.verification.empty')"
      :image-size="100"
    />

    <template v-if="selectedRun">
      <el-divider />
      <el-descriptions :title="t('monitoring.runtimeAssets.verification.runDetail')" :column="3" border size="small">
        <el-descriptions-item :label="t('monitoring.runtimeAssets.verification.runId')">
          {{ selectedRun.id }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('monitoring.runtimeAssets.verification.previousRevision')">
          {{ shortRevision(selectedRun.previousActiveRevision) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('monitoring.runtimeAssets.verification.completedAt')">
          {{ formatDateTime(selectedRun.completedAt) }}
        </el-descriptions-item>
      </el-descriptions>

      <el-alert
        v-for="(blocker, index) in blockers"
        :key="`${blocker.code || 'blocker'}-${index}`"
        type="warning"
        :closable="false"
        show-icon
        class="verification-alert blocker-alert"
        :title="`${blocker.code || 'blocked'}: ${blocker.message || '-'}`"
      />

      <h4>{{ t('monitoring.runtimeAssets.verification.results') }}</h4>
      <el-table v-loading="detailLoading" :data="results" border size="small" max-height="390">
        <el-table-column prop="kind" :label="t('monitoring.runtimeAssets.verification.kind')" width="120" />
        <el-table-column :label="t('monitoring.runtimeAssets.verification.resultStatus')" width="110">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('monitoring.runtimeAssets.verification.httpStatus')" width="130">
          <template #default="{ row }">{{ row.expectedStatusCode ?? '-' }} / {{ row.actualStatusCode ?? '-' }}</template>
        </el-table-column>
        <el-table-column :label="t('monitoring.runtimeAssets.verification.duration')" width="100">
          <template #default="{ row }">{{ row.durationMs != null ? `${row.durationMs} ms` : '-' }}</template>
        </el-table-column>
        <el-table-column :label="t('monitoring.runtimeAssets.verification.assertion')" min-width="210">
          <template #default="{ row }">
            {{ assertionLabel(row.evidence?.responseAssertion) }}
          </template>
        </el-table-column>
        <el-table-column prop="errorMessage" :label="t('monitoring.runtimeAssets.verification.error')" min-width="280" show-overflow-tooltip />
        <el-table-column :label="t('monitoring.runtimeAssets.verification.evidence')" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="!row.evidence" @click="showEvidence(row)">
              {{ t('monitoring.runtimeAssets.verification.view') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <el-dialog
      v-model="evidenceVisible"
      :title="t('monitoring.runtimeAssets.verification.evidence')"
      width="760px"
      append-to-body
    >
      <pre class="evidence-json">{{ evidenceText }}</pre>
    </el-dialog>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { runtimeAssetsAPI } from "@/services/api";

const props = defineProps<{
  modelValue: boolean;
  runtimeAssetId: string;
}>();
const emit = defineEmits<{ (event: "update:modelValue", value: boolean): void }>();
const { t, locale } = useI18n();

const loading = ref(false);
const detailLoading = ref(false);
const errorMessage = ref("");
const runs = ref<any[]>([]);
const selectedRunId = ref("");
const selectedRun = ref<any>(null);
const results = ref<any[]>([]);
const evidenceVisible = ref(false);
const evidenceText = ref("");
const blockers = computed(() => Array.isArray(selectedRun.value?.blockers) ? selectedRun.value.blockers : []);

const loadRuns = async () => {
  if (!props.runtimeAssetId) return;
  loading.value = true;
  errorMessage.value = "";
  try {
    const response = await runtimeAssetsAPI.listRuntimeVerificationRuns(props.runtimeAssetId);
    runs.value = Array.isArray(response?.data) ? response.data : [];
    if (runs.value.length) await loadRun(runs.value[0].id);
    else {
      selectedRunId.value = "";
      selectedRun.value = null;
      results.value = [];
    }
  } catch (error: any) {
    errorMessage.value = error?.message || t("monitoring.runtimeAssets.verification.loadFailed");
  } finally {
    loading.value = false;
  }
};

const loadRun = async (runId: string) => {
  if (!props.runtimeAssetId || !runId) return;
  detailLoading.value = true;
  selectedRunId.value = runId;
  try {
    const response = await runtimeAssetsAPI.getRuntimeVerificationRun(props.runtimeAssetId, runId);
    selectedRun.value = response?.run || null;
    results.value = Array.isArray(response?.results) ? response.results : [];
  } catch (error: any) {
    errorMessage.value = error?.message || t("monitoring.runtimeAssets.verification.loadFailed");
  } finally {
    detailLoading.value = false;
  }
};

const formatDateTime = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(locale.value);
};
const shortRevision = (value?: string) => value ? `${value.slice(0, 12)}...` : "-";
const statusTagType = (status?: string) => {
  if (status === "passed") return "success";
  if (status === "failed" || status === "blocked") return "danger";
  if (status === "running" || status === "planned") return "warning";
  return "info";
};
const activationTagType = (status?: string) => {
  if (status === "activated") return "success";
  if (status === "retained_previous") return "warning";
  if (status === "blocked") return "danger";
  return "info";
};
const assertionLabel = (assertion?: any) => {
  if (!assertion) return "-";
  const mismatch = Array.isArray(assertion.mismatches) ? assertion.mismatches[0] : null;
  if (assertion.passed) return `${assertion.mode}: passed`;
  return mismatch
    ? `${assertion.mode}: ${mismatch.path} (${mismatch.expected} / ${mismatch.actual})`
    : `${assertion.mode}: failed`;
};
const showEvidence = (row: any) => {
  evidenceText.value = JSON.stringify(row.evidence || {}, null, 2);
  evidenceVisible.value = true;
};
</script>

<style scoped>
.verification-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
  color: var(--el-text-color-secondary);
}
.verification-alert {
  margin-bottom: 12px;
}
.blocker-alert:first-of-type {
  margin-top: 12px;
}
.case-count.passed {
  color: var(--el-color-success);
}
.case-count.failed {
  color: var(--el-color-danger);
}
.evidence-json {
  max-height: 560px;
  overflow: auto;
  margin: 0;
  padding: 14px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
