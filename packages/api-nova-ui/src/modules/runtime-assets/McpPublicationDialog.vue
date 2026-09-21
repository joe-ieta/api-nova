<template>
  <el-dialog :model-value="state.visible" :title="t('monitoring.mcpPublication.title')" width="560px" :close-on-click-modal="false" @close="form.close()">
    <el-form label-position="top" :disabled="state.loading || state.saving">
      <el-form-item :label="t('monitoring.mcpPublication.draftAuthMode')">
        <el-select v-model="state.inboundAuthMode" :placeholder="t('monitoring.mcpPublication.authRequiredError')">
          <el-option v-for="mode in ['private_jwt', 'private_api_key', 'anonymous']" :key="mode" :label="t('monitoring.mcpPublication.' + mode)" :value="mode" />
        </el-select>
      </el-form-item>
      <el-alert v-if="form.authBlock()" :title="t('monitoring.mcpPublication.' + form.authBlock() + 'Error')" type="warning" :closable="false" />
      <p v-if="state.inboundAuthMode === 'anonymous'">{{ t('monitoring.mcpPublication.anonymousHint') }}</p>
      <el-form-item :label="t('monitoring.mcpPublication.transport')"><el-select v-model="state.transport"><el-option label="Streamable HTTP" value="streamable" /><el-option label="SSE" value="sse" /></el-select></el-form-item>
      <el-form-item :label="t('monitoring.mcpPublication.port')"><el-input-number v-model="state.port" :min="1024" :max="65535" :precision="0" /></el-form-item>
      <p>{{ t('monitoring.mcpPublication.automatic') }}</p>
      <el-form-item :label="t('monitoring.mcpPublication.path')"><el-input v-model="state.endpointPath" maxlength="256" /></el-form-item>
      <el-button @click="state.endpointPath = state.transport === 'sse' ? '/sse' : '/mcp'">{{ t('monitoring.mcpPublication.defaultPath') }}</el-button>
    </el-form>
    <el-alert v-if="state.error" :title="t('monitoring.mcpPublication.' + state.error + 'Error')" type="error" :closable="false" />
    <p>{{ t('monitoring.mcpPublication.authMode') }}: {{ t('monitoring.mcpPublication.' + (state.savedInboundAuthMode || 'unknown')) }}</p>
    <p>{{ t('monitoring.mcpPublication.previewAuth') }}: {{ t('monitoring.mcpPublication.' + (state.preview?.inboundAuthMode || 'unknown')) }}</p>
    <p>{{ t('monitoring.mcpPublication.effectiveAuth') }}: {{ t('monitoring.mcpPublication.unknown') }}</p>
    <p>{{ t('monitoring.mcpPublication.effectiveHint') }}</p>
    <p>{{ t('monitoring.mcpPublication.preview') }}: {{ state.preview?.consumerUrl || t('monitoring.mcpPublication.unassigned') }}</p>
    <p>{{ t('monitoring.mcpPublication.localOnly') }}</p>
    <p v-if="state.preview?.messagesUrl">{{ t('monitoring.mcpPublication.messages') }}: {{ state.preview.messagesUrl }}</p>
    <p>{{ t('monitoring.mcpPublication.actual') }}: {{ state.actualStatus || t('monitoring.mcpPublication.unknown') }} · {{ state.actualEndpoint || t('monitoring.mcpPublication.unknown') }}</p>
    <template #footer>
      <el-button @click="form.close()">{{ t('common.cancel') }}</el-button>
      <el-button :disabled="state.saving" :loading="state.previewLoading || state.loading" @click="state.error === 'load' ? form.load() : form.refresh()">{{ t('monitoring.mcpPublication.retryPreview') }}</el-button>
      <el-button type="primary" :loading="state.saving" :disabled="!!form.authBlock() || !state.preview || state.previewLoading || state.loading" @click="form.save()">{{ t('monitoring.mcpPublication.deploy') }}</el-button>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { reactive, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { McpPublicationForm, mcpPublicationState } from '@/services/mcp-publication';
const { t } = useI18n(); const auth = useAuthStore(); const state = reactive(mcpPublicationState());
const form = new McpPublicationForm(state, () => auth.accessToken && auth.currentUser?.id ?
  { key: JSON.stringify([auth.currentUser.id, auth.accessToken]), token: auth.accessToken } : null);
watch([() => state.inboundAuthMode, () => state.transport, () => state.port, () => state.endpointPath], () => { void form.refresh(); }, { flush: 'sync' });
watch([() => auth.accessToken, () => auth.currentUser?.id], () => form.close(), { flush: 'sync' });
const route = useRoute();
watch(() => route.fullPath, () => form.close(), { flush: 'sync' });
onBeforeUnmount(() => form.close());
defineExpose({ open: (id: string, waiver?: string, mode: 'deploy' | 'redeploy' = 'deploy') => form.open(id, waiver, mode) });
</script>
