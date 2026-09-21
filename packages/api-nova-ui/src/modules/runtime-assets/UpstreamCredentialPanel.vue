<template>
  <el-card shadow="never" class="upstream-credential-panel">
    <template #header>{{ t('monitoring.upstreamCredentials.title') }}</template>
    <p>{{ t('monitoring.upstreamCredentials.scope') }}</p>
    <el-descriptions v-if="state.status" :column="1" border>
      <el-descriptions-item :label="t('monitoring.upstreamCredentials.state')">{{ state.status.state }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.upstreamCredentials.generation')">{{ state.status.generation }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.upstreamCredentials.revision')">{{ state.status.revision ?? '—' }}</el-descriptions-item>
      <el-descriptions-item :label="t('monitoring.upstreamCredentials.environment')">{{ state.status.environment ?? '—' }}</el-descriptions-item>
    </el-descriptions>
    <el-alert v-if="state.status && !state.status.configured" :title="t('monitoring.upstreamCredentials.disabled')" type="info" :closable="false" />
    <el-alert v-if="state.needsRefresh && state.status" :title="t('monitoring.upstreamCredentials.stale')" type="warning" :closable="false" />
    <el-alert v-if="state.status?.lastReloadError" :title="t('monitoring.upstreamCredentials.previousError')" type="warning" :closable="false" />
    <el-alert v-if="state.error" :title="t('monitoring.upstreamCredentials.' + state.error)" type="error" :closable="false" />
    <el-alert v-if="state.reloaded" :title="t('monitoring.upstreamCredentials.success')" type="success" :closable="false" />
    <el-form label-position="top"><el-form-item :label="t('monitoring.upstreamCredentials.reasonLabel')">
      <el-input v-model="state.reason" maxlength="500" show-word-limit :disabled="state.busy" />
    </el-form-item></el-form>
    <el-button :loading="state.busy" @click="panel.refresh()">{{ t('monitoring.upstreamCredentials.refresh') }}</el-button>
    <el-button type="primary" :disabled="!panel.canReload()" @click="panel.reload()">{{ t('monitoring.upstreamCredentials.reload') }}</el-button>
  </el-card>
</template>
<script setup lang="ts">
import { reactive, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { UpstreamCredentialPanel, upstreamCredentialState } from '@/services/upstream-credentials';
const { t } = useI18n(), auth = useAuthStore(), state = reactive(upstreamCredentialState());
const panel = new UpstreamCredentialPanel(state, () => auth.accessToken && auth.currentUser?.id ?
  { key: auth.currentUser.id + ':' + auth.accessToken, token: auth.accessToken } : null);
watch([() => auth.accessToken, () => auth.currentUser?.id], () => panel.close(), { flush: 'sync' });
onBeforeUnmount(() => panel.close());
</script>
<style scoped>
.upstream-credential-panel { margin-top: 16px; }
.el-alert, .el-form { margin-top: 12px; }
</style>
