import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const proxyTarget = env.VITE_PROXY_TARGET || "http://127.0.0.1:9001";

  return {
    plugins: [
      vue(),
      AutoImport({
        resolvers: [ElementPlusResolver()],
        imports: ["vue", "vue-router", "pinia"],
        dts: true,
      }),
      Components({
        resolvers: [ElementPlusResolver()],
        dts: true,
      }),
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    server: {
      port: 9000,
      strictPort: true,
      host: true,
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, "/api"),
        },
        "/socket.io": {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, "/");

            if (
              normalizedId.includes("plugin-vue:export-helper") ||
              normalizedId.includes("vite/preload-helper")
            ) {
              return "app-core";
            }

            if (normalizedId.includes("/node_modules/")) {
              if (
                normalizedId.includes("/node_modules/vue/") ||
                normalizedId.includes("/node_modules/@vue/") ||
                normalizedId.includes("/node_modules/vue-router/") ||
                normalizedId.includes("/node_modules/pinia/") ||
                normalizedId.includes("/node_modules/vue-i18n/") ||
                normalizedId.includes("/node_modules/@intlify/")
              ) {
                return "vendor-vue";
              }

              if (
                normalizedId.includes("element-plus") ||
                normalizedId.includes("@element-plus")
              ) {
                return "vendor-element-plus";
              }

              if (
                normalizedId.includes("/node_modules/echarts/") ||
                normalizedId.includes("/node_modules/vue-echarts/") ||
                normalizedId.includes("/node_modules/zrender/")
              ) {
                return "vendor-charts";
              }

              if (
                normalizedId.includes("/node_modules/socket.io-client/") ||
                normalizedId.includes("/node_modules/socket.io-parser/") ||
                normalizedId.includes("/node_modules/engine.io-client/") ||
                normalizedId.includes("/node_modules/engine.io-parser/") ||
                normalizedId.includes("/node_modules/@socket.io/")
              ) {
                return "vendor-realtime";
              }

              if (
                normalizedId.includes("/node_modules/axios/") ||
                normalizedId.includes("/node_modules/date-fns/") ||
                normalizedId.includes("/node_modules/highlight.js/")
              ) {
                return "vendor-app";
              }

              if (normalizedId.includes("monaco-editor")) {
                return "vendor-monaco";
              }

              return "vendor-misc";
            }

            if (
              normalizedId.includes("/src/stores/") ||
              normalizedId.includes("/src/services/") ||
              normalizedId.includes("/src/composables/") ||
              normalizedId.includes("/src/utils/") ||
              normalizedId.includes("/src/api/")
            ) {
              return "app-core";
            }

            if (normalizedId.includes("/src/locales/")) {
              return "feature-i18n";
            }

            if (normalizedId.includes("/src/modules/monitoring/")) {
              return "feature-monitoring";
            }

            if (
              normalizedId.includes("/src/shared/components/monaco/") ||
              normalizedId.includes("/src/shared/composables/useMonaco")
            ) {
              return "feature-editor";
            }

            if (normalizedId.includes("/src/modules/auth/")) {
              return "feature-auth";
            }

            if (normalizedId.includes("/src/modules/ai/")) {
              return "feature-ai";
            }

            if (normalizedId.includes("/src/modules/config/")) {
              return "feature-config";
            }

            if (normalizedId.includes("/src/modules/testing/")) {
              return "feature-testing";
            }

            if (normalizedId.includes("/src/modules/openapi/")) {
              return "feature-openapi";
            }

            if (normalizedId.includes("/src/modules/servers/")) {
              return "feature-servers";
            }
          },
        },
      },
    },
    optimizeDeps: {
      include: ["monaco-editor"],
    },
    define: {
      // Monaco Editor 需要的全局变量
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
    },
    worker: {
      format: "es",
    },
  };
});
