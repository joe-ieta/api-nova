<template>
  <el-dialog
    :model-value="modelValue"
    :title="`测试样本 · ${endpointName || endpointDefinitionId}`"
    width="1080px"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
    @open="loadSamples"
  >
    <el-alert
      title="每次成功测试都会自动保存独立样本。启用的样本将参与后续部署自动复测。"
      type="info"
      show-icon
      :closable="false"
      class="sample-hint"
    />

    <div class="sample-toolbar">
      <el-radio-group v-model="statusFilter" size="small" @change="reloadFromFirstPage">
        <el-radio-button value="active">有效样本</el-radio-button>
        <el-radio-button value="archived">已归档</el-radio-button>
        <el-radio-button value="all">全部</el-radio-button>
      </el-radio-group>
      <el-button :loading="loading" @click="loadSamples">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="samples" border size="small">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="sample-detail-grid">
            <section>
              <h4>请求 Payload</h4>
              <pre>{{ formatJson(row.requestPayload) }}</pre>
            </section>
            <section>
              <h4>响应 Payload</h4>
              <pre>{{ formatJson(row.responsePayload) }}</pre>
            </section>
            <section>
              <h4>请求 Headers</h4>
              <pre>{{ formatJson(row.requestHeaders) }}</pre>
            </section>
            <section>
              <h4>响应 Headers</h4>
              <pre>{{ formatJson(row.responseHeaders) }}</pre>
            </section>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="名称" min-width="150">
        <template #default="{ row }">{{ row.title || "自动样本" }}</template>
      </el-table-column>
      <el-table-column label="响应" width="90">
        <template #default="{ row }">
          <el-tag :type="row.responseStatusCode < 400 ? 'success' : 'danger'">
            {{ row.responseStatusCode }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="durationMs" label="耗时" width="90">
        <template #default="{ row }">{{ row.durationMs ?? "-" }} ms</template>
      </el-table-column>
      <el-table-column prop="fingerprint" label="指纹" min-width="140">
        <template #default="{ row }">
          <el-tooltip :content="row.fingerprint" placement="top">
            <code>{{ row.fingerprint.slice(0, 12) }}</code>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column prop="capturedAt" label="采集时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.capturedAt) }}</template>
      </el-table-column>
      <el-table-column label="参与自动复测" width="130" align="center">
        <template #default="{ row }">
          <el-switch
            v-model="row.enabled"
            :disabled="row.status === 'archived'"
            :loading="actionId === row.id"
            @change="updateEnabled(row)"
          />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="210" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">维护</el-button>
          <el-button
            v-if="row.status !== 'archived'"
            size="small"
            type="warning"
            plain
            @click="archive(row)"
          >
            归档
          </el-button>
          <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && samples.length === 0" description="暂无测试样本" />
    <div v-if="total > limit" class="sample-pagination">
      <el-pagination
        v-model:current-page="page"
        :page-size="limit"
        :total="total"
        layout="prev, pager, next, total"
        @current-change="loadSamples"
      />
    </div>

    <el-dialog v-model="showEditor" title="维护测试样本" width="600px" append-to-body>
      <el-form label-width="90px">
        <el-form-item label="名称">
          <el-input v-model="editForm.title" maxlength="255" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.note" type="textarea" :rows="4" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="editForm.tags" placeholder="多个标签以逗号分隔" />
        </el-form-item>
        <el-form-item label="自动复测">
          <el-switch v-model="editForm.enabled" />
          <span class="switch-note">启用后纳入部署自动复测候选集</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditor = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { serverAPI } from "@/services/api";

type EndpointTestSample = {
  id: string;
  title?: string;
  note?: string;
  enabled: boolean;
  status: "active" | "archived";
  fingerprint: string;
  requestHeaders?: Record<string, unknown>;
  requestPayload?: unknown;
  responseStatusCode: number;
  responseHeaders?: Record<string, unknown>;
  responsePayload?: unknown;
  durationMs?: number;
  tags?: string[];
  capturedAt: string;
};

const props = defineProps<{
  modelValue: boolean;
  endpointDefinitionId: string;
  endpointName?: string;
}>();
const emit = defineEmits<{ (event: "update:modelValue", value: boolean): void }>();

const loading = ref(false);
const saving = ref(false);
const actionId = ref("");
const statusFilter = ref<"active" | "archived" | "all">("active");
const samples = ref<EndpointTestSample[]>([]);
const page = ref(1);
const limit = 20;
const total = ref(0);
const showEditor = ref(false);
const editingId = ref("");
const editForm = reactive({ title: "", note: "", tags: "", enabled: true });

const loadSamples = async () => {
  if (!props.endpointDefinitionId) return;
  loading.value = true;
  try {
    const result = await serverAPI.listEndpointTestSamples(props.endpointDefinitionId, {
      status: statusFilter.value === "all" ? undefined : statusFilter.value,
      page: page.value,
      limit,
    });
    samples.value = result?.data || [];
    total.value = Number(result?.total || 0);
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || "测试样本加载失败");
  } finally {
    loading.value = false;
  }
};

