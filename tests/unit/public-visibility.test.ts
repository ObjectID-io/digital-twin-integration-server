import { describe, expect, it } from "vitest";
import { objectIdTwinPublicAccess } from "../../src/twin/publicVisibility.js";

const packageId = "0xpackage";
function twin(metadata: Record<string, unknown>) {
  return { data: { type: `${packageId}::oid_twin::OIDTwin`, content: { fields: { mutable_metadata: JSON.stringify(metadata) } } } };
}

describe("public Twin access policies", () => {
  it("keeps legacy public telemetry positions visible", () => {
    expect(objectIdTwinPublicAccess(twin({ objectid: { visibility: "public", dataVisibility: "public" } }), packageId)).toEqual({
      twinPublic: true, dataPublic: true, liveLocationPublic: true,
    });
  });

  it("lets an explicit live-location policy override telemetry visibility", () => {
    expect(objectIdTwinPublicAccess(twin({ objectid: { visibility: "public", dataVisibility: "public", liveLocationVisibility: "private" } }), packageId).liveLocationPublic).toBe(false);
    expect(objectIdTwinPublicAccess(twin({ objectid: { visibility: "public", dataVisibility: "private", liveLocationVisibility: "public" } }), packageId).liveLocationPublic).toBe(true);
  });
});
