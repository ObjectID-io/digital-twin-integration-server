import { createRequire } from "node:module";
import { getFullnodeUrl, IotaClient } from "@iota/iota-sdk/client";
import { AppError, mapObjectIdError } from "../common/errors.js";
import type { AppConfig } from "../config/types.js";
import type { CredentialProvider } from "../security/credentials.js";
import type { AccountingContext, DidTwinSummary, IdentifierLookupResult, ObjectIdAdapter, TwinEvent, TwinRoleGrant, TwinStateEvidence } from "./types.js";
import { IotaStatePublisher } from "./iotaStatePublisher.js";

const require = createRequire(import.meta.url);
const { createOid } = require("@objectid/oid-provider/core") as { createOid: () => any };

function fieldsOf(value: any) {
  return value?.data?.content?.fields ?? value?.content?.fields ?? value?.fields ?? {};
}

function objectIdOf(value: any) {
  return String(value?.data?.objectId ?? value?.objectId ?? value?.id ?? value?.node?.address ?? "");
}

export class ProviderObjectIdAdapter implements ObjectIdAdapter {
  private readonly oid: any;
  private readonly statePublisher?: IotaStatePublisher;
  private readonly rpcClient: IotaClient;

  constructor(private readonly config: AppConfig, oid: any = createOid(), credentials?: CredentialProvider, rpcClient?: IotaClient) {
    this.oid = oid;
    this.rpcClient = rpcClient ?? new IotaClient({
      url: config.objectid.rpcUrl || getFullnodeUrl(config.objectid.network as "mainnet" | "testnet" | "devnet" | "localnet"),
    });
    if (config.objectid.signer?.enabled) {
      if (!credentials) throw new AppError("OBJECTID_SIGNER_CREDENTIALS_REQUIRED", "The IOTA signer requires a credential provider", 503, "AUTHORIZATION");
      this.statePublisher = new IotaStatePublisher(config.objectid, credentials, this.rpcClient);
    }
  }

  async initialize() { await this.statePublisher?.initialize(); }

  async getSubscription(accounting?: AccountingContext) {
    if (!this.statePublisher) throw new AppError("OBJECTID_SUBSCRIPTION_UNAVAILABLE", "Subscription accounting requires an enabled signer", 503, "OBJECTID");
    return this.statePublisher.getSubscription(accounting);
  }

  async isReady() {
    try { await this.oid.session.config(this.config.objectid.network); return true; } catch { return false; }
  }

  async getTwin(id: string) { return this.oid.getObject(id, this.config.objectid.network); }

  async findTwinsByDid(did: string): Promise<DidTwinSummary[]> {
    if (!this.config.objectid.packageId) throw new AppError("OBJECTID_PACKAGE_ID_MISSING", "objectid.packageId is required", 503, "OBJECTID");
    const normalizedDid = did.trim();
    const type = `${this.config.objectid.packageId}::oid_twin::OIDTwin`;
    const edges = await this.oid.getObjectsByType(type, this.config.objectid.network);
    const twins = await Promise.all(edges.map(async (edge: any) => {
      const embeddedFields = fieldsOf(edge);
      return Object.keys(embeddedFields).length ? edge : this.oid.getObject(objectIdOf(edge), this.config.objectid.network);
    }));
    return twins.flatMap((raw: any) => {
      const fields = fieldsOf(raw);
      const roleFields = [
        ["owner", fields.owner_did ?? fields.ownerDid],
        ["creator", fields.creator_did ?? fields.creatorDid],
        ["steward", fields.steward_did ?? fields.stewardDid],
        ["twin", fields.twin_did ?? fields.twinDid],
      ] as const;
      const roles = roleFields.filter(([, value]) => String(value ?? "").trim() === normalizedDid).map(([role]) => role);
      if (!roles.length) return [];
      return [{
        twinId: objectIdOf(raw),
        name: String(fields.name ?? ""),
        description: String(fields.description ?? ""),
        lifecycleState: optionalNumber(fields.lifecycle_state ?? fields.lifecycleState),
        revision: optionalNumber(fields.revision),
        roles,
      }];
    }).filter((item) => item.twinId);
  }

  private async mutate(method: string, payload: unknown) {
    const candidate = this.oid[method];
    if (typeof candidate !== "function") {
      throw new AppError(
        "OBJECTID_SDK_METHOD_UNAVAILABLE",
        `ObjectID SDK method '${method}' is unavailable; configure a Digital Twin SDK-capable provider`,
        503,
        "OBJECTID",
      );
    }
    try { return await candidate(payload); } catch (error) { throw mapObjectIdError(error); }
  }

