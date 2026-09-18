import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { AppError } from "../common/errors.js";
import type { AccountingContext, ObjectIdAdapter } from "../objectid/types.js";
import { requiredCredential, type CredentialProvider } from "../security/credentials.js";
import type { TenantRegistry } from "../security/tenants.js";
import type { TwinService } from "../twin/service.js";
import type { PlantService } from "./service.js";
import { personalPlantId } from "./twin-membership.js";

const fail = (code: string, status = 403): never => { throw new AppError(code, code, status, "AUTHORIZATION"); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("TWIN_INPUT_INVALID", 400);
  return value as Record<string, any>;
};
function metadata(value: unknown) {
  try { return value ? record(typeof value === "string" ? JSON.parse(value) : value) : {}; }
  catch { return fail("TWIN_METADATA_INVALID", 400); }
}
export interface CreationContext {
  requesterDid: string;
  ownerDid: string;
  tenantId: string | null;
  plantId: string;
  nodeId?: string;
  source: "dt" | "twinscope";
}

/** A narrowly scoped assertion from the trusted TwinScope BFF, after its live AAA check.
 * It cannot be used to read/decrypt plants, edit grants, or choose a subscription. */
export async function verifyCreationAssertion(token: string | undefined, input: unknown, key: string | undefined, credentials: CredentialProvider): Promise<CreationContext> {
  if (!token || !key) return fail("TWIN_CREATION_ASSERTION_REQUIRED", 401);
  const encoded = await requiredCredential(credentials, "DTIS_PLANT_ACCESS_KEY");
  const secret = Buffer.from(encoded, "base64");
  if (secret.length !== 32 || secret.toString("base64") !== encoded) return fail("PLANT_AUTH_CONFIG_INVALID", 503);
  let claims: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: "twinscope", audience: "dtis-twin-create", maxAge: 60 });
    if (typeof verified === "string") throw new Error();
    claims = verified;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat! > now
      || claims.exp! <= claims.iat! || claims.exp! - claims.iat! > 60
      || claims.jti !== key || claims.bodyHash !== hash(JSON.stringify(input))) throw new Error();
  } catch { return fail("TWIN_CREATION_ASSERTION_INVALID", 401); }
  const body = record(input);
  if (typeof claims.sub !== "string" || !/^did:iota:(?:[a-z]+:)?0x[0-9a-f]{64}$/i.test(claims.sub)
    || typeof claims.tenantId !== "string" || !claims.tenantId
    || claims.plantId !== body.plantId || claims.nodeId !== body.nodeId
    || typeof body.plantId !== "string" || !body.plantId || typeof body.nodeId !== "string" || !body.nodeId) return fail("TWIN_CREATION_SCOPE_INVALID");
  const permitted = (claims.role === "tenant_supervisor" && claims.scopeType === "tenant" && claims.scopeId === claims.tenantId)
    || (claims.role === "plant_manager" && claims.scopeType === "plant" && claims.scopeId === body.plantId)
    || (claims.role === "object_creator" && claims.scopeType === "object" && claims.scopeId === body.nodeId);
  if (!permitted) return fail("TWIN_CREATION_SCOPE_INVALID");
  let pins: Record<string, unknown>;
  try { pins = record(JSON.parse(await requiredCredential(credentials, "DTIS_PLANT_SUPERVISORS"))); }
  catch { return fail("PLANT_AUTH_CONFIG_INVALID", 503); }
  const owner = Object.hasOwn(pins, claims.tenantId) ? pins[claims.tenantId] : undefined;
  if (typeof owner !== "string" || !/^did:iota:(?:[a-z]+:)?0x[0-9a-f]{64}$/i.test(owner)) return fail("PLANT_OWNER_NOT_CONFIGURED");
  return { requesterDid: claims.sub, ownerDid: owner, tenantId: claims.tenantId, plantId: body.plantId, nodeId: body.nodeId, source: "twinscope" };
}

export class PlantTwinCreation {
  constructor(private readonly plants: PlantService, private readonly twins: TwinService,
    private readonly objectid: ObjectIdAdapter, private readonly tenants: TenantRegistry) {}

