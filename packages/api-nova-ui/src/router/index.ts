import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from "vue-router";
import MainLayout from "@/layout/MainLayout.vue";
import Login from "@/views/Login.vue";
import { i18n } from "@/locales";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    component: MainLayout,
    redirect: "/registration/batch",
    children: [
      {
        path: "/registration",
        redirect: "/registration/batch",
        meta: {
          hidden: true,
        },
      },
      {
        path: "/registration/batch",
        name: "registration-batch",
        component: () => import("@/modules/openapi/OpenAPIManager.vue"),
        meta: {
          title: "Batch Registration",
          icon: "Document",
          description: "Register APIs in batch through OpenAPI import and document normalization",
          productSurface: "registration",
        },
      },
      {
        path: "/registration/manual",
        name: "registration-manual",
        component: () =>
          import("@/modules/endpoint-registry/EndpointRegistry.vue"),
        meta: {
          title: "Manual Registration",
          icon: "Plus",
          description: "Register and maintain API endpoints manually",
          productSurface: "registration",
        },
      },
      {
        path: "/testing",
        name: "testing",
        component: () => import("@/modules/testing/APITester.vue"),
        meta: {
          title: "API Testing",
          icon: "Tools",
          description: "Validate registered APIs before governance and publication",
          productSurface: "testing",
        },
      },
      {
        path: "/governance",
        name: "governance",
        component: () =>
          import("@/modules/endpoint-registry/EndpointRegistry.vue"),
        meta: {
          title: "API Governance",
          icon: "Document",
          description: "Probe, review, and qualify endpoints into ready assets",
          productSurface: "governance",
        },
      },
      {
        path: "/publication",
        name: "publication",
        component: () =>
          import("@/modules/endpoint-registry/EndpointRegistry.vue"),
        meta: {
          title: "API Publication",
          icon: "Document",
          description: "Publish ready endpoints to MCP and Gateway runtime paths",
          productSurface: "publication",
        },
      },
      {
        path: "/runtime-assets",
        name: "runtime-assets",
        component: () => import("@/modules/servers/ServerManager.vue"),
        meta: {
          title: "Runtime Assets",
          icon: "Server",
          description: "Operate published MCP and Gateway runtime assets",
          productSurface: "runtime-assets",
        },
      },
      {
        path: "/runtime-assets/:id",
        name: "runtime-asset-detail",
        component: () => import("@/modules/runtime-assets/RuntimeAssetDetail.vue"),
        meta: {
          title: "Runtime Asset Detail",
          hidden: true,
          parent: "/runtime-assets",
          productSurface: "runtime-assets",
        },
      },
      {
        path: "/auth",
        name: "auth",
        component: () => import("@/modules/auth/AuthManager.vue"),
        meta: {
          title: "Authentication",
          icon: "Lock",
          description: "Manage API authentication configuration",
        },
      },
      {
        path: "/config",
        name: "config",
        component: () => import("@/modules/config/ConfigManagerNew.vue"),
        meta: {
          title: "Configuration",
          icon: "Setting",
          description: "Import and export system configuration",
        },
      },
      {
        path: "/logs",
        name: "logs",
        component: () => import("@/modules/logs/LogViewer.vue"),
        meta: {
          title: "Logs",
          icon: "List",
          description: "View system and debug logs",
        },
      },
      {
        path: "/monitoring",
        name: "monitoring",
        component: () =>
          import("@/modules/monitoring/monitoring/Dashboard.vue"),
        meta: {
          title: "Monitoring",
          icon: "Monitor",
          description: "System performance monitoring and alerts",
        },
      },
      {
        path: "/ai",
        name: "ai",
        component: () => import("@/modules/ai/AIAssistant.vue"),
        meta: {
          title: "AI Assistant",
          icon: "ChatDotRound",
          description: "AI assistant integration configuration",
        },
      },
    ],
  },
  {
    path: "/servers",
    redirect: "/runtime-assets",
  },
  {
    path: "/openapi",
    redirect: "/registration/batch",
  },
  {
    path: "/endpoint-registry",
    redirect: "/governance",
  },
  {
    path: "/tester",
    redirect: "/testing",
  },
  {
    path: "/login",
    name: "login",
    component: Login,
    meta: {
      title: "Login",
      hidden: true,
    },
  },
  {
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: () => import("@/views/NotFound.vue"),
    meta: {
      title: "Not Found",
      hidden: true,
    },
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 };
  },
});

router.beforeEach(async (to, _from, next) => {
  const { useAuthStore } = await import("@/stores/auth");
  const authStore = useAuthStore();

  const publicRoutes = ["/login", "/forgot-password"];
  const isPublicRoute = publicRoutes.includes(to.path);

  if (to.path === "/login") {
    if (authStore.accessToken && !authStore.currentUser) {
      try {
        await authStore.initializeAuth();
        if (authStore.currentUser) {
          next("/registration/batch");
          return;
        }
      } catch (_error) {
        // Keep login route reachable even if auth init fails
      }
    } else if (authStore.currentUser) {
      next("/registration/batch");
      return;
    }
    next();
    return;
  }

  if (isPublicRoute) {
    next();
    return;
  }

  if (authStore.accessToken && !authStore.currentUser) {
    try {
      await authStore.initializeAuth();
    } catch (_error) {
      // Fallback to auth status check below
    }
  }

  const isAuthenticated = !!authStore.accessToken && !!authStore.currentUser;
  if (!isAuthenticated) {
    next({
      path: "/login",
      query: { redirect: to.fullPath },
    });
    return;
  }

  const routeName = to.name ? String(to.name) : "";
  const menuKey = routeName ? `menu.${routeName}` : "";
  const translatedTitle = menuKey ? i18n.global.t(menuKey) : "";
  const pageTitle =
    translatedTitle && translatedTitle !== menuKey
      ? translatedTitle
      : String(to.meta?.title || "");

  if (pageTitle) {
    document.title = `${pageTitle} - ApiNova`;
  }

  next();
});

export default router;
