import { describe, expect, it, vi } from "vitest";
import { migrateTwinPlant, locateTwinPlant, personalPlantId } from "../../src/plants/twin-membership.js";
import { EnvironmentCredentialProvider } from "../../src/security/credentials.js";

const owner = `did:iota:testnet:0x${"1".repeat(64)}`;
const account = { ownerDid: owner, tenantId: "billing", customerId: "customer", subscriptionId: "sub" };
const raw = { fields: { owner_did: owner, subscription_id: "sub", name: "Machine", immutable_metadata: "{}" } };
function fixture() {
  const rows: Record<string, any[]> = {};
  const service = { list: vi.fn(async (scope: string) => structuredClone(rows[scope] || [])), put: vi.fn(async (scope: string, id: string, input: any) => {
    const row = { id, ...structuredClone(input), revision: input.revision + 1 };
    rows[scope] = [...(rows[scope] || []).filter(p => p.id !== id), row]; return row;
  }) };
  const credentials = new EnvironmentCredentialProvider({ DTIS_PLANT_SUPERVISORS: JSON.stringify({ industry: owner }) });
  return { rows, service, credentials, migrate: (id = "0xtwin", data: any = raw, apply = true) => migrateTwinPlant(service as any, credentials, id, data, account, apply) };
}
describe("legacy Twin plant migration", () => {
  it("uses the current operational association instead of the personal creation origin",async()=>{
    const f=fixture(),id=personalPlantId(owner);
    f.rows[`personal:${owner}`]=[{id,document:{ownerDid:owner,twinIds:{legacy:'0xtwin'}}}];
    f.rows.industry=[{id:'factory',document:{ownerDid:owner,tree:{name:'Factory'},twinIds:{machine:'0xtwin'}}}];
    const twin={fields:{...raw.fields,immutable_metadata:JSON.stringify({plant_id:id,tenant_id:null})}};
    expect(await locateTwinPlant(f.service as any,f.credentials,'0xtwin',twin,account)).toMatchObject({plantId:'factory',tenantId:'industry',nodeId:'machine'});
  });
  it("dry runs without writes and applies idempotently with a null organizational tenant", async () => {
    const f = fixture();
    expect(await f.migrate("0xtwin", raw, false)).toMatchObject({ action: "personal", tenantId: null });
    expect(f.service.put).not.toHaveBeenCalled();
    await f.migrate();
    expect(await f.migrate()).toMatchObject({ action: "preserve", tenantId: null, visibility: "private" });
    expect(f.service.put).toHaveBeenCalledTimes(1);
    await f.migrate("0xsecond");
    expect(f.rows[`personal:${owner}`]).toHaveLength(1);
    expect(Object.keys(f.rows[`personal:${owner}`]![0].document.twinIds)).toHaveLength(2);
  });
  it("preserves existing industrial bindings, documents and publication", async () => {
    const f = fixture();
    f.rows.industry = [{ id: "plant", revision: 8, publication: { name: "Public" }, document: { tree: { name: "Factory" }, twinIds: { machine: "0xtwin" }, documents: [{ name: "Manual" }] } }];
    const before = structuredClone(f.rows);
    expect(await f.migrate()).toMatchObject({ action: "preserve", plantId: "plant", nodeId: "machine", visibility: "public" });
    expect(f.rows).toEqual(before);
    expect(f.service.put).not.toHaveBeenCalled();
  });
  it("rejects a foreign chain owner or subscription and unresolved industrial metadata", async () => {
    const f = fixture();
    for (const override of [{ owner_did: "other" }, { subscription_id: "other" }]) await expect(f.migrate("0xtwin", { fields: { ...raw.fields, ...override } })).rejects.toMatchObject({ code: "PLANT_TWIN_OWNER_MISMATCH" });
    await expect(f.migrate("0xtwin", { fields: { ...raw.fields, immutable_metadata: '{"plant_id":"missing"}' } })).rejects.toMatchObject({ code: "PLANT_MIGRATION_RECONCILIATION_REQUIRED" });
    expect(f.service.put).not.toHaveBeenCalled();
  });
  it("rejects ambiguous bindings without changing either plant", async () => {
    const f = fixture();
    f.rows.industry = ["first", "second"].map(id => ({ id, document: { twinIds: { machine: "0xtwin" } } }));
    await expect(f.migrate()).rejects.toMatchObject({ code: "PLANT_TWIN_BINDING_CONFLICT" });
    expect(f.service.put).not.toHaveBeenCalled();
  });
  it("resolves newly created personal Twins from immutable membership without rewriting IOTA", async () => {
    const f = fixture(), id = personalPlantId(owner);
    f.rows[`personal:${owner}`] = [{ id, document: { ownerDid: owner, tenantId: null, tree: { name: "Personal plant" } } }];
    const twin = { fields: { ...raw.fields, immutable_metadata: JSON.stringify({ plant_id: id, tenant_id: null }) } };
    expect(await locateTwinPlant(f.service as any, f.credentials, "0xnew", twin, account)).toMatchObject({ plantId: id, tenantId: null, ownerDid: owner });
    expect(f.service.put).not.toHaveBeenCalled();
  });
});
