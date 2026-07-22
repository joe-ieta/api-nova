<template>
  <el-dialog
    :model-value="modelValue"
    :title="`运行实例 · ${sourceServiceName || sourceServiceAssetId}`"
    width="980px"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
    @open="loadInstances"
  >
    <div class="instance-toolbar">
      <div class="instance-hint">
        测试和发布只使用这里配置的运行地址，不再使用导入文档中的固定主机。
      </div>
      <el-button type="primary" @click="openCreate">新增实例</el-button>
    </div>

    <el-table v-loading="loading" :data="instances" border size="small">
      <el-table-column prop="name" label="实例名称" min-width="150" />
      <el-table-column prop="environment" label="环境" width="110" />
      <el-table-column label="运行地址" min-width="240">
        <template #default="{ row }">{{ buildBaseUrl(row) }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="默认" width="80" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.isDefault" type="success">默认</el-tag>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="300" fixed="right">
        <template #default="{ row }">
          <div class="instance-actions">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" :loading="actionId === row.id" @click="probe(row)">
              探测
            </el-button>
            <el-button
              size="small"
              type="success"
              :disabled="row.isDefault || !row.enabled"
              :loading="actionId === row.id"
              @click="setDefault(row)"
            >
              设为默认
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :loading="actionId === row.id"
              @click="archive(row)"
            >
              归档
            </el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && instances.length === 0" description="尚未配置运行实例" />

    <el-dialog
      v-model="showEditor"
      :title="editingId ? '编辑运行实例' : '新增运行实例'"
      width="620px"
      append-to-body
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="实例名称" prop="name">
              <el-input v-model="form.name" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="环境" prop="environment">
              <el-input v-model="form.environment" placeholder="production" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="协议" prop="scheme">
              <el-select v-model="form.scheme" style="width: 100%">
                <el-option label="HTTP" value="http" />
                <el-option label="HTTPS" value="https" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="10">
            <el-form-item label="主机" prop="host">
              <el-input v-model="form.host" placeholder="api.internal" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="端口" prop="port">
              <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="16">
            <el-form-item label="基础路径" prop="basePath">
              <el-input v-model="form.basePath" placeholder="/api" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="上游凭据" prop="credentialRef">
              <el-input
                v-model="form.credentialRef"
                placeholder="env-headers:Authorization=UPSTREAM_API_TOKEN"
                clearable
              />
              <div class="credential-hint">
                仅保存请求头到环境变量的映射，不保存密文；多个映射使用分号分隔。
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="优先级" prop="priority">
              <el-input-number v-model="form.priority" :min="0" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="启用">
              <el-switch v-model="form.enabled" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="设为默认">
              <el-switch v-model="form.isDefault" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="showEditor = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import type { FormInstance, FormRules } from "element-plus";
import { ElMessage, ElMessageBox } from "element-plus";
import { serverAPI } from "@/services/api";

type SourceServiceInstance = {
  id: string;
  name: string;
  environment: string;
  scheme: "http" | "https";
  host: string;
  port: number;
  basePath: string;
  status: string;
  enabled: boolean;
  priority: number;
  isDefault: boolean;
  credentialRef?: string;
};

const props = defineProps<{
  modelValue: boolean;
  sourceServiceAssetId: string;
  sourceServiceName?: string;
}>();
const emit = defineEmits<{ (event: "update:modelValue", value: boolean): void }>();

const loading = ref(false);
const saving = ref(false);
const actionId = ref("");
const instances = ref<SourceServiceInstance[]>([]);
const showEditor = ref(false);
const editingId = ref("");
const formRef = ref<FormInstance>();
const form = reactive({
  name: "",
  environment: "production",
  scheme: "https" as "http" | "https",
  host: "",
  port: 443,
  basePath: "/",
  credentialRef: "",
  enabled: true,
  priority: 100,
  isDefault: false,
});

