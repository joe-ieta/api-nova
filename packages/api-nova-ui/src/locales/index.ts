import { createI18n } from "vue-i18n";
import zhCN from "./messages/zh-CN";
import enUS from "./messages/en-US";

export type Locale = "zh-CN" | "en-US";

export const SUPPORT_LOCALES: { value: Locale; label: string; flag: string }[] = [
  { value: "zh-CN", label: "\u7b80\u4f53\u4e2d\u6587", flag: "CN" },
  { value: "en-US", label: "English", flag: "EN" },
];

const LOCALE_STORAGE_KEY = "api-nova-locale";
const LEGACY_LOCALE_STORAGE_KEY = "mcp-gateway-locale";

export const i18n = createI18n({
  legacy: false,
  locale: "zh-CN",
  fallbackLocale: "en-US",
  messages: {
    "zh-CN": zhCN,
    "en-US": enUS,
  },
  globalInjection: true,
  silentTranslationWarn: true,
});

export function getBrowserLocale(): Locale {
  const browserLang = navigator.language || navigator.languages[0];

  if (browserLang.startsWith("zh")) {
    return "zh-CN";
  }

  if (browserLang.startsWith("en")) {
    return "en-US";
  }

  return "zh-CN";
}

export function setLocale(locale: Locale) {
  i18n.global.locale.value = locale;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}

export function loadLocalePreference(): Locale {
  try {
    const saved =
      (localStorage.getItem(LOCALE_STORAGE_KEY) as Locale) ||
      (localStorage.getItem(LEGACY_LOCALE_STORAGE_KEY) as Locale);

    if (saved && SUPPORT_LOCALES.some((item) => item.value === saved)) {
      return saved;
    }
  } catch (error) {
    console.warn("Failed to load locale preference:", error);
  }

  return getBrowserLocale();
}

export function initLocale() {
  const locale = loadLocalePreference();
  setLocale(locale);
}

export default i18n;