  async personal(input: unknown, subject: string | undefined, accounting: AccountingContext | undefined, prepareOnly = false) {
    if (!accounting || subject !== accounting.ownerDid) return fail("PERSONAL_SUBSCRIPTION_OWNER_REQUIRED");
    await this.subscription(accounting);
    const body = record(input);
    const scope = `personal:${accounting.ownerDid}`;
    const defaultId = personalPlantId(accounting.ownerDid);
    const plantId = body.plantId || defaultId;
    if (typeof plantId !== "string") return fail("PLANT_INPUT_INVALID", 400);
    let plant = (await this.plants.list(scope)).find(item => item.id === plantId);
    if (!plant && plantId === defaultId) {
      try {
        plant = await this.plants.put(scope, plantId, { revision: 0, publication: null,
          document: { ownerDid: accounting.ownerDid, tenantId: null, tree: { id: plantId, name: "Personal plant", type: "site", children: [] }, twinIds: {}, configs: {} } });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "PLANT_REVISION_CONFLICT") throw error;
        plant = (await this.plants.list(scope)).find(item => item.id === plantId);
      }
    }
    if (!plant || plant.document.ownerDid !== accounting.ownerDid || plant.document.tenantId !== null) return fail("PLANT_OWNER_MISMATCH");
    if (prepareOnly) return { plantId,ownerDid:accounting.ownerDid,requesterDid:accounting.ownerDid,tenantId:null,source:"dt",twinId:undefined };
    return this.create(body, accounting, { requesterDid: accounting.ownerDid, ownerDid: accounting.ownerDid, tenantId: null, plantId, source: "dt" });
  }

  async delegated(input: unknown, context: CreationContext, connectionAccounting?: AccountingContext, prepareOnly = false) {
    const accounting = await this.tenants.findByOwnerDid(context.ownerDid);
    if (!accounting) return fail("PLANT_OWNER_SUBSCRIPTION_NOT_CONFIGURED", 402);
    // A supplied connection key must belong to this owner, never to the operator or a different customer.
    if (connectionAccounting && (connectionAccounting.ownerDid !== context.ownerDid || connectionAccounting.subscriptionId !== accounting.subscriptionId)) return fail("PLANT_CONNECTION_OWNER_MISMATCH");
    await this.subscription(accounting);
    const plant = (await this.plants.list(context.tenantId!)).find(item => item.id === context.plantId);
    if (!plant) return fail("PLANT_NOT_FOUND", 404);
    // Existing documents are anchored by the pinned owner; explicit ownership cannot override that pin.
    if (plant.document.ownerDid && plant.document.ownerDid !== context.ownerDid) return fail("PLANT_OWNER_MISMATCH");
    const contains = (node: any): boolean => Boolean(node && node.type !== "document" && (node.id === context.nodeId || (Array.isArray(node.children) && node.children.some(contains))));
    if (!contains(plant.document.tree)) return fail("PLANT_NODE_NOT_FOUND", 404);
    const bindings = plant.document.twinIds as Record<string, unknown> | undefined;
    if (bindings?.[context.nodeId!]) return fail("PLANT_NODE_ALREADY_HAS_TWIN", 409);
    if (prepareOnly) return { ...context,twinId:undefined };
    return this.create(record(input), accounting, context);
  }

  private async subscription(accounting: AccountingContext) {
    if (!this.objectid.getSubscription) return fail("SUBSCRIPTION_VERIFICATION_UNAVAILABLE", 503);
    const subscription = await this.objectid.getSubscription(accounting);
    if (subscription.objectId.toLowerCase() !== accounting.subscriptionId.toLowerCase() || subscription.customerId !== accounting.customerId
      || !subscription.ownerControllerId || accounting.ownerDid.split(":").at(-1)?.toLowerCase() !== subscription.ownerControllerId.toLowerCase()) return fail("SUBSCRIPTION_OWNER_MISMATCH");
    if (!subscription.current || BigInt(subscription.remainingTwins) < 1n || BigInt(subscription.remainingCredits) < 1n) return fail("OBJECTID_SUBSCRIPTION_CAPACITY_EXHAUSTED", 402);
  }

  private async create(body: Record<string, any>, accounting: AccountingContext, context: CreationContext) {
    const immutable = { ...metadata(body.immutableMetadata ?? body.immutable_metadata),
      application_creator_did: context.requesterDid, owner_did: context.ownerDid,
      tenant_id: context.tenantId, plant_id: context.plantId, creation_source: context.source,
      ...(context.nodeId ? { nodeId: context.nodeId, twinscope_node_id: context.nodeId } : {}) };
    const mutable = metadata(body.mutableMetadata ?? body.mutable_metadata);
    // Explicit public visibility is respected only on the personal path; delegation creates private Twins.
    const visibility = context.source === "dt" && body.visibility === "public" ? "public" : "private";
    const dataVisibility = visibility === "public" && body.dataVisibility === "public" ? "public" : "private";
    const liveLocationVisibility = visibility === "public" && body.liveLocationVisibility === "public" ? "public" : "private";
    const safe: Record<string, any> = { ...body, ownerDid: context.ownerDid, requesterDid: context.requesterDid,
      subscriptionId: accounting.subscriptionId, plantId: context.plantId, tenantId: context.tenantId,
      immutableMetadata: JSON.stringify(immutable), visibility, dataVisibility, liveLocationVisibility,
      mutableMetadata: JSON.stringify({ ...mutable, objectid: { ...metadata(mutable.objectid), visibility, dataVisibility, liveLocationVisibility } }) };
    delete safe.immutable_metadata; delete safe.mutable_metadata;
    const created = await this.twins.createProfiledTwin(safe, accounting) as Record<string, unknown>;
    return { ...created, twinId: created.twinId ?? created.id, ...context };
  }
}
