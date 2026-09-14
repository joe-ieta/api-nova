# Observability subscription command integration

## Scope

This increment implements internal TP12 command preparation. It does not register subscription HTTP controllers, publish Swagger routes, or change capabilities. Public PATCH remains a partial-update contract; the internal normalizer intentionally accepts a complete replacement configuration. An eventual controller must combine a partial patch with the current version inside the authorized transaction rather than treating omitted fields as defaults.

## Canonical input

`normalizeObservabilitySubscription` in `call-observability-subscriptions.input.ts` requires name, destination, secretRef, signingKeyId, enabled, scope and filter. It rejects extra fields. Scope is either explicit all or a nonempty asset set. Filter arrays are nonempty, unique and sorted; values within a field are OR and fields combine with AND. An empty filter object means no extra filter, not unrestricted authorization.

The HTTPS destination cannot contain credentials, a query or a fragment. Syntax validation is not destination authorization or SSRF protection. Deployment allowlists, current secret-reference authorization and later DNS/address validation remain separate mandatory controls. Secret references are opaque identifiers, never a reason to read arbitrary environment variables, files or URLs.

## Transaction boundaries

Creation must establish an effective sequence boundary. Every configuration change creates an immutable revision; old delivery tasks continue referencing their old revision. Pause changes collection/attempt eligibility rather than silently marking pending tasks successful. Soft deletion cancels unfinished deliveries and invalidates their leases while retaining event and attempt audit history.

The command policy must freshly authorize the owner and the entire requested resource scope. If-Match is checked after object authorization and in the mutation transaction. Safe management audit metadata and idempotency receipts belong to the same commit. No URL resolution, secret fetching, HTTP request or other external I/O may run in these transaction callbacks.

A missing destination/secret authorization policy must reject create/update. Tests or composition code must not replace it with a permissive production default. Idempotent creation requires the independent API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET used by ObservabilityCommandStore; it is not the webhook signing secret.

## Remaining delivery work

HTTP DTOs/controllers, current-scope list/detail presentation, safe destination views, partial PATCH integration, controlled test delivery, revision revocation controls and explicit manual replay remain separate work. Internal command methods do not establish VERIFIED endpoint status. Build, transaction rollback, concurrent revisions and end-to-end acceptance must be recorded against this increment before advancing its status.