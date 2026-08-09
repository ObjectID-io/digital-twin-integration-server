import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

describe("off-chain storage service integration", () => {
  const directory = "./data/test-storage-services";
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("stores model bytes through category routing and registers only URI/hash", async () => {
    const adapter = new FakeObjectIdAdapter();
    adapter.twins.set("0xtwin", { id: "0xtwin" });
    const app = createApp(testConfig({ dataset: { directory } }), adapter).app;
    const response = await request(app).post("/api/v1/twins/0xtwin/models").send({ modelType: "CAD", fileName: "part.step", contentType: "model/step", data: "STEP-BYTES" });
    expect(response.status).toBe(202);
    const payload = adapter.calls.find((call) => call.method === "addModel")!.input as any;
    expect(payload.data).toBeUndefined();
    expect(payload.storageUri).toMatch(/^file:/);
    expect(payload.payloadHash).toMatch(/^sha256:/);
    expect(await readFile(new URL(payload.storageUri), "utf8")).toBe("STEP-BYTES");
  });

  it("stores maturity evidence when inline and preserves external references", async () => {
    const adapter = new FakeObjectIdAdapter();
    adapter.twins.set("0xtwin", { id: "0xtwin" });
    const app = createApp(testConfig({ dataset: { directory } }), adapter).app;
    const response = await request(app).post("/api/v1/twins/0xtwin/maturity/assessments").send({
      maturityLevel: 2,
      evidence: [
        { indicator: "quality", value: 100, data: { passed: true }, fileName: "quality.json" },
        { indicator: "external", value: 80, uri: "https://customer/evidence/1", hash: "sha256:external" },
      ],
    });
    expect(response.status).toBe(202);
    const evidence = (adapter.calls.find((call) => call.method === "createMaturityAssessment")!.input as any).evidence;
    expect(evidence[0]).toMatchObject({ data: undefined, uri: expect.stringMatching(/^file:/), hash: expect.stringMatching(/^sha256:/) });
    expect(evidence[1]).toMatchObject({ uri: "https://customer/evidence/1", hash: "sha256:external" });
  });

  it("reuses the same external storage after a stateless restart", async () => {
    const adapter = new FakeObjectIdAdapter();
    adapter.twins.set("0xtwin", { id: "0xtwin", revision: 1 });
    const config = testConfig({ dataset: { directory } });
    const instanceA = createApp(config, adapter);
    await request(instanceA.app).post("/api/v1/twins/0xtwin/datasets").send({ datasetType: "telemetry", data: [{ value: 42 }] });
    const uri = String((adapter.calls.find((call) => call.method === "addDataset")!.input as any).storageUri);
    const instanceB = createApp(config, adapter);
    expect(await instanceB.storage.read(uri)).toEqual(await readFile(new URL(uri)));
    expect((await request(instanceB.app).get("/api/v1/twins/0xtwin")).body.revision).toBe(1);
  });
});
