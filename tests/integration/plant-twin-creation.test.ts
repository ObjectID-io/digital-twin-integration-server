import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppRuntime } from "../../src/api/app.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

const owner = `did:iota:testnet:0x${"a".repeat(64)}`, operator = `did:iota:testnet:0x${"b".repeat(64)}`;
const subscriptionId = "0x" + "c".repeat(64);
describe("subscription and ownership HTTP boundaries", () => {
  let directory: string, runtime: AppRuntime, key: Buffer, adapter: FakeObjectIdAdapter;
  const input = { plantId: "plant", nodeId: "machine", name: "Mixer" };
  function signed(body: object, id: string, overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({ iss: "twinscope", aud: "dtis-twin-create", sub: operator, tenantId: "industrial", plantId: "plant", nodeId: "machine",
      role: "plant_manager", scopeType: "plant", scopeId: "plant", bodyHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"), jti: id, iat: now, exp: now + 60, ...overrides }, key);
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "plant-creation-test-")); key = randomBytes(32);
    vi.stubEnv("DTIS_PLANT_ACCESS_KEY", key.toString("base64"));
    vi.stubEnv("DTIS_PLANT_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DTIS_PLANT_SUPERVISORS", JSON.stringify({ industrial: owner }));
    vi.stubEnv("DTIS_TENANTS_JSON", JSON.stringify([{ tenantId: "billing-owner", ownerDid: owner, customerId: "customer", subscriptionId, apiKeyHash: createHash("sha256").update("owner-key").digest("hex") }]));
    adapter = new FakeObjectIdAdapter();
    Object.assign(adapter, { getSubscription: vi.fn(async () => ({ objectId: subscriptionId, customerId: "customer", ownerControllerId: "0x" + "a".repeat(64), current: true, remainingTwins: "10", remainingCredits: "10" })) });
    runtime = createApp(testConfig({ dataset: { directory: join(directory, "blobs") },
      objectid: { signer: { enabled: true, delegatedAccounts: true, seedCredential: "UNUSED", addressCredential: "UNUSED", controllerCapCredential: "UNUSED", subscriptionCredential: "UNUSED", clockId: "0x6", gasBudget: 100, gasStations: [] } },
      security: { authMode: "api-key", tenantProvisioning: { enabled: false, provisioningKeyCredential: "UNUSED", dynamicTenantFile: join(directory, "tenants.json") } } }), adapter);
    const now = Math.floor(Date.now() / 1000);
    const bearer = jwt.sign({ iss: "twinscope", aud: "dtis-plants", sub: owner, tenantId: "industrial", role: "tenant_supervisor", iat: now, exp: now + 60, jti: randomUUID() }, key);
    const saved = await request(runtime.app).put("/api/plants/plant").auth(bearer, { type: "bearer" }).send({ revision: 0, publication: null, document: { tree: { id: "plant", children: [{ id: "machine" }] }, twinIds: {} } });
    expect(saved.status).toBe(200);
    expect(saved.body.document.ownerDid).toBe(owner);
  });
  afterEach(async () => { await runtime.stop(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it("an AAA operator without a subscription creates for the plant owner; retries do not sign twice", async () => {
    const send = () => request(runtime.app).post("/api/plants/twins").set("x-twinscope-creation", signed(input, "once")).set("idempotency-key", "once").send(input);
    const first = await send();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ ownerDid: owner, requesterDid: operator, plantId: "plant", tenantId: "industrial" });
    expect((await send()).body).toEqual(first.body);
    expect(adapter.calls.filter(call => call.method === "createTwin")).toHaveLength(1);
  });
  it("a plant read token is not a creation token; altered scope and missing keys fail closed", async () => {
    expect((await request(runtime.app).post("/api/plants/twins").send(input)).status).toBe(401);
    const outside = await request(runtime.app).post("/api/plants/twins").set("idempotency-key", "outside").set("x-twinscope-creation", signed(input, "outside", { scopeId: "other" })).send(input);
    expect(outside.status).toBe(403);
    const changed = await request(runtime.app).post("/api/plants/twins").set("idempotency-key", "changed").set("x-twinscope-creation", signed(input, "changed")).send({ ...input, name: "injected" });
    expect(changed.status).toBe(401);
    expect(adapter.calls).toHaveLength(0);
  });
  it("personal API creates an owner-isolated plant and cannot choose an industrial plant", async () => {
    const personal = await request(runtime.app).post("/api/v1/twins").set("x-api-key", "owner-key").send({ name: "Standalone", tenantId: "injected", ownerDid: operator });
    expect(personal.status).toBe(201);
    expect(personal.body).toMatchObject({ ownerDid: owner, requesterDid: owner, tenantId: null });
    expect(personal.body.plantId).toMatch(/^personal-/);
    expect((await request(runtime.app).post("/api/v1/twins").set("x-api-key", "owner-key").send(input)).status).toBe(403);
  });
});
