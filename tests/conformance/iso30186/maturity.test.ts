import { describe, expect, it } from "vitest";
import { MaturityEngine } from "../../../src/maturity/engine.js";
import { ProfileRegistry } from "../../../src/schemas/registry.js";

describe("ISO/IEC 30186 alignment evidence", () => {
  const engine = new MaturityEngine(new ProfileRegistry("./profiles"));
  const evidence = [
    { indicator: "identity", value: 100, uri: "ipfs://id", hash: `sha256:${"a".repeat(64)}` },
    { indicator: "data_connection", value: 80, uri: "ipfs://data", hash: `sha256:${"b".repeat(64)}` },
    { indicator: "semantic_model", value: 70 }, { indicator: "provenance", value: 60 }, { indicator: "operational_governance", value: 50 },
  ];

  it("DT-30186-001 loads a versioned profile and evaluates indicators", async () => {
    const result = await engine.evaluate("objectid-maturity-example-v1", evidence);
    expect(result).toMatchObject({ profileVersion: "1.0.0", engineVersion: "1.0.0", score: 74, level: 3 });
  });

  it("DT-30186-002 produces reproducible output and enforces evidence", async () => {
    const one = await engine.evaluate("objectid-maturity-example-v1", evidence);
    const two = await engine.evaluate("objectid-maturity-example-v1", evidence);
    expect(one.evaluationHash).toBe(two.evaluationHash);
    await expect(engine.evaluate("objectid-maturity-example-v1", [{ indicator: "identity", value: 100 }])).rejects.toMatchObject({ code: "MATURITY_EVIDENCE_REQUIRED" });
  });
});
