<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('endpointRegistry.runtimeUpstreamBinding.title', { name: endpointName || runtimeMembershipId })"
    width="980px"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
    @open="load"
  >
    <div v-loading="loading" class="binding-dialog-body">
      <el-alert
        :title="t('endpointRegistry.runtimeUpstreamBinding.hint')"
        type="info"
        show-icon
        :closable="false"
        class="binding-hint"
      />

      <el-form label-width="110px">
        <el-row :gutter="16">
          <el-col :xs="24" :md="8">
            <el-form-item :label="t('endpointRegistry.runtimeUpstreamBinding.fields.environment')" required>
              <el-select
                v-model="form.environment"
                filterable
                allow-create
                style="width: 100%"
                @change="rebuildCandidates"
              >
                <el-option v-for="item in environments" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="8">
            <el-form-item :label="t('endpointRegistry.runtimeUpstreamBinding.fields.selectionMode')" required>
              <el-select v-model="form.selectionMode" style="width: 100%">
                <el-option :label="t('endpointRegistry.runtimeUpstreamBinding.selectionModes.fixedPrimary')" value="fixed_primary" />
                <el-option :label="t('endpointRegistry.runtimeUpstreamBinding.selectionModes.healthyPriority')" value="healthy_priority" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="8">
            <el-form-item :label="t('endpointRegistry.runtimeUpstreamBinding.fields.status')" required>
              <el-select v-model="form.status" style="width: 100%">
                <el-option :label="t('endpointRegistry.runtimeUpstreamBinding.statuses.draft')" value="draft" />
                <el-option :label="t('endpointRegistry.runtimeUpstreamBinding.statuses.verified')" value="verified" />
                <el-option :label="t('endpointRegistry.runtimeUpstreamBinding.statuses.active')" value="active" />
                <el-option :label="t('endpointRegistry.runtimeUpstreamBinding.statuses.blocked')" value="blocked" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item v-if="form.selectionMode === 'fixed_primary'" :label="t('endpointRegistry.runtimeUpstreamBinding.fields.primaryInstance')" required>
          <el-select v-model="form.primaryInstanceId" style="width: 100%" :placeholder="t('endpointRegistry.runtimeUpstreamBinding.primaryPlaceholder')">
            <el-option
              v-for="item in selectedCandidates"
              :key="item.id"
              :label="`${item.name} · ${buildBaseUrl(item)}`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <div class="candidate-header">
        <div>
          <strong>{{ t('endpointRegistry.runtimeUpstreamBinding.candidates.title') }}</strong>
          <span class="candidate-note">{{ t('endpointRegistry.runtimeUpstreamBinding.candidates.note') }}</span>
        </div>
        <el-tag v-if="revision" type="info" effect="plain">{{ t('endpointRegistry.runtimeUpstreamBinding.candidates.revision', { revision }) }}</el-tag>
      </div>

      <el-table :data="candidateRows" border size="small">
        <el-table-column :label="t('endpointRegistry.runtimeUpstreamBinding.candidates.columns.enabled')" width="100" align="center">
          <template #default="{ row }">
            <el-checkbox v-model="row.selected" @change="handleCandidateToggle(row)" />
          </template>
        </el-table-column>
        <el-table-column prop="name" :label="t('endpointRegistry.runtimeUpstreamBinding.candidates.columns.instance')" min-width="150" />
        <el-table-column :label="t('endpointRegistry.runtimeUpstreamBinding.candidates.columns.baseUrl')" min-width="230">
          <template #default="{ row }">{{ buildBaseUrl(row) }}</template>
        </el-table-column>
        <el-table-column prop="status" :label="t('endpointRegistry.runtimeUpstreamBinding.candidates.columns.health')" width="105">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" effect="plain">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('endpointRegistry.runtimeUpstreamBinding.candidates.columns.priority')" width="125">
          <template #default="{ row }">
            <el-input-number v-model="row.priority" :min="0" :disabled="!row.selected" controls-position="right" />
          </template>
        </el-table-column>
        <el-table-column :label="t('endpointRegistry.runtimeUpstreamBinding.candidates.columns.order')" width="115">
          <template #default="{ row }">
            <el-input-number v-model="row.order" :min="0" :disabled="!row.selected" controls-position="right" />
          </template>
        </el-table-column>
        <el-table-column :label="t('endpointRegistry.runtimeUpstreamBinding.candidates.columns.weight')" width="115">
          <template #default="{ row }">
            <el-input-number v-model="row.weight" :min="1" :disabled="!row.selected" controls-position="right" />
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && candidateRows.length === 0" :description="t('endpointRegistry.runtimeUpstreamBinding.candidates.empty')" />

      <UpstreamCredentialPanel />

      <div v-if="resolution" class="resolution-panel">
        <div class="resolution-title">
          <strong>{{ t('endpointRegistry.runtimeUpstreamBinding.resolution.title') }}</strong>
          <el-tag :type="resolution.resolved ? 'success' : 'warning'">
            {{ resolution.resolved ? t("endpointRegistry.runtimeUpstreamBinding.resolution.resolved") : reasonLabel(resolution.reason) }}
          </el-tag>
        </div>
        <div v-if="resolution.resolved && resolution.instance" class="resolution-value">
          {{ t("endpointRegistry.runtimeUpstreamBinding.resolution.summary", { name: resolution.instance.name, baseUrl: buildBaseUrl(resolution.instance), revision: resolution.revision }) }}
        </div>
        <div v-else class="resolution-value">{{ reasonLabel(resolution.reason) }}</div>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer binding-footer">
        <el-button v-if="revision" type="danger" plain :loading="deleting" @click="removeBinding">
          {{ t('endpointRegistry.runtimeUpstreamBinding.actions.deleteBinding') }}
        </el-button>
        <span class="footer-spacer" />
        <el-button @click="emit('update:modelValue', false)">{{ t('endpointRegistry.runtimeUpstreamBinding.actions.cancel') }}</el-button>
        <el-button :disabled="!revision" :loading="resolving" @click="resolveBinding">{{ t('endpointRegistry.runtimeUpstreamBinding.actions.resolve') }}</el-button>
        <el-button type="primary" :loading="saving" @click="save">{{ t('endpointRegistry.runtimeUpstreamBinding.actions.save') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useI18n } from "vue-i18n";
import UpstreamCredentialPanel from "../runtime-assets/UpstreamCredentialPanel.vue";
import { serverAPI } from "@/services/api";

type SourceServiceInstance = {
  id: string;
  name: string;
  environment: string;
  scheme: string;
  host: string;
  port: number;
  basePath: string;
  status: string;
  enabled: boolean;
};

type CandidateRow = SourceServiceInstance & {
  selected: boolean;
  priority: number;
  order: number;
  weight: number;
};

const props = defineProps<{
  modelValue: boolean;
  runtimeMembershipId: string;
  sourceServiceAssetId: string;
  endpointName?: string;
}>();
const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "saved"): void;
}>();

