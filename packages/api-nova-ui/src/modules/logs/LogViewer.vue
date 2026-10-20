<template>
  <div class="log-viewer">
    <div class="log-header">
      <h2>{{ t("logs.title") }}</h2>
      <div class="log-controls">
        <el-input
          v-model="searchText"
          :placeholder="t('logs.searchPlaceholder')"
          style="width: 200px"
          clearable
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <el-select
          v-model="selectedLevel"
          @change="readPage(1)"
          :placeholder="t('logs.logLevel')"
          style="width: 120px"
        >
          <el-option :label="t('common.all')" value="all" />
          <el-option :label="t('logs.debug')" value="debug" />
          <el-option :label="t('logs.info')" value="info" />
          <el-option :label="t('logs.warn')" value="warn" />
          <el-option :label="t('logs.error')" value="error" />
          <el-option :label="t('logs.fatal')" value="fatal" />
        </el-select>

        <el-select
          v-model="selectedSource"
          :placeholder="t('logs.source')"
          style="width: 150px"
          clearable
        >
          <el-option :label="t('common.all')" value="all" />
          <el-option
            v-for="source in availableSources"
            :key="source"
            :label="source"
            :value="source"
          />
        </el-select>

        <el-button type="danger" plain @click="clearLogs">
          <el-icon><Delete /></el-icon>
          {{ t("logs.clearDisplay") }}
        </el-button>
        <el-button type="primary" plain :loading="state.loading" @click="readPage(state.page)">
          <el-icon><Refresh /></el-icon>
          {{ t("logs.refresh") }}
        </el-button>
      </div>
    </div>

    <p>{{ t("logs.scope") }}</p>
    <el-alert v-if="state.error" :title="t(`logs.failures.${state.error}`)" type="error" :closable="false" />
    <div class="log-content" v-loading="state.loading">
      <div v-if="!state.error && !state.loading && filteredLogs.length === 0" class="empty-logs">
        <el-empty :description="t('logs.noLogs')" />
      </div>
      <div v-else-if="!state.error" class="log-list">
        <LogEntry
          v-for="log in filteredLogs"
          :key="log.id"
          :log="log"
          :search-text="searchText"
          @search-related="handleSearchRelated"
        />
      </div>
    </div>
    <div class="log-pagination">
      <el-button :disabled="state.loading || !state.hasPrev" @click="readPage(state.page - 1)">{{ t("logs.previous") }}</el-button>
      <span>{{ t("logs.pageSummary", { page: state.page, total: state.total }) }}</span>
      <el-button :disabled="state.loading || !state.hasNext" @click="readPage(state.page + 1)">{{ t("logs.next") }}</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Delete, Refresh, Search } from "@element-plus/icons-vue";
import LogEntry from "./components/LogEntry.vue";
import type { LogEntry as LogEntryType } from "@/stores/log";

import { useAuthStore } from "@/stores/auth";
import { RuntimeLogPager, runtimeLogState } from "@/services/runtime-logs";
const { t } = useI18n();
const auth = useAuthStore();
const state = reactive(runtimeLogState());
const pager = new RuntimeLogPager(state, () => auth.accessToken);
const rawLogs = computed(() => state.items);

const selectedLevel = ref("all");
const selectedSource = ref("all");
const searchText = ref("");

const availableSources = computed(() => {
  const sources = new Set(rawLogs.value.map((log) => log.source));
  return Array.from(sources).sort();
});

const filteredLogs = computed(() => {
  let filtered = rawLogs.value;

  if (selectedLevel.value !== "all") {
    filtered = filtered.filter((log) => log.level === selectedLevel.value);
  }

  if (selectedSource.value && selectedSource.value !== "all") {
    filtered = filtered.filter((log) => log.source === selectedSource.value);
  }

  if (searchText.value.trim()) {
    const searchTerm = searchText.value.trim().toLowerCase();
    filtered = filtered.filter(
      (log) =>
        log.message.toLowerCase().includes(searchTerm) ||
        log.source.toLowerCase().includes(searchTerm) ||
        (log.tags &&
          log.tags.some((tag) => tag.toLowerCase().includes(searchTerm))),
    );
  }

  return [...filtered].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
});

const clearLogs = () => pager.reset();
const readPage = (page: number) => pager.read(page, selectedLevel.value);
const refresh = async () => {
  await readPage(state.page);
  if (state.error) throw new Error(t(`logs.failures.${state.error}`));
};
const handleSearchRelated = (log: LogEntryType) => {
  selectedSource.value = log.source;
  searchText.value = "";
};
watch(() => auth.accessToken, () => { pager.reset(); void readPage(1); }, { flush: "sync" });
onMounted(() => { void readPage(1); });
onBeforeUnmount(() => pager.reset());
defineExpose({ refresh });
</script>

<style scoped>
.log-pagination { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
.log-viewer {
  padding: 20px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 15px;
  border-bottom: 1px solid var(--el-border-color);
}

.log-header h2 {
  margin: 0;
  color: var(--el-text-color-primary);
}

.log-controls {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.log-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.empty-logs {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.log-list {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color);
}

@media (max-width: 768px) {
  .log-header {
    flex-direction: column;
    gap: 15px;
    align-items: flex-start;
  }

  .log-controls {
    width: 100%;
    justify-content: flex-start;
  }

  .log-controls > * {
    flex-shrink: 0;
  }
}

@media (max-width: 480px) {
  .log-viewer {
    padding: 10px;
  }

  .log-controls {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .log-controls .el-input,
  .log-controls .el-select {
    width: 100% !important;
  }
}
</style>
