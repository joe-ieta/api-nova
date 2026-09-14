import { ref, watch } from "vue";
import { defineStore } from "pinia";
import { useAuthStore } from "./auth";
import { diagnosticsRequest, diagnosticTime, heartbeatEvidence, routingEvidence, retentionEvidence } from "@/services/observability-diagnostics";

export const useObservabilityDiagnosticsStore = defineStore("observability-diagnostics", () => {
  const auth = useAuthStore();
  const loading = ref(false), error = ref(false), pipelineRestricted = ref(true);
  const errors = ref({ servers: false, capabilities: false, pipeline: false });
  const readAt = ref<string | null>(null), pipelineReadAt = ref<string | null>(null);
  const heartbeat = ref<ReturnType<typeof heartbeatEvidence>>(null);
  const routes = ref<{ runtimeAssetId: string; evidence: ReturnType<typeof routingEvidence> }[]>([]);
  const retention = ref<ReturnType<typeof retentionEvidence>>(null);
  let generation = 0, active = false, controller: AbortController | null = null;
  const session = () => auth.accessToken && auth.currentUser?.id ? JSON.stringify([auth.currentUser.id, auth.accessToken]) : null;
  function clear() {
    generation++; controller?.abort(); controller = null;
    loading.value = false; error.value = false; pipelineRestricted.value = true;
    errors.value = { servers: false, capabilities: false, pipeline: false };
    readAt.value = null; pipelineReadAt.value = null; heartbeat.value = null; routes.value = []; retention.value = null;
  }
  function deactivate() { active = false; clear(); }
  async function load() {
    active = true;
    clear();
    const owner = session();
    if (!owner) return;
    const current = generation, token = auth.accessToken!;
    const request = new AbortController(); controller = request;
    const deadline = setTimeout(() => request.abort(), 10000);
    const valid = () => current === generation && session() === owner;
    loading.value = true;
    try {
      const [capabilities, servers] = await Promise.allSettled([
        diagnosticsRequest("capabilities", token, request.signal),
        diagnosticsRequest("servers/status", token, request.signal),
      ]);
      if (!valid()) return;
      if (servers.status === "fulfilled" && Array.isArray(servers.value?.items) && servers.value.items.length <= 200) {
        readAt.value = diagnosticTime(servers.value.readAt);
        heartbeat.value = heartbeatEvidence(servers.value.managementHeartbeat);
        routes.value = servers.value.items.filter((row: any) => row?.serverType === "gateway" &&
          typeof row.runtimeAssetId === "string").map((row: any) => ({
          runtimeAssetId: row.runtimeAssetId, evidence: routingEvidence(row.gatewayRoutingObservation),
        }));
      } else { error.value = true; errors.value.servers = true; }
      const canReadPipeline = capabilities.status === "fulfilled" &&
        Array.isArray(capabilities.value?.features) && capabilities.value.features.some((feature: any) =>
          feature.name === "pipelineStatus" && feature.state === "enabled" && feature.scopeMode === "all");
      pipelineRestricted.value = !canReadPipeline;
      if (capabilities.status === "rejected") { error.value = true; errors.value.capabilities = true; }
      if (canReadPipeline) {
        try {
          const pipeline = await diagnosticsRequest("pipeline/status", token, request.signal);
          if (valid()) {
            pipelineReadAt.value = diagnosticTime(pipeline?.evaluatedAt);
            retention.value = retentionEvidence(pipeline?.retention);
          }
        } catch { if (valid()) { retention.value = null; error.value = true; errors.value.pipeline = true; } }
      }
    } finally {
      clearTimeout(deadline);
      if (valid()) { loading.value = false; controller = null; }
    }
  }
  watch([() => auth.accessToken, () => auth.currentUser?.id], () => {
    clear();
    if (active && session()) void load();
  }, { flush: "sync" });
  return { loading, error, errors, pipelineRestricted, readAt, pipelineReadAt, heartbeat, routes, retention, load, deactivate };
});
