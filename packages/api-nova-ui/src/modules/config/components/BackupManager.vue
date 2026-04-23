<template>
  <div class="config-transfer-panel" v-loading="loading">
    <el-alert
      :title="t('config.transfer.title')"
      :description="t('config.transfer.subtitle')"
      type="info"
      show-icon
      :closable="false"
    />

    <div class="transfer-grid">
      <el-card shadow="never">
        <template #header>{{ t("config.transfer.latestExport") }}</template>
        <div class="actions">
          <el-button type="primary" :loading="exporting" @click="handleExport">
            {{ t("config.transfer.export") }}
          </el-button>
          <el-button @click="openImportPicker">
            {{ t("config.transfer.import") }}
          </el-button>
          <el-button :disabled="!pendingImport" @click="handlePreviewImport">
            {{ t("config.transfer.preview") }}
          </el-button>
          <input
            ref="fileInput"
            class="hidden-input"
            type="file"
            accept=".json,application/json"
            @change="handleImportFile"
          />
        </div>

        <el-empty
          v-if="!latestExport"
          :description="t('config.transfer.importPlaceholder')"
        />
        <div v-else class="export-preview">
          <div class="preview-line">
            <span>{{ latestExport.formatVersion }}</span>
            <span>{{ latestExport.exportedAt }}</span>
          </div>
          <div class="preview-line">
            <span>{{ t("config.transfer.overrideCount") }}</span>
            <strong>{{ latestExport.overrideCount }}</strong>
          </div>
          <el-input
            :model-value="JSON.stringify(latestExport, null, 2)"
            type="textarea"
            :rows="10"
            readonly
          />
        </div>

        <el-card v-if="importPreview" shadow="never" class="preview-card">
          <template #header>{{ t("config.transfer.previewTitle") }}</template>
          <div class="preview-line">
            <span>{{ t("config.transfer.compatible") }}</span>
            <strong>{{ importPreview.compatible ? t("config.yes") : t("config.no") }}</strong>
          </div>
          <div class="preview-line">
            <span>{{ t("config.transfer.migrationRequired") }}</span>
            <strong>{{ importPreview.migrationRequired ? t("config.yes") : t("config.no") }}</strong>
          </div>
          <div class="preview-line">
            <span>{{ t("config.transfer.conflicts") }}</span>
            <strong>{{ importPreview.conflicts.length }}</strong>
          </div>
          <div class="preview-line">
            <span>{{ t("config.restartPlan") }}</span>
            <strong>
              {{ importPreview.restartPlan.length ? importPreview.restartPlan.join(", ") : t("config.restartPlanNone") }}
            </strong>
          </div>
          <el-empty
            v-if="!importPreview.conflicts.length"
            :description="t('config.transfer.noConflicts')"
          />
          <el-table v-else :data="importPreview.conflicts" size="small" stripe>
            <el-table-column prop="key" :label="t('config.field')" min-width="180" />
            <el-table-column prop="kind" :label="t('config.transfer.conflicts')" width="120">
              <template #default="{ row }">
                {{
                  row.kind === "add"
                    ? t("config.transfer.kindAdd")
                    : row.kind === "remove"
                      ? t("config.transfer.kindRemove")
                      : t("config.transfer.kindChange")
                }}
              </template>
            </el-table-column>
            <el-table-column prop="currentValue" :label="t('config.value')" min-width="160" />
            <el-table-column prop="incomingValue" :label="t('config.newValue')" min-width="160" />
          </el-table>
          <div class="actions preview-actions">
            <el-button type="primary" :disabled="!importPreview.compatible" @click="applyPendingImport">
              {{ t("config.transfer.applyImport") }}
            </el-button>
          </div>
        </el-card>
      </el-card>

      <el-card shadow="never">
        <template #header>{{ t("config.transfer.createBackup") }}</template>
        <el-form label-position="top" class="backup-form">
          <el-form-item :label="t('config.transfer.backupName')">
            <el-input v-model="backupForm.name" clearable />
          </el-form-item>
          <el-form-item :label="t('config.transfer.backupDescription')">
            <el-input v-model="backupForm.description" type="textarea" :rows="4" />
          </el-form-item>
          <el-button type="primary" :loading="creatingBackup" @click="handleCreateBackup">
            {{ t("config.transfer.createBackup") }}
          </el-button>
        </el-form>

        <el-alert
          :title="t('config.transfer.restartHint')"
          type="warning"
          show-icon
          :closable="false"
          class="hint-alert"
        />
      </el-card>
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="table-header">
          <span>{{ t("config.transfer.backupList") }}</span>
          <el-button text @click="loadBackups">
            {{ t("config.transfer.refresh") }}
          </el-button>
        </div>
      </template>

      <el-empty v-if="!backups.length" :description="t('config.transfer.noBackups')" />
      <el-table v-else :data="backups" size="small" stripe>
        <el-table-column prop="name" :label="t('config.transfer.backupName')" min-width="180" />
        <el-table-column
          prop="description"
          :label="t('config.transfer.backupDescription')"
          min-width="220"
          show-overflow-tooltip
        />
        <el-table-column prop="overrideCount" :label="t('config.transfer.overrideCount')" width="140" />
        <el-table-column prop="createdAt" :label="t('config.transfer.createdAt')" min-width="180" />
        <el-table-column prop="updatedAt" :label="t('config.transfer.updatedAt')" min-width="180" />
        <el-table-column width="180">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link type="primary" @click="handleRestore(row.id)">
                {{ t("config.transfer.restore") }}
              </el-button>
              <el-button link type="danger" @click="handleDelete(row.id)">
                {{ t("config.transfer.delete") }}
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useI18n } from "vue-i18n";
import { configAPI } from "@/services/api";