  createTwin(input: unknown, accounting?: AccountingContext) {
    return this.statePublisher ? this.statePublisher.createTwin(asRecord(input), accounting) : this.mutate("createTwin", input);
  }
  updateTwin(id: string, input: unknown, accounting?: AccountingContext) {
    return this.statePublisher ? this.statePublisher.updateTwin(id, asRecord(input), accounting) : this.mutate("updateTwin", { twinId: id, ...asRecord(input) });
  }
  publishState(twinId: string, input: unknown, accounting?: AccountingContext) {
    return this.statePublisher
      ? this.statePublisher.publishState(twinId, asRecord(input), accounting)
      : this.mutate("publishState", { twinId, ...asRecord(input) });
  }
  addDataset(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.addDataset(twinId, asRecord(input), accounting) : this.mutate("addDataset", { twinId, ...asRecord(input) }); }
  addAspect(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.addAspect(twinId, asRecord(input), accounting) : this.mutate("addTwinAspect", { twinId, ...asRecord(input) }); }
  addInterface(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.addInterface(twinId, asRecord(input), accounting) : this.mutate("addTwinInterface", { twinId, ...asRecord(input) }); }
  addModel(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.addModel(twinId, asRecord(input), accounting) : this.mutate("addModel", { twinId, ...asRecord(input) }); }
  addIdentifier(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.addIdentifier(twinId, asRecord(input), accounting) : this.mutate("addIdentifier", { twinId, ...asRecord(input) }); }
  addIdentifierMapping(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.addIdentifierMapping(twinId, asRecord(input), accounting) : this.mutate("addTwinIdentifierMapping", { twinId, ...asRecord(input) }); }
  addRelation(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.addRelation(twinId, asRecord(input), accounting) : this.mutate("addRelation", { twinId, ...asRecord(input) }); }
  createComposition(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.createComposition(twinId, asRecord(input), accounting) : this.mutate("createTwinComposition", { twinId, ...asRecord(input) }); }
  emitTwinEvent(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.emitTwinEvent(twinId, asRecord(input), accounting) : this.mutate("emitTwinEvent", { twinId, ...asRecord(input) }); }
  createMaturityAssessment(twinId: string, input: unknown, accounting?: AccountingContext) { return this.statePublisher ? this.statePublisher.createMaturityAssessment(twinId, asRecord(input), accounting) : this.mutate("createTwinMaturityAssessment", { twinId, ...asRecord(input) }); }

  async getTwinChildren(twinId: string, moveType: string) {
    if (!this.config.objectid.packageId) throw new AppError("OBJECTID_PACKAGE_ID_MISSING", "objectid.packageId is required", 503, "OBJECTID");
    const type = `${this.config.objectid.packageId}::oid_twin::${moveType}`;
    const edges = await this.oid.getObjectsByTypeAndOwner(type, twinId, this.config.objectid.network);
    return Promise.all(edges.map((edge: any) => this.oid.getObject(objectIdOf(edge), this.config.objectid.network)));
  }

  async getTwinEvents(twinId: string): Promise<TwinEvent[]> {
    const objects = await this.getTwinChildren(twinId, "OIDTwinEvent");
    return Promise.all(objects.map(async (raw: any) => {
      const event = eventOf(raw);
      if (!event.transactionDigest && event.eventId) {
        try {
          const object = await this.rpcClient.getObject({ id: event.eventId, options: { showPreviousTransaction: true } });
          event.transactionDigest = object.data?.previousTransaction ?? undefined;
        } catch { /* Event data remains usable when transaction metadata is temporarily unavailable. */ }
      }
      if (event.eventType === 30 && isIotaObjectId(event.payloadRef)) {
        try {
          const state = await this.rpcClient.getObject({ id: event.payloadRef, options: { showContent: true } });
          const fields = fieldsOf(state);
          const content = state.data?.content;
          const moveType = state.data?.type ?? (content?.dataType === "moveObject" ? content.type : undefined);
          if (String(moveType ?? "").endsWith("::oid_twin::OIDTwinState")) event.referencedState = stateEvidenceOf(event.payloadRef, fields);
        } catch { /* The event remains authoritative even if its referenced state cannot be resolved. */ }
      }
      return event;
    }));
  }