const reloadFromFirstPage = () => {
  page.value = 1;
  loadSamples();
};

const updateEnabled = async (sample: EndpointTestSample) => {
  actionId.value = sample.id;
  try {
    await serverAPI.updateEndpointTestSample(sample.id, { enabled: sample.enabled });
    ElMessage.success(sample.enabled ? "已加入自动复测" : "已移出自动复测");
  } catch (error: any) {
    sample.enabled = !sample.enabled;
    ElMessage.error(error?.response?.data?.message || error?.message || "样本状态更新失败");
  } finally {
    actionId.value = "";
  }
};

const openEdit = (sample: EndpointTestSample) => {
  editingId.value = sample.id;
  Object.assign(editForm, {
    title: sample.title || "",
    note: sample.note || "",
    tags: (sample.tags || []).join(", "),
    enabled: sample.enabled,
  });
  showEditor.value = true;
};

const saveEdit = async () => {
  saving.value = true;
  try {
    await serverAPI.updateEndpointTestSample(editingId.value, {
      title: editForm.title.trim() || undefined,
      note: editForm.note.trim() || undefined,
      tags: editForm.tags.split(",").map((item) => item.trim()).filter(Boolean),
      enabled: editForm.enabled,
    });
    showEditor.value = false;
    ElMessage.success("测试样本已更新");
    await loadSamples();
  } finally {
    saving.value = false;
  }
};

const archive = async (sample: EndpointTestSample) => {
  await ElMessageBox.confirm("归档后样本将自动退出部署复测，是否继续？", "归档样本", {
    type: "warning",
  });
  await serverAPI.archiveEndpointTestSample(sample.id);
  ElMessage.success("测试样本已归档");
  await loadSamples();
};

const remove = async (sample: EndpointTestSample) => {
  await ElMessageBox.confirm("删除后无法恢复，是否继续？", "删除样本", { type: "warning" });
  await serverAPI.deleteEndpointTestSample(sample.id);
  ElMessage.success("测试样本已删除");
  await loadSamples();
};

const formatJson = (value: unknown) => JSON.stringify(value ?? null, null, 2);
const formatTime = (value: string) => (value ? new Date(value).toLocaleString() : "-");
</script>

<style scoped>
.sample-hint,
.sample-toolbar {
  margin-bottom: 14px;
}

.sample-toolbar {
  display: flex;
  justify-content: space-between;
}

.sample-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 8px 20px;
}

.sample-detail-grid h4 {
  margin: 0 0 6px;
}

.sample-detail-grid pre {
  max-height: 260px;
  margin: 0;
  padding: 10px;
  overflow: auto;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  white-space: pre-wrap;
  word-break: break-all;
}

.sample-pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.switch-note {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
