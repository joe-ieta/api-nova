<template>
  <el-alert :title="t('monitoring.mcpPublication.anonymousRisk')" type="warning" :closable="false" show-icon />
  <el-checkbox v-model="draft.enabled" :disabled="draft.locked">{{ t('monitoring.mcpPublication.temporary') }}</el-checkbox>
  <template v-if="draft.enabled || draft.locked">
    <el-form-item :label="t('monitoring.mcpPublication.reason')"><el-input v-model="draft.reason" type="textarea" maxlength="500" show-word-limit /></el-form-item>
    <el-form-item :label="t('monitoring.mcpPublication.expiry')"><el-date-picker v-model="draft.expiresAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" :clearable="true" /></el-form-item>
    <el-checkbox v-model="draft.allowProduction">{{ t('monitoring.mcpPublication.productionPermit') }}</el-checkbox>
    <p>{{ t('monitoring.mcpPublication.productionHint') }}</p>
    <p v-if="draft.actor">{{ t('monitoring.mcpPublication.grantedBy') }}: {{ draft.actor }}</p>
    <el-alert v-if="temporaryAnonymousError(draft)" :title="t('monitoring.mcpPublication.' + temporaryAnonymousError(draft) + 'Error')" type="error" :closable="false" />
  </template>
  <p v-else>{{ t('monitoring.mcpPublication.permanentHint') }}</p>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { temporaryAnonymousDraft, temporaryAnonymousError } from '@/services/mcp-publication';
defineProps<{ draft: ReturnType<typeof temporaryAnonymousDraft> }>();
const { t } = useI18n();
</script>