  async getDigitalThread(twinId: string) {
    return (await this.getTwinEvents(twinId)).sort((a, b) =>
      a.revisionAfter - b.revisionAfter || a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId));
  }

  async getTwinRoleGrants(twinId: string): Promise<TwinRoleGrant[]> {
    const objects = await this.getTwinChildren(twinId, "OIDTwinRoleGrant");
    return objects.map((raw: any) => {
      const fields = fieldsOf(raw);
      return {
        twinId: String(fields.twin_id ?? twinId),
        subjectDid: String(fields.subject_did ?? ""),
        roleType: fields.role_type as string | number,
        validFrom: Number(fields.valid_from ?? 0),
        validTo: Number(fields.valid_to ?? 0),
      };
    });
  }

  async findTwinByIdentifier(scheme: string, value: string): Promise<IdentifierLookupResult | null> {
    const candidate = this.oid.findTwinByIdentifier ?? this.oid.findObjectByIdentifier;
    if (typeof candidate !== "function") {
      throw new AppError(
        "OBJECTID_IDENTIFIER_INDEXER_REQUIRED",
        "Global identifier resolution requires an ObjectID indexer-capable provider",
        501,
        "OBJECTID",
      );
    }
    const result = await candidate.call(this.oid, { scheme, value, network: this.config.objectid.network });
    if (!result) return null;
    return { twinId: String(result.twinId ?? result.twin_id ?? result.owner ?? ""), identifier: result.identifier ?? result };
  }

  async findMutationByIdempotencyKey(twinId: string, key: string): Promise<boolean | undefined> {
    const candidate = this.oid.findTwinMutationByExternalReference;
    if (typeof candidate !== "function") return undefined;
    return Boolean(await candidate.call(this.oid, { twinId, externalReference: key, network: this.config.objectid.network }));
  }

  async findIdentifierMappings(identifierId: string) {
    const candidate = this.oid.findTwinIdentifierMappings;
    if (typeof candidate !== "function") return [];
    return candidate.call(this.oid, { identifierId, network: this.config.objectid.network });
  }

  async transactionExists(digest: string): Promise<boolean | undefined> {
    const candidate = this.oid.getTransactionBlock ?? this.oid.getTransaction;
    if (typeof candidate !== "function") return undefined;
    try { return Boolean(await candidate.call(this.oid, { digest, network: this.config.objectid.network })); }
    catch (error: any) { if (String(error?.code ?? "").includes("NOT_FOUND")) return false; throw error; }
  }

  async getIndexerCheckpoint() {
    const candidate = this.oid.getIndexerCheckpoint;
    return typeof candidate === "function" ? candidate.call(this.oid, { network: this.config.objectid.network }) : null;
  }

  async resumeIndexer() { if (typeof this.oid.resumeIndexer === "function") await this.oid.resumeIndexer({ network: this.config.objectid.network }); }
  async rebuildIndexer() { if (typeof this.oid.rebuildTwinIndexer === "function") await this.oid.rebuildTwinIndexer({ network: this.config.objectid.network, packageId: this.config.objectid.packageId }); }

  async findIndexedTwinEvents(twinId: string, options: Record<string, unknown>) {
    const candidate = this.oid.findTwinEvents ?? this.oid.getIndexedTwinEvents;
    if (typeof candidate !== "function") {
      throw new AppError("OBJECTID_EVENT_INDEXER_REQUIRED", "Indexed Twin event pagination is unavailable", 501, "OBJECTID");
    }
    const result = await candidate.call(this.oid, { twinId, network: this.config.objectid.network, ...options });
    const rawItems = Array.isArray(result) ? result : result?.items ?? result?.data ?? [];
    const items = rawItems.map((raw: any) => eventOf(raw));
    const nextCursor = result?.nextCursor ?? result?.next_cursor;
    return {
      items, nextCursor: nextCursor ? String(nextCursor) : undefined,
      hasMore: Boolean(result?.hasMore ?? result?.has_more ?? nextCursor),
      complete: result?.complete === undefined ? true : Boolean(result.complete),
      reason: result?.reason ? String(result.reason) : undefined,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function eventOf(raw: any): TwinEvent {
  const fields = fieldsOf(raw);
  return {
    eventId: objectIdOf(raw) || String(raw?.eventId ?? fields.id ?? ""),
    twinId: String(raw?.twinId ?? fields.twin_id ?? ""),
    eventType: Number(raw?.eventType ?? fields.event_type ?? 0),
    revisionBefore: Number(raw?.revisionBefore ?? fields.revision_before ?? 0),
    revisionAfter: Number(raw?.revisionAfter ?? fields.revision_after ?? 0),
    actorDid: String(raw?.actorDid ?? fields.actor_did ?? ""), payloadRef: String(raw?.payloadRef ?? fields.payload_ref ?? ""),
    payloadHash: String(raw?.payloadHash ?? fields.payload_hash ?? ""), createdAt: Number(raw?.createdAt ?? fields.created_at ?? 0),
    transactionDigest: raw?.transactionDigest ?? raw?.previousTransaction ?? raw?.previous_transaction
      ?? raw?.data?.previousTransaction ?? raw?.data?.previous_transaction,
  };
}

function stateEvidenceOf(objectId: string, fields: any): TwinStateEvidence {
  const payloadInline = String(fields.payload_inline ?? "");
  let payload: unknown;
  try { payload = payloadInline ? JSON.parse(payloadInline) : undefined; } catch { payload = payloadInline || undefined; }
  return {
    objectId,
    aspectCode: String(fields.aspect_code ?? ""),
    sampleType: String(fields.sample_type ?? ""),
    sourceUri: String(fields.source_uri ?? ""),
    payloadHash: String(fields.payload_hash ?? ""),
    payloadUri: String(fields.payload_uri ?? ""),
    payloadInline,
    payload,
    observedAt: Number(fields.observed_at ?? 0),
    validFrom: Number(fields.valid_from ?? 0),
    validTo: Number(fields.valid_to ?? 0),
    qualityScore: Number(fields.quality_score ?? 0),
    creatorDid: String(fields.creator_did ?? ""),
    superseded: Boolean(fields.superseded),
  };
}

function isIotaObjectId(value: string) { return /^0x[0-9a-f]{64}$/i.test(value); }

function optionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
