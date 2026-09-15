import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import { useAuthStore } from "./auth";
import { policyRequest, validPolicy, type ObservabilityPolicy } from "@/services/observability-policies";

export const useObservabilityPoliciesStore = defineStore("observability-policies", () => {
  const auth = useAuthStore();
  const policy = ref<ObservabilityPolicy | null>(null);
  const canEdit = ref(false), loading = ref(false), saving = ref(false);
  const eventDays = ref<number | undefined>(), payloadDays = ref<number | undefined>();
  const reason = ref("");
  const message = ref<"saved" | "conflict" | "unavailable" | "invalid" | "forbidden" | null>(null);
  let generation = 0, active = false;
  let controller: AbortController | null = null;
  const session = () => auth.currentUser?.id && auth.accessToken ?
    JSON.stringify([auth.currentUser.id, auth.accessToken]) : null;
  const canSave = computed(() => canEdit.value && !!policy.value && !loading.value && !saving.value &&
    [eventDays.value, payloadDays.value].every(n => Number.isSafeInteger(n) && Number(n) >= 1 && Number(n) <= 365) &&
    !!reason.value.trim() && reason.value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(reason.value));
  function clear() {
    generation++;
    controller?.abort(); controller = null;
    policy.value = null; canEdit.value = false;
    eventDays.value = undefined; payloadDays.value = undefined; reason.value = "";
    loading.value = false; saving.value = false; message.value = null;
  }
  function deactivate() { active = false; clear(); }
  function apply(value: ObservabilityPolicy) {
    policy.value = value;
    eventDays.value = value.retention.eventDays; payloadDays.value = value.retention.payloadDays;
    reason.value = "";
  }
  async function load() {
    active = true;
    const owner = session();
    if (!owner) { clear(); return; }
    const token = auth.accessToken!;
    const current = ++generation;
    controller?.abort();
    const request = new AbortController(); controller = request;
    const deadline = setTimeout(() => request.abort(), 10000);
    loading.value = true; saving.value = false; message.value = null;
    policy.value = null; canEdit.value = false;
    eventDays.value = undefined; payloadDays.value = undefined; reason.value = "";
    try {
      const [capabilities, list] = await Promise.all([
        policyRequest("capabilities", token, request.signal),
        policyRequest("policies", token, request.signal),
      ]);
      if (current !== generation || session() !== owner) return;
      const value = list?.items?.find((item: any) => item?.id === "global-event-retention");
      if (!value && Array.isArray(list?.items) && list.items.length === 0) return;
      if (!validPolicy(value)) throw new Error("Invalid policy");
      apply(value);
      canEdit.value = Array.isArray(capabilities?.features) && capabilities.features.some((feature: any) =>
        feature.name === "policyManagement" && feature.state === "enabled" && feature.scopeMode === "all");
    } catch (error: any) {
      if (current === generation && session() === owner) {
        policy.value = null; canEdit.value = false;
        message.value = ["UNAUTHENTICATED", "FORBIDDEN"].includes(error?.code) ? "forbidden" : "unavailable";
      }
    } finally {
      // Promise.all can reject while its sibling GET is still pending.
      request.abort();
      clearTimeout(deadline);
      if (current === generation) { loading.value = false; controller = null; }
    }
  }
  async function save() {
    if (!canSave.value || !policy.value) { message.value = canEdit.value ? "invalid" : "forbidden"; return; }
    const owner = session();
    if (!owner) { clear(); return; }
    const token = auth.accessToken!;
    const current = ++generation;
    const request = new AbortController(); controller = request;
    const deadline = setTimeout(() => request.abort(), 10000);
    const mutation = { etag: policy.value.policyEtag, eventDays: eventDays.value!,
      payloadDays: payloadDays.value!, reason: reason.value.trim() };
    saving.value = true; message.value = null;
    try {
      const changed = await policyRequest("policies/global-event-retention", token, request.signal, mutation);
      if (current !== generation || session() !== owner) return;
      if (!validPolicy(changed)) throw new Error("Invalid policy");
      apply(changed); message.value = "saved";
    } catch (error: any) {
      if (current !== generation || session() !== owner) return;
      policy.value = null; canEdit.value = false; reason.value = "";
      if (error?.code === "PRECONDITION_FAILED") {
        const recovery = load();
        const recoveryGeneration = generation;
        await recovery;
        if (generation === recoveryGeneration && session() === owner && policy.value) message.value = "conflict";
      } else message.value = ["UNAUTHENTICATED", "FORBIDDEN"].includes(error?.code) ? "forbidden" : "unavailable";
    } finally {
      clearTimeout(deadline);
      if (current === generation && session() === owner) saving.value = false;
      if (current === generation) controller = null;
    }
  }
  watch([() => auth.accessToken, () => auth.currentUser?.id], () => {
    clear();
    if (active && session()) void load();
  }, { flush: "sync" });
  return { policy, canEdit, loading, saving, eventDays, payloadDays, reason, message, canSave, load, save, clear, deactivate };
});
