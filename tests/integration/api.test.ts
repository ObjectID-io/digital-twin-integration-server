import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { rm } from "node:fs/promises";
import { createApp } from "../../src/api/app.js";
import { AppError } from "../../src/common/errors.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

describe("HTTP integration", () => {
  const dataDirectory = "./data/test-api";
  let adapter: FakeObjectIdAdapter;
  beforeEach(() => { adapter = new FakeObjectIdAdapter(); adapter.twins.set("0xtwin", { id: "0xtwin", revision: 2 }); });
  afterEach(async () => { await rm(dataDirectory, { recursive: true, force: true }); });

  it("serves health, readiness and OpenAPI", async () => {
    const app = createApp(testConfig({ dataset: { directory: dataDirectory } }), adapter).app;
    expect((await request(app).get("/health")).status).toBe(200);
    expect((await request(app).get("/ready")).body.ready).toBe(true);
    expect((await request(app).get("/openapi.json")).body.openapi).toBe("3.0.3");
  });

  it("processes REST dataset, hashes it and delegates to ObjectID", async () => {
    const app = createApp(testConfig({ dataset: { directory: dataDirectory } }), adapter).app;
    const response = await request(app).post("/api/v1/twins/0xtwin/datasets").send({ datasetType: "telemetry", data: [{ value: 42 }] });
    expect(response.status).toBe(202);
    const call = adapter.calls.find((item) => item.method === "addDataset")!;
    expect((call.input as any).payloadHash).toMatch(/^sha256:/);
    expect((call.input as any).storageUri).toMatch(/^file:/);
  });

  it("maps an incoming state request to ObjectID", async () => {
    const app = createApp(testConfig(), adapter).app;
    const response = await request(app).post("/api/v1/twins/0xtwin/states").send({ aspectCode: "telemetry", sampleType: "observed", payloadInline: "42" });
    expect(response.status).toBe(202);
    expect(adapter.calls.at(-1)?.method).toBe("publishState");
  });

  it("returns and verifies a Digital Thread", async () => {
    adapter.setChildren("0xtwin", "OIDTwinEvent", [
      { eventId: "e1", twinId: "0xtwin", eventType: 1, revisionBefore: 0, revisionAfter: 1, actorDid: "did:a", payloadRef: "0xtwin", payloadHash: "", createdAt: 1 },
      { eventId: "e2", twinId: "0xtwin", eventType: 60, revisionBefore: 1, revisionAfter: 2, actorDid: "did:a", payloadRef: "ipfs://model", payloadHash: `sha256:${"a".repeat(64)}`, createdAt: 2 },
    ]);
    const app = createApp(testConfig(), adapter).app;
    const response = await request(app).get("/api/v1/twins/0xtwin/thread/verify");
    expect(response.status).toBe(200); expect(response.body.valid).toBe(true);
    const report = await request(app).get("/api/v1/twins/0xtwin/thread/verify/report");
    expect(report.body).toMatchObject({ twinId: "0xtwin", verifierVersion: "1.1.0", verification: { valid: true } });
  });

  it("serves the Digital Thread through the on-chain fallback", async () => {
    const chainOnly = new ChainOnlyAdapter();
    chainOnly.twins.set("0xtwin", { id: "0xtwin", revision: 1 });
    chainOnly.setChildren("0xtwin", "OIDTwinEvent", [
      { eventId: "e1", twinId: "0xtwin", eventType: 1, revisionBefore: 0, revisionAfter: 1, actorDid: "did:a", payloadRef: "0xtwin", payloadHash: "", createdAt: 1 },
    ]);
    const app = createApp(testConfig(), chainOnly).app;

    const response = await request(app).get("/api/v1/twins/0xtwin/thread");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ items: [{ eventId: "e1" }], hasMore: false, complete: true });
    expect(chainOnly.getDigitalThreadCalls).toBe(1);
  });

  it("validates an OME payload through the profile API", async () => {
    adapter.setChildren("0xtwin", "OIDTwinAspect", [{ fields: { aspect_code: "iso23247_ome", schema_uri: "objectid-profile://iso23247/ome/v1", semantic_ref: "ISO23247:OME" } }]);
    const app = createApp(testConfig(), adapter).app;
    const response = await request(app).post("/api/v1/twins/0xtwin/validate-profile").send({
      profile: "iso23247-ome-v1",
      payload: { profile: "objectid-profile://iso23247/ome/v1", twinType: "equipment", name: "Motor 1" },
    });
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ profile: "iso23247-ome-v1", version: "1.0.0", valid: true, errors: [] });
  });

  it("creates an explicit OME Aspect binding and validates it in Twin context", async () => {
    const app = createApp(testConfig(), adapter).app;
    const payload = { profile: "objectid-profile://iso23247/ome/v1", twinType: "equipment", name: "Motor 1" };
    const created = await request(app).post("/api/v1/twins").send({ id: "0xome", ...payload });
    expect(created.status).toBe(201);
    const aspects = await adapter.getTwinChildren("0xome", "OIDTwinAspect");
    expect(aspects).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ aspect_code: "iso23247_ome", schema_uri: payload.profile, semantic_ref: "ISO23247:OME" }) }));
    const validation = await request(app).post("/api/v1/twins/0xome/validate-profile").send({ profile: "iso23247-ome-v1", payload });
    expect(validation.body.valid).toBe(true);
  });

  it("replays identical idempotent mutations without a second ObjectID call", async () => {
    const app = createApp(testConfig(), adapter).app;
    const first = await request(app).post("/api/v1/twins/0xtwin/states").set("Idempotency-Key", "state-1").send({ value: 1 });
    const second = await request(app).post("/api/v1/twins/0xtwin/states").set("Idempotency-Key", "state-1").send({ value: 1 });
    expect(first.status).toBe(202); expect(second.body).toEqual(first.body);
    expect(adapter.calls.filter((item) => item.method === "publishState")).toHaveLength(1);
  });
});

class ChainOnlyAdapter extends FakeObjectIdAdapter {
  async findIndexedTwinEvents(): Promise<never> {
    throw new AppError("OBJECTID_EVENT_INDEXER_REQUIRED", "No proprietary indexer", 501, "OBJECTID");
  }
}
