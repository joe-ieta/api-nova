<template>
  <div class="forgot-container">
    <div class="forgot-card">
      <!-- 顶部工具栏 -->
      <div class="forgot-toolbar">
        <!-- 语言切换 -->
        <el-dropdown
          @command="handleLanguageChange"
          trigger="click"
          size="small"
        >
          <el-button text class="toolbar-btn">
            {{ localeStore.currentLanguage.flag }}
            <el-icon class="el-icon--right"><CaretBottom /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="locale in supportedLocales"
                :key="locale.value"
                :command="locale.value"
                :disabled="
                  localeStore.currentLanguage &&
                  locale.value === localeStore.currentLanguage.value
                "
              >
                {{ locale.flag }} {{ locale.label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <!-- 标题区域 -->
      <div class="forgot-header">
        <h1 class="brand-title">ApiNova</h1>
        <h2 class="forgot-title">{{ $t("userAuth.forgotPassword.title") }}</h2>
        <p class="forgot-subtitle">
          {{ $t("userAuth.forgotPassword.subtitle") }}
        </p>
      </div>

      <!-- 通用成功提示（不暴露账号是否存在） -->
      <div v-if="submitted" class="success-alert">
        <svg class="success-icon" viewBox="0 0 24 24">
          <path
            d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
          />
        </svg>
        <span>{{ $t("userAuth.forgotPassword.successMessage") }}</span>
      </div>

      <div v-else class="forgot-form">
        <form @submit.prevent="handleSubmit">
          <div class="form-group">
            <label for="email" class="form-label">
              <svg class="label-icon" viewBox="0 0 24 24">
                <path
                  d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"
                />
              </svg>
              {{ $t("userAuth.forgotPassword.email") }}
            </label>
            <input
              id="email"
              v-model="email"
              type="email"
              class="form-input"
              :class="{ error: errors.email }"
              :placeholder="$t('userAuth.forgotPassword.enterEmail')"
              required
              :disabled="submitting"
            />
            <span v-if="errors.email" class="error-message">{{
              errors.email
            }}</span>
          </div>

          <button
            type="submit"
            class="submit-button"
            :disabled="submitting || !isFormValid"
          >
            <svg v-if="submitting" class="loading-icon" viewBox="0 0 24 24">
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
                fill="none"
                opacity="0.25"
              />
              <path
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                fill="currentColor"
              />
            </svg>
            <span v-if="!submitting">{{
              $t("userAuth.forgotPassword.submitButton")
            }}</span>
            <span v-else>{{ $t("userAuth.forgotPassword.submitting") }}</span>
          </button>
        </form>
      </div>

      <router-link to="/login" class="back-link">
        {{ $t("userAuth.forgotPassword.backToLogin") }}
      </router-link>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import { CaretBottom } from "@element-plus/icons-vue";
import { userAuthAPI } from "@/services/api";
import { useLocaleStore } from "@/stores/locale";
import { SUPPORT_LOCALES, type Locale } from "@/locales";

const { t } = useI18n();
const localeStore = useLocaleStore();

// 响应式数据
const email = ref("");
const errors = ref<Record<string, string>>({});
const submitting = ref(false);
const submitted = ref(false);

const supportedLocales = SUPPORT_LOCALES;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isFormValid = computed(() => email.value.trim() !== "");

// 表单验证
const validateForm = (): boolean => {
  errors.value = {};

  const value = email.value.trim();
  if (!value) {
    errors.value.email = t("userAuth.validation.emailRequired");
  } else if (!emailPattern.test(value)) {
    errors.value.email = t("userAuth.validation.emailInvalid");
  }

  return Object.keys(errors.value).length === 0;
};

// 处理表单提交：无论结果如何都展示通用成功提示，避免账号枚举
const handleSubmit = async () => {
  if (submitting.value || !validateForm()) {
    return;
  }

  submitting.value = true;
  try {
    await userAuthAPI.requestPasswordReset(email.value.trim());
  } catch (error) {
    console.warn("Password reset request failed:", error);
  } finally {
    submitting.value = false;
    submitted.value = true;
  }
};

// 语言切换
const handleLanguageChange = (locale: string) => {
  try {
    const targetLocale = locale as Locale;
    localeStore.changeLocale(targetLocale);
    const language = SUPPORT_LOCALES.find((l) => l.value === targetLocale);
    ElMessage.success(
      t("language.switched", { language: language?.label || targetLocale }),
    );
  } catch {
    ElMessage.error(t("error.operationFailed"));
  }
};
</script>

<style scoped>
.forgot-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(
    180deg,
    var(--bg-secondary) 0%,
    var(--bg-tertiary) 100%
  );
  padding: 1rem;
  position: relative;
}

.forgot-card {
  background: var(--bg-primary);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-heavy);
  width: 100%;
  max-width: 450px;
  padding: 2.5rem;
  position: relative;
}

