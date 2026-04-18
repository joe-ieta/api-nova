import { ref } from "vue";

export type OperationTimelineLevel = "success" | "warning" | "error" | "info";

export type OperationTimelineEntry = {
  id: string;
  level: OperationTimelineLevel;
  title: string;
  summary: string;
  details?: string;
  timestamp: string;
};

type NewOperationTimelineEntry = Omit<OperationTimelineEntry, "id" | "timestamp"> & {
  timestamp?: string;
};

export const useOperationTimeline = (maxEntries = 20) => {
  const entries = ref<OperationTimelineEntry[]>([]);
  const visible = ref(true);
  const expanded = ref(false);

  const addEntry = (entry: NewOperationTimelineEntry) => {
    entries.value.unshift({
      ...entry,
      id: `operation-timeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
    entries.value = entries.value.slice(0, maxEntries);
    visible.value = true;
  };

  const clearEntries = () => {
    entries.value = [];
  };

  return {
    entries,
    visible,
    expanded,
    addEntry,
    clearEntries,
  };
};
