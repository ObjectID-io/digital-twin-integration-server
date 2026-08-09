import { describe, expect, it } from "vitest";
import { ProfileRegistry } from "../../src/schemas/registry.js";

describe("OME profile validation", () => {
  const registry = new ProfileRegistry("./profiles");
  it("accepts a valid OME profile", async () => {
    await expect(registry.validate("objectid-profile://iso23247/ome/v1", {
      profile: "objectid-profile://iso23247/ome/v1", twinType: "machine", name: "M1", target: { kind: "machine" },
    })).resolves.toBeTruthy();
  });
  it("accepts an autonomous OME Twin without an OIDObject", async () => {
    await expect(registry.validate("objectid-profile://iso23247/ome/v1", { profile: "objectid-profile://iso23247/ome/v1", twinType: "machine", name: "M1" })).resolves.toBeTruthy();
  });
  it("still rejects missing required Twin identity fields", async () => {
    await expect(registry.validate("objectid-profile://iso23247/ome/v1", { profile: "objectid-profile://iso23247/ome/v1", twinType: "machine" })).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });
});