interface ConfigExportSnapshot {
  formatVersion: string;
  exportedAt: string;
  overrides: Array<Record<string, unknown>>;
  overrideCount: number;
}

interface ConfigBackupSummary {
  id: string;
  name: string;
  description?: string;
  overrideCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ConfigImportPreview {
  formatVersion: string;
  compatible: boolean;
  migrationRequired: boolean;
  conflicts: Array<{
    key: string;
    currentValue?: string | number | boolean;
    incomingValue?: string | number | boolean;
    kind: "add" | "change" | "remove";
  }>;
  restartRequiredKeys: string[];
  restartPlan: string[];
}

const { t } = useI18n();

const loading = ref(false);
const exporting = ref(false);
const creatingBackup = ref(false);
const latestExport = ref<ConfigExportSnapshot | null>(null);
const backups = ref<ConfigBackupSummary[]>([]);
const pendingImport = ref<Record<string, unknown> | null>(null);
const importPreview = ref<ConfigImportPreview | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const backupForm = ref({
  name: "",
  description: "",
});

const downloadJson = (payload: unknown, fileName: string) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const loadBackups = async () => {
  backups.value = await configAPI.listConfigBackups();
};

const handleExport = async () => {
  exporting.value = true;
  try {
    const snapshot = await configAPI.exportConfigOverview();
    latestExport.value = snapshot;
    downloadJson(snapshot, `config-overrides-${Date.now()}.json`);
    ElMessage.success(t("config.transfer.exportSuccess"));
  } catch {
    ElMessage.error(t("config.transfer.exportFailed"));
  } finally {
    exporting.value = false;
  }
};

const openImportPicker = () => {
  fileInput.value?.click();
};

const handleImportFile = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload?.formatVersion || !Array.isArray(payload?.overrides)) {
      throw new Error("invalid");
    }
    pendingImport.value = payload;
    importPreview.value = null;
    ElMessage.success(t("config.transfer.preview"));
  } catch {
    ElMessage.error(t("config.transfer.invalidFile"));
  } finally {
    target.value = "";
  }
};

const handlePreviewImport = async () => {
  if (!pendingImport.value) return;

  try {
    importPreview.value = await configAPI.previewConfigImport(pendingImport.value);
  } catch {
    ElMessage.error(t("config.transfer.importFailed"));
  }
};

const applyPendingImport = async () => {
  if (!pendingImport.value) return;

  try {
    await configAPI.importConfigOverview(pendingImport.value);
    latestExport.value = pendingImport.value as unknown as ConfigExportSnapshot;
    await loadBackups();
    pendingImport.value = null;
    ElMessage.success(t("config.transfer.importSuccess"));
  } catch {
    ElMessage.error(t("config.transfer.importFailed"));
  }
};

const handleCreateBackup = async () => {
  creatingBackup.value = true;
  try {
    await configAPI.createConfigBackup({
      name: backupForm.value.name || undefined,
      description: backupForm.value.description || undefined,
    });
    backupForm.value = { name: "", description: "" };
    await loadBackups();
    ElMessage.success(t("config.transfer.backupCreated"));
  } catch {
    ElMessage.error(t("config.transfer.backupCreateFailed"));
  } finally {
    creatingBackup.value = false;
  }
};

const handleRestore = async (id: string) => {
  try {
    await ElMessageBox.confirm(
      t("config.transfer.restartHint"),
      t("config.transfer.restore"),
      { type: "warning" },
    );
    await configAPI.restoreConfigBackup(id);
    importPreview.value = null;
    await loadBackups();
    ElMessage.success(t("config.transfer.backupRestored"));
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(t("config.transfer.backupRestoreFailed"));
    }
  }
};

const handleDelete = async (id: string) => {
  try {
    await ElMessageBox.confirm(
      t("config.transfer.backupDescription"),
      t("config.transfer.delete"),
      { type: "warning" },
    );
    await configAPI.deleteConfigBackup(id);
    backups.value = backups.value.filter((item) => item.id !== id);
    ElMessage.success(t("config.transfer.backupDeleted"));
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(t("config.transfer.backupDeleteFailed"));
    }
  }
};

onMounted(async () => {
  loading.value = true;
  try {
    await loadBackups();
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.config-transfer-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.transfer-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.actions,
.row-actions,
.table-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.table-header {
  justify-content: space-between;
}

.backup-form {
  display: flex;
  flex-direction: column;
}

.hidden-input {
  display: none;
}

.export-preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.preview-card,
.preview-actions {
  margin-top: 16px;
}

.preview-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--el-text-color-regular);
  font-size: 13px;
}

.hint-alert {
  margin-top: 16px;
}

@media (max-width: 960px) {
  .transfer-grid {
    grid-template-columns: 1fr;
  }
}
</style>