.forgot-toolbar {
  position: absolute;
  top: 1rem;
  right: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  z-index: 10;
}

.toolbar-btn {
  min-width: auto !important;
  padding: 6px 8px !important;
  font-size: 14px;
  color: var(--text-secondary);
  transition: all 0.2s;
  border-radius: var(--radius-medium);
}

.toolbar-btn:hover {
  color: var(--apple-blue);
  background-color: rgba(0, 122, 255, 0.1);
}

.forgot-header {
  text-align: center;
  margin-bottom: 2rem;
}

.brand-title {
  font-size: 1.75rem;
  font-weight: 700;
  background: linear-gradient(
    135deg,
    var(--apple-blue) 0%,
    var(--apple-purple) 100%
  );
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin: 0 0 1rem 0;
}

.forgot-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 0.5rem 0;
}

.forgot-subtitle {
  color: var(--text-secondary);
  margin: 0;
  font-size: 0.875rem;
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-label {
  display: flex;
  align-items: center;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 0.5rem;
  gap: 0.5rem;
}

.label-icon {
  width: 1rem;
  height: 1rem;
  fill: var(--text-secondary);
}

.form-input {
  width: 100%;
  padding: 0.875rem 1rem;
  border: 2px solid var(--border-color);
  border-radius: var(--radius-large);
  font-size: 0.875rem;
  transition: all 0.3s;
  box-sizing: border-box;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.form-input:focus {
  outline: none;
  border-color: var(--apple-blue);
  box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.1);
  background: var(--bg-primary);
}

.form-input.error {
  border-color: var(--apple-red);
}

.form-input:disabled {
  background-color: var(--bg-secondary);
  cursor: not-allowed;
}

.error-message {
  display: block;
  color: var(--apple-red);
  font-size: 0.75rem;
  margin-top: 0.25rem;
  font-weight: 500;
}

.submit-button {
  width: 100%;
  background: var(--apple-blue);
  color: white;
  border: none;
  border-radius: var(--radius-large);
  padding: 1rem;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  box-shadow: var(--shadow-medium);
  min-height: 44px;
}

.submit-button:hover:not(:disabled) {
  background: var(--apple-blue-dark);
  transform: translateY(-2px);
  box-shadow: var(--shadow-heavy);
}

.submit-button:disabled {
  background: var(--system-gray-3);
  color: var(--text-secondary);
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
  opacity: 0.6;
}

.loading-icon {
  width: 1rem;
  height: 1rem;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.success-alert {
  display: flex;
  align-items: center;
  background: rgba(40, 205, 65, 0.1);
  border: 1px solid var(--apple-green);
  border-radius: var(--radius-large);
  padding: 0.875rem;
  color: var(--apple-green);
  font-size: 0.875rem;
  line-height: 1.4;
}

.success-icon {
  width: 1.25rem;
  height: 1.25rem;
  margin-right: 0.5rem;
  flex-shrink: 0;
  fill: currentColor;
}

.back-link {
  display: block;
  text-align: center;
  margin-top: 1.5rem;
  font-size: 0.875rem;
  color: var(--apple-blue);
  text-decoration: none;
}

.back-link:hover {
  text-decoration: underline;
}

@media (max-width: 640px) {
  .forgot-container {
    padding: 0.5rem;
  }

  .forgot-card {
    padding: 2rem 1.5rem;
  }

  .brand-title {
    font-size: 1.5rem;
  }

  .forgot-title {
    font-size: 1.25rem;
  }
}
</style>
