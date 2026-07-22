<template>
  <el-dialog
    :model-value="modelValue"
    :title="`运行上游绑定 · ${endpointName || runtimeMembershipId}`"
    width="980px"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
    @open="load"
  >
    <div v-loading="loading" class="binding-dialog-body">
      <el-alert
        title="发布成员必须显式绑定到某个环境的运行实例。运行时只解析健康且已启用的候选实例。"
        type="info"
        show-icon
        :closable="false"
        class="binding-hint"
      />

      <el-form label-width="110px">
        <el-row :gutter="16">
          <el-col :xs="24" :md="8">
            <el-form-item label="运行环境" required>
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
            <el-form-item label="选择策略" required>
              <el-select v-model="form.selectionMode" style="width: 100%">
                <el-option label="固定主实例" value="fixed_primary" />
                <el-option label="健康优先" value="healthy_priority" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="8">
            <el-form-item label="绑定状态" required>
              <el-select v-model="form.status" style="width: 100%">
                <el-option label="草稿" value="draft" />
                <el-option label="已验证" value="verified" />
                <el-option label="已激活" value="active" />
                <el-option label="已阻塞" value="blocked" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item v-if="form.selectionMode === 'fixed_primary'" label="主实例" required>
          <el-select v-model="form.primaryInstanceId" style="width: 100%" placeholder="选择固定主实例">
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
          <strong>候选实例</strong>
          <span class="candidate-note">同优先级时按顺序值、实例 ID 稳定选择</span>
        </div>
        <el-tag v-if="revision" type="info" effect="plain">修订 {{ revision }}</el-tag>
      </div>

      <el-table :data="candidateRows" border size="small">
        <el-table-column label="启用候选" width="100" align="center">
          <template #default="{ row }">
            <el-checkbox v-model="row.selected" @change="handleCandidateToggle(row)" />
          </template>
        </el-table-column>
        <el-table-column prop="name" label="实例" min-width="150" />
        <el-table-column label="运行地址" min-width="230">
          <template #default="{ row }">{{ buildBaseUrl(row) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="健康状态" width="105">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" effect="plain">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="优先级" width="125">
          <template #default="{ row }">
            <el-input-number v-model="row.priority" :min="0" :disabled="!row.selected" controls-position="right" />
          </template>
        </el-table-column>
        <el-table-column label="顺序" width="115">
          <template #default="{ row }">
            <el-input-number v-model="row.order" :min="0" :disabled="!row.selected" controls-position="right" />
          </template>
        </el-table-column>
        <el-table-column label="权重" width="115">
          <template #default="{ row }">
            <el-input-number v-model="row.weight" :min="1" :disabled="!row.selected" controls-position="right" />
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && candidateRows.length === 0" description="该环境尚未配置运行实例" />

      <div v-if="resolution" class="resolution-panel">
        <div class="resolution-title">
          <strong>当前解析结果</strong>
          <el-tag :type="resolution.resolved ? 'success' : 'warning'">
            {{ resolution.resolved ? "已解析" : reasonLabel(resolution.reason) }}
          </el-tag>
        </div>
        <div v-if="resolution.resolved && resolution.instance" class="resolution-value">
          {{ resolution.instance.name }} · {{ buildBaseUrl(resolution.instance) }} · 修订 {{ resolution.revision }}
        </div>
        <div v-else class="resolution-value">{{ reasonLabel(resolution.reason) }}</div>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer binding-footer">
        <el-button v-if="revision" type="danger" plain :loading="deleting" @click="removeBinding">
          删除绑定
        </el-button>
        <span class="footer-spacer" />
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button :disabled="!revision" :loading="resolving" @click="resolveBinding">解析验证</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存绑定</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
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
    ElMessage.error(error?.response?.data?.message || error?.message || "运行上游绑定加载失败");
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
    ElMessage.warning("请选择运行环境");
    return;
  }
  if (candidates.length === 0) {
    ElMessage.warning("至少选择一个候选实例");
    return;
  }
  if (form.selectionMode === "fixed_primary" && !form.primaryInstanceId) {
    ElMessage.warning("固定主实例策略必须指定主实例");
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
    ElMessage.success("运行上游绑定已保存");
    emit("saved");
    await resolveBinding();
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || "运行上游绑定保存失败");
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
    ElMessage.error(error?.response?.data?.message || error?.message || "上游解析失败");
  } finally {
    resolving.value = false;
  }
};

const removeBinding = async () => {
  await ElMessageBox.confirm("确认删除当前发布成员的运行上游绑定？", "删除绑定", {
    type: "warning",
  });
  deleting.value = true;
  try {
    await serverAPI.deleteRuntimeUpstreamBinding(props.runtimeMembershipId);
    ElMessage.success("运行上游绑定已删除");
    emit("saved");
    emit("update:modelValue", false);
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || "运行上游绑定删除失败");
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
  const labels: Record<string, string> = {
    resolved: "已解析",
    binding_not_active: "绑定尚未激活",
    fixed_primary_unavailable: "固定主实例当前不可用",
    no_healthy_candidate: "没有健康且启用的候选实例",
  };
  return labels[reason] || reason || "尚未解析";
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
