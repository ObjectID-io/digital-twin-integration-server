import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

describe("HTTP security", () => {
  afterEach(() => {
    delete process.env.DTIS_API_KEY;
    delete process.env.DTIS_TENANTS_JSON;
    delete process.env.CUSTOMER_A_KEY;
  });
  it("rejects missing and invalid API keys", async () => {
    process.env.DTIS_API_KEY = "valid";
    const app = createApp(testConfig({ security: { ...testConfig().security, authMode: "api-key" } }), new FakeObjectIdAdapter()).app;
    expect((await request(app).get("/api/v1/twins/0x1")).status).toBe(401);
    expect((await request(app).get("/api/v1/twins/0x1").set("x-api-key", "invalid")).status).toBe(401);
  });
  it("rejects an invalid JWT", async () => {
    process.env.DTIS_JWT_SECRET = "test-secret";
    const app = createApp(testConfig({ security: { ...testConfig().security, authMode: "jwt" } }), new FakeObjectIdAdapter()).app;
    const response = await request(app).get("/api/v1/twins/0x1").set("authorization", "Bearer invalid.jwt.token");
    expect(response.status).toBe(401);
    delete process.env.DTIS_JWT_SECRET;
  });
  it("isolates Twin reads by the authenticated tenant subscription", async () => {
    const objectId = (digit: string) => `0x${digit.repeat(64)}`;
    process.env.CUSTOMER_A_KEY = "tenant-a-secret";
    process.env.DTIS_TENANTS_JSON = JSON.stringify({ tenants: [{
      tenantId: "tenant-a", customerId: "customer-a", ownerDid: `did:iota:testnet:${objectId("a")}`,
      subscriptionId: objectId("1"), apiKeyCredential: "CUSTOMER_A_KEY",
    }] });
    const adapter = new FakeObjectIdAdapter();
    adapter.twins.set(objectId("2"), { id: objectId("2"), subscription_id: objectId("1") });
    adapter.twins.set(objectId("3"), { id: objectId("3"), subscription_id: objectId("9") });
    const app = createApp(testConfig({ security: { authMode: "api-key" } }), adapter).app;

    expect((await request(app).get(`/api/v1/twins/${objectId("2")}`).set("x-api-key", "tenant-a-secret")).status).toBe(200);
    expect((await request(app).get(`/api/v1/twins/${objectId("3")}`).set("x-api-key", "tenant-a-secret")).status).toBe(403);
  });
  it("caches connector Twin authorization instead of reading IOTA for every MQTT sample", async () => {
    const objectId = (digit: string) => `0x${digit.repeat(64)}`;
    process.env.CUSTOMER_A_KEY = "tenant-a-secret";
    process.env.DTIS_TENANTS_JSON = JSON.stringify({ tenants: [{
      tenantId: "tenant-a", customerId: "customer-a", ownerDid: `did:iota:testnet:${objectId("a")}`,
      subscriptionId: objectId("1"), apiKeyCredential: "CUSTOMER_A_KEY",
    }] });
    const adapter = new FakeObjectIdAdapter();
    const twinId = objectId("2");
    adapter.twins.set(twinId, { id: twinId, subscription_id: objectId("1") });
    const getTwin = vi.spyOn(adapter, "getTwin");
    const runtime = createApp(testConfig(), adapter);
    const mapping = { topic: "factory/device", twinId, tenantId: "tenant-a", mode: "dataset" as const, datasetType: "telemetry" };

    await runtime.ingestMqttMessage({ mapping, topic: mapping.topic, value: { temperature: 40 }, observedAt: 100 });
    await runtime.ingestMqttMessage({ mapping, topic: mapping.topic, value: { temperature: 41 }, observedAt: 200 });

    expect(getTwin).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized payloads", async () => {
    const app = createApp(testConfig({ server: { ...testConfig().server, bodyLimitBytes: 1024 } }), new FakeObjectIdAdapter()).app;
    const response = await request(app).post("/api/v1/twins").send({ data: "x".repeat(2048) });
    expect(response.status).toBe(413);
  });
  it("reports invalid OME schema through the validation API", async () => {
    const app = createApp(testConfig(), new FakeObjectIdAdapter()).app;
    const response = await request(app).post("/api/v1/profiles/iso23247-ome-v1/validate").send({ profile: "objectid-profile://iso23247/ome/v1", name: "invalid" });
    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(false);
    expect(response.body.errors.length).toBeGreaterThan(0);
  });
});
