<template>
  <el-card v-loading="diagnostics.loading">
    <template #header>
      <div class="diagnostics-header">
        <span>{{ t("monitoring.diagnostics.title") }}</span>
        <el-button size="small" :disabled="diagnostics.loading" @click="diagnostics.load()">{{ t("common.refresh") }}</el-button>
      </div>
    </template>
    <el-alert v-if="diagnostics.errors.servers" type="warning" :closable="false" :title="t('monitoring.diagnostics.serverError')" />
    <el-alert v-if="diagnostics.errors.capabilities" type="warning" :closable="false" :title="t('monitoring.diagnostics.capabilityError')" />
    <el-alert v-if="diagnostics.errors.pipeline" type="warning" :closable="false" :title="t('monitoring.diagnostics.pipelineError')" />
    <p>{{ t("monitoring.diagnostics.readAt") }}: {{ date(diagnostics.readAt) }}</p>
    <h4>{{ t("monitoring.diagnostics.heartbeat") }}</h4>
    <p>{{ t("monitoring.diagnostics.heartbeatScope") }}</p>
    <el-descriptions :column="3" border>
      <el-descriptions-item :label="t('monitoring.diagnostics.state')">{{ state(diagnostics.heartbeat?.state) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.freshness')">{{ state(diagnostics.heartbeat?.freshness) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.observedAt')">{{ date(diagnostics.heartbeat?.observedAt) }}</el-descriptions-item>
    </el-descriptions>
    <h4>{{ t("monitoring.diagnostics.routes") }}</h4>
    <p>{{ t("monitoring.diagnostics.routeScope") }}</p>
    <el-table :data="diagnostics.routes" size="small" stripe :empty-text="t('monitoring.diagnostics.unknown')">
      <el-table-column prop="runtimeAssetId" :label="t('monitoring.callStream.asset')" min-width="160" />
      <el-table-column :label="t('monitoring.diagnostics.registration')">
        <template #default="{ row }">{{ state(row.evidence?.registration) }}</template>
      </el-table-column>
      <el-table-column :label="t('monitoring.diagnostics.routeCount')">
        <template #default="{ row }">{{ number(row.evidence?.routeCount) }}</template>
      </el-table-column>
      <el-table-column :label="t('monitoring.diagnostics.state')">
        <template #default="{ row }">{{ state(row.evidence?.state) }}</template>
      </el-table-column>
      <el-table-column :label="t('monitoring.diagnostics.freshness')">
        <template #default="{ row }">{{ state(row.evidence?.freshness) }}</template>
      </el-table-column>
      <el-table-column :label="t('monitoring.diagnostics.observedAt')" min-width="160">
        <template #default="{ row }">{{ date(row.evidence?.observedAt) }}</template>
      </el-table-column>
    </el-table>
    <h4>{{ t("monitoring.diagnostics.retention") }}</h4>
    <p>{{ t("monitoring.diagnostics.retentionScope") }}</p>
    <p>{{ t("monitoring.diagnostics.pipelineReadAt") }}: {{ date(diagnostics.pipelineReadAt) }}</p>
    <p v-if="diagnostics.pipelineRestricted">{{ t("monitoring.diagnostics.restricted") }}</p>
    <el-descriptions :column="2" border>
      <el-descriptions-item :label="t('monitoring.diagnostics.state')">{{ state(diagnostics.retention?.state) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.freshness')">{{ state(diagnostics.retention?.freshness) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.observedAt')">{{ date(diagnostics.retention?.observedAt) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.configured')">{{ bool(diagnostics.retention?.workerConfigured) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.complete')">{{ bool(diagnostics.retention?.currentAttemptComplete) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.attemptAt')">{{ date(diagnostics.retention?.lastAttemptAt) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.reportAt')">{{ date(diagnostics.retention?.lastReportAt) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.scanned')">{{ number(diagnostics.retention?.lastReport?.scanned) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.deleted')">{{ number(diagnostics.retention?.lastReport?.deleted) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.protected')">{{ number(diagnostics.retention?.lastReport?.protected) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.dangling')">{{ number(diagnostics.retention?.lastReport?.danglingReferences) }}</el-descriptions-item>
    </el-descriptions>
    <h4>{{ t("monitoring.diagnostics.scanSample") }}</h4>
    <p>{{ t("monitoring.diagnostics.scanScope") }}</p>
    <el-descriptions :column="3" border>
      <el-descriptions-item :label="t('monitoring.diagnostics.sampleBytes')">{{ number(diagnostics.retention?.scanUsage?.observedBytes) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.sampleFiles')">{{ number(diagnostics.retention?.scanUsage?.observedFiles) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.coverage')">{{ state(diagnostics.retention?.scanUsage?.coverage) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.freshness')">{{ state(diagnostics.retention?.scanUsage?.freshness) }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.diagnostics.scanAt')">{{ date(diagnostics.retention?.scanUsage?.completedAt) }}</el-descriptions-item>
    </el-descriptions>
  </el-card>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useObservabilityDiagnosticsStore } from "@/stores/observability-diagnostics";
const { t, locale } = useI18n();
const diagnostics = useObservabilityDiagnosticsStore();
const state = (value?: string) => t("monitoring.diagnostics.states." + (value || "unknown"));
const number = (value?: number | null) => value == null ? t("monitoring.diagnostics.unknown") : String(value);
const bool = (value?: boolean | null) => value == null ? t("monitoring.diagnostics.unknown") : t(value ? "common.yes" : "common.no");
const date = (value?: string | null) => value ? new Date(value).toLocaleString(locale.value) : t("monitoring.diagnostics.unknown");
onMounted(() => diagnostics.load());
onBeforeUnmount(() => diagnostics.deactivate());
</script>
<style scoped>
.diagnostics-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
</style>