const { t } = useI18n();

const loading = ref(false);
const saving = ref(false);
const resolving = ref(false);
const deleting = ref(false);
const revision = ref<number | null>(null);
const instances = ref<SourceServiceInstance[]>([]);
const candidateRows = ref<CandidateRow[]>([]);
const resolution = ref<any>(null);
const loadedCandidates = ref<any[]>([]);
const form = reactive({
  environment: "production",
  selectionMode: "healthy_priority" as "fixed_primary" | "healthy_priority",
  primaryInstanceId: "",
  status: "draft" as "draft" | "verified" | "active" | "blocked",
});

const environments = computed(() =>
  Array.from(new Set(instances.value.map((item) => item.environment))).sort(),
);
const selectedCandidates = computed(() => candidateRows.value.filter((item) => item.selected));

const load = async () => {
  if (!props.runtimeMembershipId || !props.sourceServiceAssetId) return;
  loading.value = true;
  resolution.value = null;
  revision.value = null;
  loadedCandidates.value = [];
  try {
    const instanceResult = await serverAPI.listSourceServiceInstances(
      props.sourceServiceAssetId,
      { includeArchived: true },
    );
    instances.value = instanceResult?.data || [];
    try {
      const result = await serverAPI.getRuntimeUpstreamBinding(props.runtimeMembershipId);
      revision.value = result.binding.revision;
      form.environment = result.binding.environment;
      form.selectionMode = result.binding.selectionMode;
      form.primaryInstanceId = result.binding.primaryInstanceId || "";
      form.status = result.binding.status;
      loadedCandidates.value = result.candidates || [];
    } catch (error: any) {
      if (error?.response?.status !== 404) throw error;
      form.environment = environments.value.includes("production")
        ? "production"
        : environments.value[0] || "production";
      form.selectionMode = "healthy_priority";
      form.primaryInstanceId = "";
      form.status = "draft";
    }
    rebuildCandidates();
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || t("endpointRegistry.runtimeUpstreamBinding.messages.loadFailed"));
  } finally {
    loading.value = false;
  }
};

const rebuildCandidates = () => {
  const configByInstance = new Map(
    loadedCandidates.value.map((item) => [item.sourceServiceInstanceId, item]),
  );
  candidateRows.value = instances.value
    .filter((item) => item.environment === form.environment)
    .map((item, index) => {
      const config = configByInstance.get(item.id);
      return {
        ...item,
        selected: Boolean(config?.enabled),
        priority: config?.priority ?? 100,
        order: config?.orderIndex ?? index,
        weight: config?.weight ?? 1,
      };
    });
  if (!candidateRows.value.some((item) => item.id === form.primaryInstanceId && item.selected)) {
    form.primaryInstanceId = "";
  }
  resolution.value = null;
};

