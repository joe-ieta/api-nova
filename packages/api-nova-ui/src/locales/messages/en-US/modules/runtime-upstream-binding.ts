export default {
  endpointRegistry: {
    runtimeUpstreamBinding: {
      title: "Runtime Upstream Binding · {name}",
      hint:
        "Published members must be explicitly bound to runtime instances in an environment. The runtime only resolves healthy and enabled candidate instances.",
      fields: {
        environment: "Runtime Environment",
        selectionMode: "Selection Strategy",
        status: "Binding Status",
        primaryInstance: "Primary Instance",
      },
      selectionModes: {
        fixedPrimary: "Fixed Primary",
        healthyPriority: "Healthy First",
      },
      statuses: {
        draft: "Draft",
        verified: "Verified",
        active: "Active",
        blocked: "Blocked",
      },
      primaryPlaceholder: "Select a fixed primary instance",
      candidates: {
        title: "Candidate Instances",
        note: "Ties on priority are resolved stably by order value, then instance ID",
        revision: "Revision {revision}",
        empty: "No runtime instances are configured for this environment",
        columns: {
          enabled: "Enabled Candidate",
          instance: "Instance",
          baseUrl: "Runtime URL",
          health: "Health",
          priority: "Priority",
          order: "Order",
          weight: "Weight",
        },
      },
      resolution: {
        title: "Current Resolution",
        resolved: "Resolved",
        summary: "{name} · {baseUrl} · Revision {revision}",
        notResolved: "Not resolved yet",
        reasons: {
          resolved: "Resolved",
          bindingNotActive: "Binding is not active yet",
          fixedPrimaryUnavailable: "The fixed primary instance is currently unavailable",
          noHealthyCandidate: "No healthy and enabled candidate instances",
        },
      },
      actions: {
        deleteBinding: "Delete Binding",
        cancel: "Cancel",
        resolve: "Resolve & Verify",
        save: "Save Binding",
      },
      messages: {
        loadFailed: "Failed to load runtime upstream binding",
        environmentRequired: "Select a runtime environment",
        candidateRequired: "Select at least one candidate instance",
        primaryRequired: "The fixed primary strategy requires a primary instance",
        saveSuccess: "Runtime upstream binding saved",
        saveFailed: "Failed to save runtime upstream binding",
        resolveFailed: "Upstream resolution failed",
        deleteConfirmTitle: "Delete Binding",
        deleteConfirm: "Delete the runtime upstream binding for the current published member?",
        deleteSuccess: "Runtime upstream binding deleted",
        deleteFailed: "Failed to delete runtime upstream binding",
      },
    },
  },
};
