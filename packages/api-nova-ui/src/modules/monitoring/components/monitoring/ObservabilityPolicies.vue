<template>
  <el-card class="logs-card" v-loading="policies.loading">
    <template #header>
      <div class="policy-header">
        <span>{{ t("monitoring.policies.title") }}</span>
        <el-button size="small" :disabled="policies.loading || policies.saving" @click="policies.load()">
          {{ t("common.refresh") }}
        </el-button>
      </div>
    </template>
    <p>{{ t("monitoring.policies.impact") }}</p>
    <el-alert v-if="policies.message" :closable="false" show-icon
      :type="policies.message === 'saved' ? 'success' : 'warning'"
      :title="t('monitoring.policies.messages.' + policies.message)" />
    <template v-if="policies.policy">
      <p>{{ t("monitoring.policies.revision", { revision: policies.policy.revision }) }}</p>
      <p v-if="!policies.canEdit">{{ t("monitoring.policies.readOnly") }}</p>
      <el-form label-position="top" @submit.prevent="policies.save()">
        <el-form-item :label="t('monitoring.policies.eventDays')">
          <el-input-number v-model="policies.eventDays" :min="1" :max="365" :precision="0"
            :disabled="!policies.canEdit || policies.saving" />
        </el-form-item>
        <el-form-item :label="t('monitoring.policies.payloadDays')">
          <el-input-number v-model="policies.payloadDays" :min="1" :max="365" :precision="0"
            :disabled="!policies.canEdit || policies.saving" />
        </el-form-item>
        <template v-if="policies.canEdit">
          <el-form-item :label="t('monitoring.policies.reason')" required>
            <el-input v-model="policies.reason" :maxlength="500" show-word-limit :disabled="policies.saving" />
          </el-form-item>
          <el-button type="primary" native-type="submit" :loading="policies.saving" :disabled="!policies.canSave">
            {{ t("monitoring.policies.save") }}
          </el-button>
        </template>
      </el-form>
    </template>
    <p v-else-if="!policies.loading && !policies.message">{{ t("monitoring.policies.noAccess") }}</p>
  </el-card>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useObservabilityPoliciesStore } from "@/stores/observability-policies";
const { t } = useI18n();
const policies = useObservabilityPoliciesStore();
onMounted(() => policies.load());
onBeforeUnmount(() => policies.deactivate());
</script>
<style scoped>
.policy-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
</style>
