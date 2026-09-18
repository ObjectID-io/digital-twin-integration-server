import { createHash } from "node:crypto";
import { AppError } from "../common/errors.js";
import type { AccountingContext } from "../objectid/types.js";
import type { CredentialProvider } from "../security/credentials.js";
import type { PlantService } from "./service.js";

export const personalPlantId = (ownerDid: string) => `personal-${createHash("sha256").update(ownerDid).digest("hex").slice(0, 32)}`;
export const twinLocalNodeId = (twinId: string) => `twin-${twinId.replace(/^0x/, "")}`;
export function twinFields(raw: any): Record<string, any> { return raw?.data?.content?.fields ?? raw?.content?.fields ?? raw?.fields ?? {}; }
function immutable(fields: Record<string, any>) {
  try { const value = JSON.parse(fields.immutable_metadata || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
export function assertTwinOwner(raw: unknown, accounting: AccountingContext) {
  const f = twinFields(raw);
  if (f.owner_did !== accounting.ownerDid || f.subscription_id !== accounting.subscriptionId) {
    throw new AppError("PLANT_TWIN_OWNER_MISMATCH", "Plant membership requires the Twin's current owner and subscription", 403, "AUTHORIZATION");
  }
}
export async function ownerPlants(service: PlantService, credentials: CredentialProvider, ownerDid: string) {
  const pins = JSON.parse(await credentials.get("DTIS_PLANT_SUPERVISORS") || "{}");
  const scopes = Object.entries(pins).filter(([, did]) => did === ownerDid).map(([scope]) => scope);
  scopes.push(`personal:${ownerDid}`);
  const result = [];
  for (const scope of scopes) for (const plant of await service.list(scope)) {
    if (plant.document.ownerDid && plant.document.ownerDid !== ownerDid) throw new AppError("PLANT_OWNER_MISMATCH", "Stored plant ownership conflicts with its storage scope", 409, "AUTHORIZATION");
    result.push({ ...plant, scope, ownerDid, tenantId: scope.startsWith("personal:") ? null : scope });
  }
  return result;
}
export async function locateTwinPlant(service: PlantService, credentials: CredentialProvider, twinId: string, raw: unknown, accounting: AccountingContext) {
  assertTwinOwner(raw, accounting);
  const meta = immutable(twinFields(raw));
  type Membership = {plantId:string;tenantId:string|null;ownerDid:string;nodeId:any;name:any;storage:string;visibility:string};
  const matches: Membership[] = [];
  const origins: Membership[] = [];
  for (const plant of await ownerPlants(service, credentials, accounting.ownerDid)) {
    const nodes = Object.entries((plant.document.twinIds || {}) as Record<string, string>).filter(([, id]) => id === twinId).map(([id]) => id);
    if (nodes.length > 1) throw new AppError("PLANT_TWIN_BINDING_CONFLICT", "Multiple nodes reference this Twin", 409, "VALIDATION");
    if (nodes.length || (meta.plant_id === plant.id && (meta.tenant_id ?? null) === plant.tenantId)) {
      (nodes.length ? matches : origins).push({ plantId: plant.id, tenantId: plant.tenantId, ownerDid: accounting.ownerDid,
        nodeId: nodes[0] || meta.twinscope_node_id || null,
        name: (plant.document.tree as any)?.name || plant.id, storage: "integration-server", visibility: plant.publication ? "public" : "private" });
    }
  }
  // Explicit operational bindings supersede the personal creation container.
  // Immutable metadata records origin, not a later association.
  const operational = matches.filter(item => item.tenantId !== null);
  const current = operational.length ? operational : matches.length ? matches : origins;
  if (current.length > 1) throw new AppError("PLANT_TWIN_BINDING_CONFLICT", "Multiple plants reference this Twin", 409, "VALIDATION");
  return current[0] || null;
}

/** Metadata-only migration. Never signs an IOTA transaction, transfers a Twin or changes publication. */
export async function migrateTwinPlant(service: PlantService, credentials: CredentialProvider, twinId: string, raw: unknown, accounting: AccountingContext, apply = false) {
  const existing = await locateTwinPlant(service, credentials, twinId, raw, accounting);
  if (existing) return { action: "preserve" as const, ...existing };
  const f = twinFields(raw), meta = immutable(f);
  if (meta.plant_id || meta.tenant_id || f.namespace === "objectid.twinscope") {
    throw new AppError("PLANT_MIGRATION_RECONCILIATION_REQUIRED", "Industrial Twin has no unambiguous existing plant binding; it must not be moved to a personal plant", 409, "VALIDATION");
  }
  const plantId = personalPlantId(accounting.ownerDid), scope = `personal:${accounting.ownerDid}`, nodeId = twinLocalNodeId(twinId);
  if (apply) {
    const previous = (await service.list(scope)).find(p => p.id === plantId);
    const document: any = previous?.document || { ownerDid: accounting.ownerDid, tenantId: null, tree: { id: plantId, name: "Personal plant", type: "site", children: [] }, configs: {}, twinIds: {} };
    if (document.ownerDid !== accounting.ownerDid || document.tenantId !== null) throw new AppError("PLANT_OWNER_MISMATCH", "Personal plant owner mismatch", 409, "AUTHORIZATION");
    const next = { ...document, tree: { ...document.tree, children: [...(document.tree.children || []).filter((n: any) => n.id !== nodeId), { id: nodeId, name: f.name || twinId, type: "asset", children: [] }] },
      twinIds: { ...document.twinIds, [nodeId]: twinId } };
    await service.put(scope, plantId, { revision: previous?.revision || 0, document: next, publication: previous?.publication || null });
  }
  return { action: "personal" as const, plantId, nodeId, tenantId: null, ownerDid: accounting.ownerDid };
}