const rules: FormRules = {
  name: [{ required: true, message: "请输入实例名称", trigger: "blur" }],
  environment: [
    { required: true, message: "请输入环境", trigger: "blur" },
    { pattern: /^[a-z][a-z0-9_-]{0,99}$/, message: "环境只能使用小写字母、数字、下划线和短横线", trigger: "blur" },
  ],
  scheme: [{ required: true, message: "请选择协议", trigger: "change" }],
  host: [{ required: true, message: "请输入主机", trigger: "blur" }],
  port: [{ required: true, message: "请输入端口", trigger: "change" }],
  basePath: [{ required: true, message: "请输入基础路径", trigger: "blur" }],
  credentialRef: [{
    validator: (_rule, value, callback) => {
      if (!value || /^env-headers:[^=;]+=[A-Z_][A-Z0-9_]*(;[^=;]+=[A-Z_][A-Z0-9_]*)*$/.test(value)) callback();
      else callback(new Error("凭据引用格式应为 env-headers:请求头=环境变量"));
    },
    trigger: "blur",
  }],
};

const resetForm = () => {
  Object.assign(form, {
    name: "",
    environment: "production",
    scheme: "https",
    host: "",
    port: 443,
    basePath: "/",
    credentialRef: "",
    enabled: true,
    priority: 100,
    isDefault: false,
  });
};

const loadInstances = async () => {
  if (!props.sourceServiceAssetId) return;
  loading.value = true;
  try {
    const result = await serverAPI.listSourceServiceInstances(props.sourceServiceAssetId);
    instances.value = result?.data || [];
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || "运行实例加载失败");
  } finally {
    loading.value = false;
  }
};

const openCreate = () => {
  editingId.value = "";
  resetForm();
  showEditor.value = true;
};

const openEdit = (instance: SourceServiceInstance) => {
  editingId.value = instance.id;
  Object.assign(form, {
    name: instance.name,
    environment: instance.environment,
    scheme: instance.scheme,
    host: instance.host,
    port: instance.port,
    basePath: instance.basePath,
    credentialRef: instance.credentialRef || "",
    enabled: instance.enabled,
    priority: instance.priority,
    isDefault: instance.isDefault,
  });
  showEditor.value = true;
};

const save = async () => {
  const valid = await formRef.value?.validate().catch(() => false);
  if (valid === false) return;
  saving.value = true;
  try {
    const payload: Record<string, unknown> = {
      ...form,
      credentialRef: form.credentialRef.trim() || null,
    };
    if (editingId.value) {
      await serverAPI.updateSourceServiceInstance(
        props.sourceServiceAssetId,
        editingId.value,
        payload,
      );
    } else {
      await serverAPI.createSourceServiceInstance(props.sourceServiceAssetId, payload);
    }
    showEditor.value = false;
    ElMessage.success("运行实例已保存");
    await loadInstances();
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || "运行实例保存失败");
  } finally {
    saving.value = false;
  }
};

const probe = async (instance: SourceServiceInstance) => {
  actionId.value = instance.id;
  try {
    const result = await serverAPI.probeSourceServiceInstance(
      props.sourceServiceAssetId,
      instance.id,
    );
    ElMessage.success(`探测完成：${result?.probe?.status || "unknown"}`);
    await loadInstances();
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || "实例探测失败");
  } finally {
    actionId.value = "";
  }
};

const setDefault = async (instance: SourceServiceInstance) => {
  actionId.value = instance.id;
  try {
    await serverAPI.setDefaultSourceServiceInstance(props.sourceServiceAssetId, instance.id);
    ElMessage.success("默认实例已更新");
    await loadInstances();
  } finally {
    actionId.value = "";
  }
};

const archive = async (instance: SourceServiceInstance) => {
  await ElMessageBox.confirm(`确认归档运行实例“${instance.name}”？`, "归档实例", {
    type: "warning",
  });
  actionId.value = instance.id;
  try {
    await serverAPI.archiveSourceServiceInstance(props.sourceServiceAssetId, instance.id);
    ElMessage.success("运行实例已归档");
    await loadInstances();
  } finally {
    actionId.value = "";
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
</script>

<style scoped>
.instance-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.instance-hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.instance-actions {
  display: flex;
  gap: 6px;
  white-space: nowrap;
}

.credential-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 18px;
  margin-top: 4px;
}
</style>
