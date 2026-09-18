import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import { PlantTwinCreation, verifyCreationAssertion, type CreationContext } from "../../src/plants/twin-creation.js";
import { EnvironmentCredentialProvider } from "../../src/security/credentials.js";

const owner = `did:iota:testnet:0x${"1".repeat(64)}`, operator = `did:iota:testnet:0x${"2".repeat(64)}`;
const accounting = { tenantId: "billing-tenant", customerId: "customer", ownerDid: owner, subscriptionId: "0xsubscription" };
const context: CreationContext = { ownerDid: owner, requesterDid: operator, tenantId: "industrial-tenant", plantId: "plant", nodeId: "machine", source: "twinscope" };
const body = { plantId: "plant", nodeId: "machine", name: "Mixer", ownerDid: operator, subscriptionId: "attacker", immutableMetadata: { owner_did: operator }, mutableMetadata: {} };
function fixture() {
  const documents: any[] = [{ id: "plant", document: { tree: { id: "plant", children: [{ id: "machine", children: [] }] }, twinIds: {} } }];
  const plants = { list: vi.fn(async () => documents), put: vi.fn(async (_scope, id, input) => { const value = { id, ...input }; documents.push(value); return value; }) };
  const twins = { createProfiledTwin: vi.fn(async () => ({ id: "0xtwin" })) };
  const objectid = { getSubscription: vi.fn(async () => ({ objectId: accounting.subscriptionId, customerId: accounting.customerId, ownerControllerId: "0x" + "1".repeat(64), current: true, remainingTwins: "2", remainingCredits: "10" })) };
  const tenants = { findByOwnerDid: vi.fn(async () => accounting) };
  const service = new PlantTwinCreation(plants as any, twins as any, objectid as any, tenants as any);
  return { plants, twins, objectid, tenants, service, documents };
}
describe("plant-owned creation", () => {
  it("uses the owner's subscription, never the requesting operator's injected account", async () => {
    const f = fixture();
    const result = await f.service.delegated(body, context);
    expect(f.tenants.findByOwnerDid).toHaveBeenCalledWith(owner);
    const [input, billed] = f.twins.createProfiledTwin.mock.calls[0] as any;
    expect(billed).toEqual(accounting);
    expect(input.subscriptionId).toBe(accounting.subscriptionId);
    expect(JSON.parse(input.immutableMetadata)).toMatchObject({ owner_did: owner, application_creator_did: operator, plant_id: "plant", tenant_id: "industrial-tenant" });
    expect(result).toMatchObject({ ownerDid: owner, requesterDid: operator });
    expect(JSON.parse(input.mutableMetadata).objectid).toMatchObject({ visibility: "private", dataVisibility: "private" });
  });
  it("rejects another customer's connection, unknown nodes, bound nodes and inactive subscriptions before any transaction", async () => {
    const f = fixture();
    await expect(f.service.delegated(body, context, { ...accounting, ownerDid: operator })).rejects.toMatchObject({ code: "PLANT_CONNECTION_OWNER_MISMATCH" });
    await expect(f.service.delegated(body, { ...context, nodeId: "other" })).rejects.toMatchObject({ code: "PLANT_NODE_NOT_FOUND" });
    f.documents[0].document.twinIds.machine = "existing";
    await expect(f.service.delegated(body, context)).rejects.toMatchObject({ code: "PLANT_NODE_ALREADY_HAS_TWIN" });
    f.objectid.getSubscription.mockResolvedValueOnce({ ...(await f.objectid.getSubscription()), current: false });
    await expect(f.service.delegated(body, context)).rejects.toMatchObject({ code: "OBJECTID_SUBSCRIPTION_CAPACITY_EXHAUSTED" });
    expect(f.twins.createProfiledTwin).not.toHaveBeenCalled();
  });
  it("personal creation requires its own subscription and stores a private owner-isolated plant with null tenant", async () => {
    const f = fixture();
    await expect(f.service.personal({}, operator, accounting)).rejects.toMatchObject({ code: "PERSONAL_SUBSCRIPTION_OWNER_REQUIRED" });
    await expect(f.service.personal({}, owner, undefined)).rejects.toMatchObject({ code: "PERSONAL_SUBSCRIPTION_OWNER_REQUIRED" });
    const created = await f.service.personal({ name: "Standalone" }, owner, accounting);
    expect(created.tenantId).toBeNull();
    expect(created.ownerDid).toBe(owner);
    expect(created.plantId).toMatch(/^personal-/);
    expect(f.plants.put).toHaveBeenCalledWith(`personal:${owner}`, created.plantId, expect.objectContaining({ publication: null, document: expect.objectContaining({ tenantId: null, ownerDid: owner }) }));
    await f.service.personal({ name: "Second" }, owner, accounting);
    expect(f.plants.put).toHaveBeenCalledTimes(1);
  });
});

describe("operation-bound TwinScope assertions", () => {
  const key = Buffer.alloc(32, 7);
  const credentials = new EnvironmentCredentialProvider({ DTIS_PLANT_ACCESS_KEY: key.toString("base64"), DTIS_PLANT_SUPERVISORS: JSON.stringify({ "industrial-tenant": owner }) });
  const token = (overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({ iss: "twinscope", aud: "dtis-twin-create", sub: operator, tenantId: context.tenantId, plantId: "plant", nodeId: "machine",
      role: "plant_manager", scopeType: "plant", scopeId: "plant", bodyHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"), jti: "request", iat: now, exp: now + 60, ...overrides }, key);
  };
  it("resolves owner from the server pin, preserving the authenticated requester", async () => {
    expect(await verifyCreationAssertion(token(), body, "request", credentials)).toEqual(context);
  });
  it("rejects altered bodies, reused request IDs, wrong audience and out-of-scope roles", async () => {
    await expect(verifyCreationAssertion(token(), { ...body, name: "altered" }, "request", credentials)).rejects.toMatchObject({ code: "TWIN_CREATION_ASSERTION_INVALID" });
    await expect(verifyCreationAssertion(token(), body, "different", credentials)).rejects.toMatchObject({ code: "TWIN_CREATION_ASSERTION_INVALID" });
    await expect(verifyCreationAssertion(token({ aud: "dtis-plants" }), body, "request", credentials)).rejects.toMatchObject({ code: "TWIN_CREATION_ASSERTION_INVALID" });
    await expect(verifyCreationAssertion(token({ scopeId: "other-plant" }), body, "request", credentials)).rejects.toMatchObject({ code: "TWIN_CREATION_SCOPE_INVALID" });
    await expect(verifyCreationAssertion(token({ role: "viewer" }), body, "request", credentials)).rejects.toMatchObject({ code: "TWIN_CREATION_SCOPE_INVALID" });
  });
});
