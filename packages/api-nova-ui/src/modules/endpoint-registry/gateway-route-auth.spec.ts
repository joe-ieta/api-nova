import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  gatewayAuthFieldsForSave,
  gatewayVisibilityForForm,
} from "./gateway-route-auth.ts";

test("legacy public and unknown visibility refill as protected internal", () => {
  for (const value of ["public", "INTERNAL", "", null, undefined]) {
    assert.equal(gatewayVisibilityForForm(value), "internal");
  }
  assert.equal(gatewayVisibilityForForm("external"), "external");
});

test("submit preserves deliberate external and clears an empty auth policy", () => {
  assert.deepEqual(
    gatewayAuthFieldsForSave({ routeVisibility: "external", authPolicyRef: " anonymous " }),
    { routeVisibility: "external", authPolicyRef: "anonymous" },
  );
  assert.deepEqual(
    gatewayAuthFieldsForSave({ routeVisibility: "public", authPolicyRef: "   " }),
    { routeVisibility: "internal", authPolicyRef: "" },
  );
});
