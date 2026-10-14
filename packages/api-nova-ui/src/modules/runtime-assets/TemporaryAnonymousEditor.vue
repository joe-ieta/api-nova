<template>
  <el-alert :title="t('monitoring.mcpPublication.anonymousRisk')" type="warning" :closable="false" show-icon />
  <el-checkbox :model-value="draft.enabled" @update:model-value="updateDraft({ enabled: $event })" :disabled="draft.locked">{{ t('monitoring.mcpPublication.temporary') }}</el-checkbox>
  <template v-if="draft.enabled || draft.locked">
    <el-form-item :label="t('monitoring.mcpPublication.reason')"><el-input :model-value="draft.reason" @update:model-value="updateDraft({ reason: $event })" type="textarea" maxlength="500" show-word-limit /></el-form-item>
    <el-form-item :label="t('monitoring.mcpPublication.expiry')"><el-date-picker :model-value="draft.expiresAt" @update:model-value="updateDraft({ expiresAt: $event })" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" :clearable="true" /></el-form-item>
    <el-checkbox :model-value="draft.allowProduction" @update:model-value="updateDraft({ allowProduction: $event })">{{ t('monitoring.mcpPublication.productionPermit') }}</el-checkbox>
    <p>{{ t('monitoring.mcpPublication.productionHint') }}</p>
    <p v-if="draft.actor">{{ t('monitoring.mcpPublication.grantedBy') }}: {{ draft.actor }}</p>
    <el-alert v-if="temporaryAnonymousError(draft)" :title="t('monitoring.mcpPublication.' + temporaryAnonymousError(draft) + 'Error')" type="error" :closable="false" />
  </template>
  <p v-else>{{ t('monitoring.mcpPublication.permanentHint') }}</p>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { temporaryAnonymousDraft, temporaryAnonymousError } from '@/services/mcp-publication';
type Draft = ReturnType<typeof temporaryAnonymousDraft>;
const props = defineProps<{ draft: Draft }>();
const emit = defineEmits<{ (event: 'update:draft', value: Draft): void }>();
const updateDraft = (change: Partial<Draft>) => emit('update:draft', { ...props.draft, ...change });
const { t } = useI18n();
</script>
