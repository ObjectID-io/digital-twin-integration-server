import { describe, expect, it } from "vitest";
import { ProfileRegistry } from "../../src/schemas/registry.js";
import { MaturityEngine } from "../../src/maturity/engine.js";

describe("maturity calculation", () => {
  const engine = new MaturityEngine(new ProfileRegistry("./profiles"));
  it("calculates a weighted level", async () => {
    const result = await engine.evaluate("default-v1", [
      { indicator: "identity", value: 100, uri: "ipfs://id", hash: "sha256:id" },
      { indicator: "data_connection", value: 80, uri: "ipfs://data", hash: "sha256:data" },
      { indicator: "semantic_model", value: 70 }, { indicator: "provenance", value: 60 }, { indicator: "operational_governance", value: 50 },
    ]);
    expect(result.score).toBe(74); expect(result.level).toBe(3);
  });
  it("requires configured evidence", async () => {
    await expect(engine.evaluate("default-v1", [{ indicator: "identity", value: 100 }])).rejects.toMatchObject({ code: "MATURITY_EVIDENCE_REQUIRED" });
  });
});