const handleCandidateToggle = (row: CandidateRow) => {
  if (!row.selected && form.primaryInstanceId === row.id) form.primaryInstanceId = "";
  resolution.value = null;
};

const save = async () => {
  const environment = form.environment.trim().toLowerCase();
  const candidates = selectedCandidates.value;
  if (!environment) {
    ElMessage.warning(t("endpointRegistry.runtimeUpstreamBinding.messages.environmentRequired"));
    return;
  }
  if (candidates.length === 0) {
    ElMessage.warning(t("endpointRegistry.runtimeUpstreamBinding.messages.candidateRequired"));
    return;
  }
  if (form.selectionMode === "fixed_primary" && !form.primaryInstanceId) {
    ElMessage.warning(t("endpointRegistry.runtimeUpstreamBinding.messages.primaryRequired"));
    return;
  }
  saving.value = true;
  try {
    const result = await serverAPI.updateRuntimeUpstreamBinding(props.runtimeMembershipId, {
      sourceServiceAssetId: props.sourceServiceAssetId,
      environment,
      selectionMode: form.selectionMode,
      primaryInstanceId: form.selectionMode === "fixed_primary" ? form.primaryInstanceId : undefined,
      status: form.status,
      candidates: candidates.map((item) => ({
        sourceServiceInstanceId: item.id,
        priority: item.priority,
        order: item.order,
        weight: item.weight,
        enabled: true,
      })),
      expectedRevision: revision.value || undefined,
    });
    revision.value = result.binding.revision;
    loadedCandidates.value = result.candidates || [];
    rebuildCandidates();
    ElMessage.success(t("endpointRegistry.runtimeUpstreamBinding.messages.saveSuccess"));
    emit("saved");
    await resolveBinding();
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || t("endpointRegistry.runtimeUpstreamBinding.messages.saveFailed"));
  } finally {
    saving.value = false;
  }
};

const resolveBinding = async () => {
  if (!revision.value) return;
  resolving.value = true;
  try {
    resolution.value = await serverAPI.resolveRuntimeUpstreamBinding(props.runtimeMembershipId);
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || t("endpointRegistry.runtimeUpstreamBinding.messages.resolveFailed"));
  } finally {
    resolving.value = false;
  }
};

const removeBinding = async () => {
  await ElMessageBox.confirm(
    t("endpointRegistry.runtimeUpstreamBinding.messages.deleteConfirm"),
    t("endpointRegistry.runtimeUpstreamBinding.messages.deleteConfirmTitle"),
    {
      type: "warning",
    },
  );
  deleting.value = true;
  try {
    await serverAPI.deleteRuntimeUpstreamBinding(props.runtimeMembershipId);
    ElMessage.success(t("endpointRegistry.runtimeUpstreamBinding.messages.deleteSuccess"));
    emit("saved");
    emit("update:modelValue", false);
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || t("endpointRegistry.runtimeUpstreamBinding.messages.deleteFailed"));
  } finally {
    deleting.value = false;
  }
};

const buildBaseUrl = (instance: SourceServiceInstance) => {
  const defaultPort =
    (instance.scheme === "http" && instance.port === 80) ||
    (instance.scheme === "https" && instance.port === 443);
  const authority = `${instance.scheme}://${instance.host}${defaultPort ? "" : `:${instance.port}`}`;
  return instance.basePath === "/" ? authority : `${authority}${instance.basePath}`;
};

const statusTagType = (status: string) => {
  if (status === "healthy") return "success";
  if (status === "unhealthy") return "danger";
  if (status === "offline") return "info";
  return "warning";
};

const reasonLabel = (reason: string) => {
  const keys: Record<string, string> = {
    resolved: "endpointRegistry.runtimeUpstreamBinding.resolution.resolved",
    binding_not_active: "endpointRegistry.runtimeUpstreamBinding.resolution.reasons.bindingNotActive",
    fixed_primary_unavailable: "endpointRegistry.runtimeUpstreamBinding.resolution.reasons.fixedPrimaryUnavailable",
    no_healthy_candidate: "endpointRegistry.runtimeUpstreamBinding.resolution.reasons.noHealthyCandidate",
  };
  const key = keys[reason];
  if (key) return t(key);
  return reason || t("endpointRegistry.runtimeUpstreamBinding.resolution.notResolved");
};
</script>

<style scoped>
.binding-dialog-body {
  min-height: 320px;
}

.binding-hint {
  margin-bottom: 16px;
}

.candidate-header,
.resolution-title,
.binding-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.candidate-header {
  margin: 4px 0 10px;
}

.candidate-note {
  margin-left: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.resolution-panel {
  margin-top: 16px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.resolution-value {
  margin-top: 8px;
  color: var(--el-text-color-regular);
}

.footer-spacer {
  flex: 1;
}
</style>
