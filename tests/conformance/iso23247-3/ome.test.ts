import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ProfileRegistry } from "../../../src/schemas/registry.js";

describe("ISO 23247-3 OME profile evidence", () => {
  const registry = new ProfileRegistry("./profiles");
  const directory = "./profiles/iso23247/ome/ome-v1";

  it("DT-23247-3-001 accepts the declared valid example and tracks version", async () => {
    const payload = JSON.parse(await readFile(`${directory}/example-valid.json`, "utf8"));
    expect(await registry.validateAgainstProfile("iso23247-ome-v1", payload)).toMatchObject({ valid: true, version: "1.0.0" });
  });

  it("DT-23247-3-002 reports invalid type, missing field, and semantic version", async () => {
    const payload = JSON.parse(await readFile(`${directory}/example-invalid.json`, "utf8"));
    const result = await registry.validateAgainstProfile("iso23247-ome-v1", payload);
    expect(result.valid).toBe(false); expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
