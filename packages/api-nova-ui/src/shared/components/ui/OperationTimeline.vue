<template>
  <el-card
    v-if="visible && entries.length"
    shadow="never"
    class="operation-timeline mb-12"
  >
    <template #header>
      <div class="operation-timeline-header">
        <div class="operation-timeline-title-group">
          <span class="operation-timeline-title">{{ title }}</span>
          <span v-if="subtitle" class="operation-timeline-subtitle">
            {{ subtitle }}
          </span>
        </div>
        <div class="operation-timeline-actions">
          <el-button
            v-if="entries.length > 1"
            text
            size="small"
            @click="$emit('update:expanded', !expanded)"
          >
            {{ expanded ? mergedLabels.showLatest : mergedLabels.showAll }}
          </el-button>
          <el-button text size="small" @click="$emit('clear')">
            {{ mergedLabels.clear }}
          </el-button>
          <el-button text size="small" @click="$emit('update:visible', false)">
            {{ mergedLabels.hide }}
          </el-button>
        </div>
      </div>
    </template>

    <div v-if="entries.length === 0" class="empty-history">
      <el-empty :description="mergedLabels.empty" />
    </div>

    <el-timeline v-else class="operation-timeline-list">
      <el-timeline-item
        v-for="entry in visibleEntries"
        :key="entry.id"
        :type="getTimelineType(entry.level)"
        :timestamp="formatTime(entry.timestamp)"
      >
        <div class="history-item">
          <div class="history-item-header">
            <h4>{{ entry.title }}</h4>
            <el-tag :type="getTagType(entry.level)" size="small" effect="light">
              {{ mergedLabels.levels[entry.level] }}
            </el-tag>
          </div>
          <p>{{ entry.summary }}</p>
          <el-button
            v-if="entry.details"
            link
            type="primary"
            size="small"
            @click="toggleDetails(entry.id)"
          >
            {{
              expandedDetails[entry.id]
                ? mergedLabels.hideDetails
                : mergedLabels.showDetails
            }}
          </el-button>
          <div
            v-if="entry.details && expandedDetails[entry.id]"
            class="history-details"
          >
            {{ entry.details }}
          </div>
        </div>
      </el-timeline-item>
    </el-timeline>
  </el-card>
  <el-button
    v-else-if="!visible && entries.length"
    text
    class="operation-timeline-restore mb-12"
    @click="$emit('update:visible', true)"
  >
    {{ mergedLabels.restore }}
  </el-button>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";
import type {
  OperationTimelineEntry,
  OperationTimelineLevel,
} from "@/composables/useOperationTimeline";

type TimelineLabels = {
  clear: string;
  hide: string;
  restore: string;
  showAll: string;
  showLatest: string;
  showDetails: string;
  hideDetails: string;
  empty: string;
  levels: Record<OperationTimelineLevel, string>;
};

const props = withDefaults(
  defineProps<{
    entries: OperationTimelineEntry[];
    visible: boolean;
    expanded: boolean;
    title: string;
    subtitle?: string;
    labels?: Partial<TimelineLabels>;
  }>(),
  {
    subtitle: "",
  },
);

defineEmits<{
  (e: "update:visible", value: boolean): void;
  (e: "update:expanded", value: boolean): void;
  (e: "clear"): void;
}>();

const expandedDetails = reactive<Record<string, boolean>>({});

const mergedLabels = computed<TimelineLabels>(() => ({
  clear: props.labels?.clear || "Clear",
  hide: props.labels?.hide || "Hide",
  restore: props.labels?.restore || "Show operation timeline",
  showAll: props.labels?.showAll || "Show all",
  showLatest: props.labels?.showLatest || "Show latest",
  showDetails: props.labels?.showDetails || "View details",
  hideDetails: props.labels?.hideDetails || "Hide details",
  empty: props.labels?.empty || "No operation records",
  levels: {
    success: props.labels?.levels?.success || "Success",
    warning: props.labels?.levels?.warning || "Warning",
    error: props.labels?.levels?.error || "Error",
    info: props.labels?.levels?.info || "Info",
  },
}));

const visibleEntries = computed(() =>
  props.expanded ? props.entries.slice(0, 5) : props.entries.slice(0, 1),
);

const toggleDetails = (entryId: string) => {
  expandedDetails[entryId] = !expandedDetails[entryId];
};

const getTagType = (level: OperationTimelineLevel) => {
  if (level === "success") return "success";
  if (level === "warning") return "warning";
  if (level === "error") return "danger";
  return "info";
};

const getTimelineType = (level: OperationTimelineLevel) => {
  if (level === "success") return "success";
  if (level === "warning") return "warning";
  if (level === "error") return "danger";
  return "primary";
};

const formatTime = (timestamp: string) => {
  if (!timestamp) return "-";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return parsed.toLocaleString();
};
</script>

<style scoped>
.mb-12 {
  margin-bottom: 12px;
}

.operation-timeline {
  position: sticky;
  top: 12px;
  z-index: 5;
}

.operation-timeline-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.operation-timeline-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.operation-timeline-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.operation-timeline-subtitle {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.operation-timeline-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.operation-timeline-list {
  margin-top: 4px;
}

.empty-history {
  text-align: center;
  padding: 20px 0 8px;
}

.history-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.history-item h4 {
  margin: 0 0 8px 0;
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 600;
}

.history-item p {
  margin: 0 0 6px 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.history-details {
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.operation-timeline-restore {
  padding-left: 0;
}
</style>
