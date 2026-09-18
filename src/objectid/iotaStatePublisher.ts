import { createHash } from "node:crypto";
import { getFullnodeUrl, IotaClient, type IotaTransactionBlockResponse } from "@iota/iota-sdk/client";
import { Ed25519Keypair } from "@iota/iota-sdk/keypairs/ed25519";
import { Transaction, type TransactionArgument } from "@iota/iota-sdk/transactions";
import { AppError, mapObjectIdError } from "../common/errors.js";
import { logger } from "../common/logger.js";
import type { AppConfig } from "../config/types.js";
import { requiredCredential, type CredentialProvider } from "../security/credentials.js";
import type { AccountingContext, SubscriptionStatus } from "./types.js";
import { SponsoredTransactionExecutor, type GasStationConnection } from "./sponsoredTransactionExecutor.js";
import { planCleanup, type CleanupChild } from "./twinCleanup.js";

type ObjectIdConfig = AppConfig["objectid"];

interface SignerObjects {
  controllerCapId: string;
  defaultSubscriptionId: string;
}

/** Direct writer for the subscription-based oid_twin ABI. All gas is sponsored by ObjectID Gas Station. */
export class IotaStatePublisher {
  private readonly client: IotaClient;
  private objects?: SignerObjects;
  private executor?: SponsoredTransactionExecutor;
  private readonly deleting = new Set<string>();

  constructor(private readonly config: ObjectIdConfig, private readonly credentials: CredentialProvider, client?: IotaClient) {
    this.client = client ?? new IotaClient({ url: config.rpcUrl || getFullnodeUrl(config.network as "mainnet" | "testnet" | "devnet" | "localnet") });
  }

  async initialize() {
    const signer = this.requiredSignerConfig();
    const [seedValue, expectedAddress, controllerCapId, subscriptionId, ...tokens] = await Promise.all([
      requiredCredential(this.credentials, signer.seedCredential),
      requiredCredential(this.credentials, signer.addressCredential),
      requiredCredential(this.credentials, signer.controllerCapCredential),
      requiredCredential(this.credentials, signer.subscriptionCredential),
      ...signer.gasStations.map((station) => requiredCredential(this.credentials, station.tokenCredential)),
    ]);
    const seed = seedValue.startsWith("0x") ? seedValue.slice(2) : seedValue;
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new AppError("OBJECTID_SIGNER_SEED_INVALID", "DTIS_IOTA_SEED must contain exactly 64 hexadecimal characters", 503, "AUTHORIZATION");
    }
    const keypair = Ed25519Keypair.deriveKeypairFromSeed(seed);
    const derivedAddress = keypair.toIotaAddress().toLowerCase();
    if (derivedAddress !== expectedAddress.toLowerCase()) {
      throw new AppError(
        "OBJECTID_SIGNER_ADDRESS_MISMATCH",
        "The address derived from DTIS_IOTA_SEED does not match DTIS_SIGNER_ADDRESS",
        503,
        "AUTHORIZATION",
        { derivedAddress, expectedAddress },
      );
    }
    const stations: GasStationConnection[] = signer.gasStations.map((station, index) => ({
      url: station.url,
      token: tokens[index]!,
      reserveDurationSeconds: station.reserveDurationSeconds ?? 30,
    }));
    this.objects = { controllerCapId, defaultSubscriptionId: subscriptionId };
    this.executor = new SponsoredTransactionExecutor(this.client, keypair, stations, signer.gasBudget, this.config.timeoutMs);
    logger.info({ address: derivedAddress, network: this.config.network, subscriptionId, gasStations: stations.length }, "iota_twin_writer_ready");
  }

  async createTwin(input: Record<string, unknown>, accounting?: AccountingContext) {
    if (accounting && !this.requiredSignerConfig().delegatedAccounts) {
      throw new AppError("DELEGATED_SIGNER_REQUIRED", "Customer Twins must be created for the subscription owner, not for the technical signer", 503, "AUTHORIZATION");
    }
    const subscriptionId = await this.subscriptionIdFor(accounting);
    const subscription = await this.readSubscription(subscriptionId);
    this.assertTenantSubscription(subscription, accounting);
    if (!subscription.current || BigInt(subscription.remainingTwins) < 1n || BigInt(subscription.remainingCredits) < 1n) {
      throw new AppError("OBJECTID_SUBSCRIPTION_CAPACITY_EXHAUSTED", "The tenant subscription cannot create another Twin", 402, "AUTHORIZATION", { subscriptionId });
    }
    const functionName = this.requiredSignerConfig().delegatedAccounts ? "create_twin_for_subscription_owner" : "create_twin";
    const result = await this.execute("create_twin", (tx) => {
      const targetObjectId = optionalObjectId(value(input, "targetObjectId", "target_object_id"));
      tx.moveCall({ target: this.target(functionName), arguments: [
        ...this.accountArguments(tx, subscriptionId),
        tx.pure.string(requiredString(value(input, "twinType", "twin_type"), "twinType")),
        tx.pure.string(stringValue(value(input, "targetKind", "target_kind"), "asset")),
        tx.pure.option("address", targetObjectId),
        tx.pure.string(stringValue(value(input, "targetDid", "target_did"), "")),
        tx.pure.u8(unsignedInteger(value(input, "lifecycleState", "lifecycle_state"), 1)),
        tx.pure.u8(unsignedInteger(value(input, "fidelityLevel", "fidelity_level"), 1)),
        tx.pure.u8(unsignedInteger(value(input, "maturityLevel", "maturity_level"), 1)),
        tx.pure.string(requiredString(input.name, "name")),
        tx.pure.string(stringValue(input.description, "")),
        tx.pure.string(stringValue(input.namespace, "default")),
        tx.pure.string(metadataValue(value(input, "immutableMetadata", "immutable_metadata"))),
        tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
        tx.object(this.requiredSignerConfig().clockId),
      ] });
    });
    const created = result.objectChanges?.find((change: any) => change.type === "created" && String(change.objectType ?? "").endsWith("::oid_twin::OIDTwin")) as any;
    if (!created?.objectId) throw new AppError("OBJECTID_TWIN_CREATE_RESULT_INVALID", "create_twin succeeded without a created OIDTwin object", 502, "OBJECTID", { digest: result.digest });
    return { id: created.objectId, digest: result.digest, transaction: result };
  }

  async deleteTwin(twinId: string, accounting?: AccountingContext) {
    return this.cleanupTwin(twinId, accounting, false);
  }

  async deleteTwinEvents(twinId: string, accounting?: AccountingContext) {
    return this.cleanupTwin(twinId, accounting, true);
  }

  private async cleanupTwin(twinId: string, accounting: AccountingContext | undefined, eventsOnly: boolean) {
    const id = requiredObjectId(twinId, "twinId").toLowerCase();
    if (this.deleting.has(id)) throw new AppError("OBJECTID_DELETION_IN_PROGRESS", "Twin cleanup is already running; retry after it completes", 409, "OBJECTID");
    this.deleting.add(id);
    try {
      const subscriptionId = await this.subscriptionIdFor(accounting);
      await this.validateTwinAccounting(id, subscriptionId, accounting, true);
      const initial = await this.cleanupSnapshot(id);
      // Legacy mainnet remains on its original ABI until separately published.
      if (!initial.fresh) {
        if (eventsOnly) throw new AppError("OBJECTID_CLEANUP_UNSUPPORTED", "Bulk event cleanup requires the new contract", 409, "OBJECTID");
        const result = await this.twinCall("delete_twin", id, () => [], accounting);
        return { id, deleted: true, digest: result.digest, transaction: result };
      }
      planCleanup(initial.children, this.config.packageId!);
      if (!eventsOnly && (!initial.prepared || initial.children.some(c => c.type.endsWith("::OIDTwinEvent")))) {
        throw new AppError("OBJECTID_EVENTS_CLEANUP_REQUIRED", "Delete all events using the authorized bulk action before deleting the Twin", 409, "OBJECTID");
      }
      const call = (name: string, ids: string[] = []) => this.execute(name, tx => {
        tx.moveCall({ target: this.target(name), arguments: [
          ...this.accountArguments(tx, subscriptionId), tx.object(id), ...ids.map(child => tx.object(child)),
          tx.object(this.requiredSignerConfig().clockId),
        ] });
      });
      if (!initial.prepared) await call("prepare_delete_twin");
      for (let batch = 0; batch < 256; batch++) {
        const snapshot = await this.cleanupSnapshot(id);
        if (eventsOnly) {
          const events = snapshot.children.filter(c => c.type === `${this.config.packageId}::oid_twin::OIDTwinEvent`);
          if (!events.length) return { id, eventsDeleted: true, deletionPrepared: true };
          await this.execute("cleanup_twin_events", tx => {
            for (const event of events.slice(0, 16)) tx.moveCall({ target: this.target("remove_event"), arguments: [
              ...this.accountArguments(tx, subscriptionId), tx.object(id), tx.object(event.id), tx.object(this.requiredSignerConfig().clockId),
            ] });
          });
          continue;
        }
        if (snapshot.children.length === 0) {
          const result = await call("delete_twin");
          return { id, deleted: true, digest: result.digest, transaction: result };
        }
        const planned = planCleanup(snapshot.children, this.config.packageId!);
        await this.execute("cleanup_twin", tx => {
          for (const step of planned) tx.moveCall({ target: this.target(step.name), arguments: [
            ...this.accountArguments(tx, subscriptionId), tx.object(id), ...step.ids.map(child => tx.object(child)),
            tx.object(this.requiredSignerConfig().clockId),
          ] });
        });
      }
      throw new AppError("OBJECTID_CLEANUP_RETRY_REQUIRED", "Cleanup is partially complete. Retry deletion to resume safely.", 409, "OBJECTID");
    } finally { this.deleting.delete(id); }
  }

  private async cleanupSnapshot(id: string) {
    const root = await this.client.getObject({ id, options: { showContent: true, showType: true } });
    if (root.data?.type !== `${this.config.packageId}::oid_twin::OIDTwin` || root.data.content?.dataType !== "moveObject") {
      throw new AppError("OBJECTID_TWIN_PACKAGE_MISMATCH", "Twin is not part of the configured package", 409, "OBJECTID");
    }
    const fields = root.data.content.fields as Record<string, any>;
    if (fields.version === undefined) return { fresh: false, prepared: false, children: [] as CleanupChild[] };
    if (String(fields.version) !== "1") throw new AppError("OBJECTID_TWIN_VERSION_INVALID", "Unsupported Twin version", 409, "OBJECTID");
    const table = fields.children?.fields;
    const tableId = table?.id?.id;
    if (!tableId) throw new AppError("OBJECTID_CHILD_REGISTRY_INVALID", "Twin child registry missing", 502, "OBJECTID");
    const ids: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.client.getDynamicFields({ parentId: tableId, cursor, limit: 50 });
      for (const entry of page.data) ids.push(requiredObjectId(entry.name.value, "registeredChild"));
      cursor = page.hasNextPage ? page.nextCursor : null;
      if (page.hasNextPage && !cursor) throw new Error("Incomplete child registry page");
    } while (cursor);
    if (BigInt(ids.length) !== BigInt(table.size) || new Set(ids).size !== ids.length) throw new AppError("OBJECTID_CHILD_REGISTRY_INCOMPLETE", "Child registry is not yet consistent; retry deletion", 409, "OBJECTID");
    const children: CleanupChild[] = [];
    for (let start = 0; start < ids.length; start += 50) {
      for (const child of await this.client.multiGetObjects({ ids: ids.slice(start, start + 50), options: { showContent: true, showType: true, showOwner: true } })) {
        if (!child.data || child.data.content?.dataType !== "moveObject") throw new Error("Registered child unavailable; retry deletion");
        const owner = child.data.owner;
        if (!owner || typeof owner !== "object" || !("AddressOwner" in owner) || owner.AddressOwner !== id) throw new Error("Registered child ownership mismatch");
        children.push({ id: child.data.objectId, type: child.data.type!, fields: child.data.content.fields as Record<string, any> });
      }
    }
    return { fresh: true, prepared: fields.deletion_prepared === true, children };
  }

  async getSubscription(accounting?: AccountingContext): Promise<SubscriptionStatus> {
    const subscriptionId = await this.subscriptionIdFor(accounting);
    const status = await this.readSubscription(subscriptionId);
    this.assertTenantSubscription(status, accounting);
    return status;
  }

  private async readSubscription(subscriptionId: string): Promise<SubscriptionStatus> {
    const object = await this.client.getObject({ id: subscriptionId, options: { showContent: true, showType: true } });
    if (object.error) throw new AppError("OBJECTID_SUBSCRIPTION_NOT_FOUND", "The configured SubscriptionAccount could not be read", 503, "OBJECTID", { objectId: subscriptionId });
    if (object.data?.type !== `${this.config.packageId}::oid_twin::SubscriptionAccount`) {
      throw new AppError("OBJECTID_SUBSCRIPTION_TYPE_INVALID", "The configured subscription object is not a SubscriptionAccount", 503, "OBJECTID", { objectId: subscriptionId });
    }
    const content = object.data?.content;
    const fields = content?.dataType === "moveObject" ? content.fields as Record<string, unknown> : {};
    const periodStart = decimalField(fields.period_start);
    const periodEnd = decimalField(fields.period_end);
    const twinLimit = decimalField(fields.twin_limit);
    const activeTwinCount = decimalField(fields.active_twin_count);
    const creditLimit = decimalField(fields.credit_limit);
    const creditsUsed = decimalField(fields.credits_used);
    const status = Number(fields.status ?? -1);
    const now = BigInt(Date.now());
    return {
      objectId: subscriptionId,
      customerId: String(fields.customer_id ?? ""),
      ownerControllerId: String(fields.owner_controller_id ?? fields.controller_id ?? ""),
      controllerId: String(fields.controller_id ?? ""),
      plan: { code: Number(fields.plan ?? -1), name: planName(Number(fields.plan ?? -1)) },
      status: { code: status, name: subscriptionStatusName(status) },
      periodStart,
      periodEnd,
      twinLimit,
      activeTwinCount,
      remainingTwins: subtractFloor(twinLimit, activeTwinCount),
      creditLimit,
      creditsUsed,
      remainingCredits: subtractFloor(creditLimit, creditsUsed),
      current: status === 1 && now >= BigInt(periodStart) && now < BigInt(periodEnd),
      updatedAt: decimalField(fields.updated_at),
    };
  }

  updateTwin(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("update_twin_metadata", twinId, (tx) => [
      tx.pure.string(requiredString(input.name, "name")),
      tx.pure.string(stringValue(input.description, "")),
      tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
    ], accounting);
  }

  publishState(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    const payloadInline = stringValue(value(input, "payloadInline", "payload_inline"), "");
    const payloadHash = canonicalPayloadHash(stringValue(
      value(input, "payloadHash", "payload_hash"),
      createHash("sha256").update(payloadInline).digest("hex"),
    ));
    const observedAt = unsignedInteger(value(input, "observedAt", "observed_at"), Date.now());
    const qualityScore = unsignedInteger(value(input, "qualityScore", "quality_score"), 100);
    if (qualityScore > 100) throw new AppError("OBJECTID_STATE_QUALITY_INVALID", "qualityScore must be between 0 and 100", 422, "VALIDATION");
    return this.twinCall("publish_state", twinId, (tx) => [
      tx.pure.string(requiredString(value(input, "aspectCode", "aspect_code"), "aspectCode")),
      tx.pure.string(requiredString(value(input, "sampleType", "sample_type"), "sampleType")),
      tx.pure.string(stringValue(value(input, "sourceUri", "source_uri"), "")),
      tx.pure.string(payloadHash),
      tx.pure.string(stringValue(value(input, "payloadUri", "payload_uri"), "")),
      tx.pure.string(payloadInline),
      tx.pure.u64(observedAt),
      tx.pure.u64(unsignedInteger(value(input, "validFrom", "valid_from"), observedAt)),
      tx.pure.u64(unsignedInteger(value(input, "validTo", "valid_to"), 0)),
      tx.pure.u8(qualityScore),
    ], accounting);
  }

  async pruneState(twinId: string, stateId: string) {
    if (!this.objects) await this.initialize();
    const normalizedTwinId = requiredObjectId(twinId, "twinId");
    const twinObject = await this.client.getObject({ id: normalizedTwinId, options: { showContent: true, showType: true } });
    if (twinObject.error) throw new AppError("OBJECTID_TWIN_NOT_FOUND", "The Twin could not be read before retention pruning", 404, "OBJECTID", { twinId });
    const content = twinObject.data?.content;
    const fields = content?.dataType === "moveObject" ? content.fields as Record<string, unknown> : {};
    const subscriptionId = requiredObjectId(objectIdField(fields.subscription_id), "subscriptionId");
    await this.validateTwinAccounting(normalizedTwinId, subscriptionId);
    const result = await this.execute("prune_state_with_receipt", (tx) => {
      tx.moveCall({ target: this.target("prune_state_with_receipt"), arguments: [
        ...this.accountArguments(tx, subscriptionId), tx.object(normalizedTwinId),
        tx.object(requiredObjectId(stateId, "stateId")), tx.object(this.requiredSignerConfig().clockId),
      ] });
    });
    return { id: requiredObjectId(stateId, "stateId"), pruned: true, digest: result.digest, transaction: result };
  }

  addDataset(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("add_dataset", twinId, (tx) => [
      tx.pure.string(requiredString(value(input, "datasetType", "dataset_type"), "datasetType")),
      tx.pure.option("address", optionalObjectId(value(input, "sourceId", "source_id"))),
      tx.pure.string(stringValue(value(input, "sourceDid", "source_did"), "")),
      tx.pure.string(stringValue(value(input, "schemaUri", "schema_uri"), "")),
      tx.pure.string(requiredString(value(input, "storageUri", "storage_uri"), "storageUri")),
      tx.pure.string(requiredString(value(input, "payloadHash", "payload_hash"), "payloadHash")),
      tx.pure.u64(unsignedInteger(value(input, "periodFrom", "period_from"), Date.now())),
      tx.pure.u64(unsignedInteger(value(input, "periodTo", "period_to"), 0)),
      tx.pure.string(stringValue(input.version, "1")),
      tx.pure.string(metadataValue(value(input, "immutableMetadata", "immutable_metadata"))),
      tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
    ], accounting);
  }

  addAspect(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("add_aspect", twinId, (tx) => [
      tx.pure.string(requiredString(value(input, "aspectCode", "aspect_code"), "aspectCode")),
      tx.pure.string(stringValue(value(input, "aspectName", "aspect_name"), stringValue(value(input, "aspectCode", "aspect_code"), "aspect"))),
      tx.pure.string(requiredString(value(input, "aspectType", "aspect_type"), "aspectType")),
      tx.pure.string(stringValue(value(input, "schemaUri", "schema_uri"), "")),
      tx.pure.string(stringValue(value(input, "semanticRef", "semantic_ref"), "")),
      tx.pure.string(metadataValue(value(input, "immutableMetadata", "immutable_metadata"))),
      tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
    ], accounting);
  }

  addInterface(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("add_interface_v2", twinId, (tx) => [
      tx.pure.string(stringValue(value(input, "interfaceType", "interface_type"), "service")),
      tx.pure.string(requiredString(input.protocol, "protocol")),
      tx.pure.u8(unsignedInteger(input.direction, 2)),
      tx.pure.u8(unsignedInteger(value(input, "networkType", "network_type"), 2)),
      tx.pure.string(stringValue(value(input, "endpointUri", "endpoint_uri"), "")),
      tx.pure.string(stringValue(value(input, "schemaUri", "schema_uri"), "")),
      tx.pure.string(stringValue(value(input, "sourceDid", "source_did"), "")),
      tx.pure.string(metadataValue(value(input, "immutableMetadata", "immutable_metadata"))),
      tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
    ], accounting);
  }

  addModel(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("add_model_ref", twinId, (tx) => [
      tx.pure.string(requiredString(value(input, "modelType", "model_type"), "modelType")),
      tx.pure.string(requiredString(input.name, "name")),
      tx.pure.string(stringValue(input.version, "1")),
      tx.pure.string(requiredString(value(input, "modelUri", "model_uri", "storageUri", "storage_uri"), "modelUri")),
      tx.pure.string(stringValue(value(input, "executableHash", "executable_hash", "payloadHash", "payload_hash"), "")),
      tx.pure.string(stringValue(value(input, "inputSchemaUri", "input_schema_uri"), "")),
      tx.pure.string(stringValue(value(input, "outputSchemaUri", "output_schema_uri"), "")),
      tx.pure.string(metadataValue(input.provenance)),
      tx.pure.string(metadataValue(value(input, "immutableMetadata", "immutable_metadata"))),
      tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
    ], accounting);
  }

  addIdentifier(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("add_identifier", twinId, (tx) => [
      tx.pure.string(requiredString(input.scheme, "scheme")),
      tx.pure.string(requiredString(input.value, "value")),
      tx.pure.string(stringValue(value(input, "resolverUri", "resolver_uri"), "")),
      tx.pure.string(stringValue(input.issuer, "")),
    ], accounting);
  }

  addIdentifierMapping(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("add_identifier_mapping", twinId, (tx) => [
      tx.object(requiredObjectId(value(input, "sourceIdentifierId", "source_identifier_id"), "sourceIdentifierId")),
      tx.object(requiredObjectId(value(input, "targetIdentifierId", "target_identifier_id"), "targetIdentifierId")),
      tx.pure.u8(unsignedInteger(value(input, "mappingType", "mapping_type"), 1)),
      tx.pure.string(stringValue(value(input, "resolverUri", "resolver_uri"), "")),
      tx.pure.string(stringValue(value(input, "mappingSchemaUri", "mapping_schema_uri"), "")),
      tx.pure.string(metadataValue(value(input, "immutableMetadata", "immutable_metadata"))),
      tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
    ], accounting);
  }

  addRelation(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("add_relation", twinId, (tx) => [
      tx.pure.string(requiredString(value(input, "relationType", "relation_type"), "relationType")),
      tx.pure.address(requiredObjectId(value(input, "targetTwinId", "target_twin_id"), "targetTwinId")),
      tx.pure.u8(unsignedInteger(input.direction, 2)),
      tx.pure.string(metadataValue(value(input, "immutableMetadata", "immutable_metadata"))),
      tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
    ], accounting);
  }

  createComposition(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("create_composition", twinId, (tx) => [
      tx.pure.u8(unsignedInteger(value(input, "compositionType", "composition_type"), 1)),
      tx.pure.string(requiredString(input.name, "name")),
      tx.pure.string(stringValue(input.description, "")),
      tx.pure.string(metadataValue(value(input, "immutableMetadata", "immutable_metadata"))),
      tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
    ], accounting);
  }

  emitTwinEvent(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    return this.twinCall("record_business_event", twinId, (tx) => [
      tx.pure.u16(unsignedInteger(value(input, "eventType", "event_type"), 0)),
      tx.pure.string(stringValue(value(input, "payloadRef", "payload_ref"), "")),
      tx.pure.string(stringValue(value(input, "payloadHash", "payload_hash"), "")),
    ], accounting);
  }

  createMaturityAssessment(twinId: string, input: Record<string, unknown>, accounting?: AccountingContext) {
    const evidence = recordValue(input.evidence);
    return this.twinCall("create_maturity_assessment", twinId, (tx) => [
      tx.pure.string(requiredString(value(input, "assessmentModel", "assessment_model"), "assessmentModel")),
      tx.pure.u8(unsignedInteger(value(input, "maturityLevel", "maturity_level"), 0)),
      tx.pure.string(stringValue(value(input, "assessorDid", "assessor_did"), "")),
      tx.pure.string(stringValue(value(input, "schemaUri", "schema_uri"), "")),
      tx.pure.string(stringValue(value(input, "evidenceUri", "evidence_uri") ?? evidence?.uri, "")),
      tx.pure.string(stringValue(value(input, "evidenceHash", "evidence_hash") ?? evidence?.hash, "")),
      tx.pure.string(metadataValue(value(input, "immutableMetadata", "immutable_metadata"))),
      tx.pure.string(metadataValue(value(input, "mutableMetadata", "mutable_metadata"))),
    ], accounting);
  }

  private async twinCall(functionName: string, twinId: string, argumentsFor: (tx: Transaction) => TransactionArgument[], accounting?: AccountingContext) {
    const subscriptionId = await this.subscriptionIdFor(accounting);
    await this.validateTwinAccounting(twinId, subscriptionId, accounting);
    return this.execute(functionName, (tx) => {
      tx.moveCall({ target: this.target(functionName), arguments: [
        ...this.accountArguments(tx, subscriptionId), tx.object(requiredObjectId(twinId, "twinId")),
        ...argumentsFor(tx), tx.object(this.requiredSignerConfig().clockId),
      ] });
    });
  }

  private async execute(operation: string, configure: (tx: Transaction) => void): Promise<IotaTransactionBlockResponse> {
    if (!this.executor || !this.objects) await this.initialize();
    try {
      return await this.executor!.execute(() => { const tx = new Transaction(); configure(tx); return tx; }, operation);
    } catch (error) {
      if (error instanceof AppError && error.code !== "OBJECTID_SPONSORED_TRANSACTION_FAILED") throw error;
      throw mapObjectIdError(error);
    }
  }

  private accountArguments(tx: Transaction, subscriptionId: string) {
    return [tx.object(subscriptionId), tx.object(this.objects!.controllerCapId)];
  }

  private async subscriptionIdFor(accounting?: AccountingContext) {
    if (!this.objects) await this.initialize();
    return requiredObjectId(accounting?.subscriptionId ?? this.objects!.defaultSubscriptionId, "subscriptionId");
  }

  private async validateTwinAccounting(twinId: string, subscriptionId: string, accounting?: AccountingContext, cleanup = false) {
    const object = await this.client.getObject({ id: requiredObjectId(twinId, "twinId"), options: { showContent: true, showType: true } });
    if (object.error) throw new AppError("OBJECTID_TWIN_NOT_FOUND", "The Twin could not be read before submission", 404, "OBJECTID", { twinId });
    if (object.data?.type !== `${this.config.packageId}::oid_twin::OIDTwin`) throw new AppError("OBJECTID_TWIN_PACKAGE_MISMATCH", "Twin belongs to a different package", 409, "OBJECTID");
    const content = object.data?.content;
    const fields = content?.dataType === "moveObject" ? content.fields as Record<string, unknown> : {};
    const actualSubscriptionId = objectIdField(fields.subscription_id);
    if (actualSubscriptionId.toLowerCase() !== subscriptionId.toLowerCase()) {
      throw new AppError("OBJECTID_TENANT_TWIN_MISMATCH", "The authenticated tenant does not own this Twin subscription", 403, "AUTHORIZATION", { twinId, subscriptionId, actualSubscriptionId });
    }
    const subscription = await this.readSubscription(subscriptionId);
    this.assertTenantSubscription(subscription, accounting);
    if (!cleanup && (!subscription.current || BigInt(subscription.remainingCredits) < 1n)) {
      throw new AppError("OBJECTID_SUBSCRIPTION_CREDIT_EXHAUSTED", "The tenant subscription is inactive or has no remaining credits", 402, "AUTHORIZATION", { subscriptionId });
    }
  }

  private assertTenantSubscription(subscription: SubscriptionStatus, accounting?: AccountingContext) {
    if (accounting && subscription.customerId !== accounting.customerId) {
      throw new AppError("OBJECTID_TENANT_SUBSCRIPTION_MISMATCH", "The configured subscription does not belong to the authenticated customer", 403, "AUTHORIZATION", { tenantId: accounting.tenantId, subscriptionId: subscription.objectId });
    }
    if (accounting && subscription.ownerControllerId && !accounting.ownerDid.toLowerCase().endsWith(subscription.ownerControllerId.toLowerCase())) {
      throw new AppError("OBJECTID_TENANT_OWNER_MISMATCH", "The authenticated owner DID does not match the subscription owner on-chain", 403, "AUTHORIZATION", { tenantId: accounting.tenantId, subscriptionId: subscription.objectId });
    }
  }

  private target(functionName: string): `${string}::${string}::${string}` {
    return `${this.config.executionPackageId || this.config.packageId}::oid_twin::${functionName}`;
  }

  private requiredSignerConfig() {
    const signer = this.config.signer;
    if (!signer?.enabled) throw new AppError("OBJECTID_SIGNER_DISABLED", "The IOTA transaction signer is disabled", 503, "OBJECTID");
    if (!this.config.packageId) throw new AppError("OBJECTID_PACKAGE_ID_MISSING", "objectid.packageId is required", 503, "OBJECTID");
    return signer;
  }
}

function value(input: Record<string, unknown>, ...names: string[]) {
  for (const name of names) if (input[name] !== undefined) return input[name];
  return undefined;
}

function requiredString(input: unknown, name: string) {
  const result = stringValue(input, "");
  if (!result) throw new AppError("OBJECTID_TWIN_FIELD_REQUIRED", `${name} is required`, 422, "VALIDATION", { field: name });
  return result;
}

function stringValue(input: unknown, fallback: string) { return typeof input === "string" ? input : fallback; }

function canonicalPayloadHash(input: string) {
  const value = input.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(value)) return `sha256:${value}`;
  if (/^(sha256:|0x)[0-9a-f]{64}$/.test(value)) return value;
  throw new AppError("OBJECTID_STATE_HASH_INVALID", "payloadHash must be a SHA-256 digest", 422, "VALIDATION");
}

function metadataValue(input: unknown) {
  if (typeof input === "string") return input;
  return input === undefined || input === null ? "{}" : JSON.stringify(input);
}

function unsignedInteger(input: unknown, fallback: number) {
  const number = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(number) || number < 0) throw new AppError("OBJECTID_TWIN_NUMBER_INVALID", "Numeric fields must be non-negative safe integers", 422, "VALIDATION");
  return number;
}

function optionalObjectId(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  return requiredObjectId(input, "objectId");
}

function requiredObjectId(input: unknown, name: string) {
  const id = String(input ?? "");
  if (!/^0x[0-9a-f]{64}$/i.test(id)) throw new AppError("OBJECTID_TWIN_OBJECT_ID_INVALID", `${name} must be a 32-byte IOTA object ID`, 422, "VALIDATION", { field: name });
  return id;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function decimalField(input: unknown) {
  const value = String(input ?? "0");
  return /^\d+$/.test(value) ? value : "0";
}

function objectIdField(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    return String(value.id ?? value.bytes ?? value.value ?? "");
  }
  return "";
}

function subtractFloor(limit: string, used: string) {
  const remaining = BigInt(limit) - BigInt(used);
  return (remaining > 0n ? remaining : 0n).toString();
}

function planName(code: number): SubscriptionStatus["plan"]["name"] {
  return ({ 1: "base", 2: "advanced", 3: "pro", 4: "enterprise" } as const)[code as 1 | 2 | 3 | 4] ?? "unknown";
}

function subscriptionStatusName(code: number): SubscriptionStatus["status"]["name"] {
  return ({ 1: "active", 2: "suspended", 3: "cancelled" } as const)[code as 1 | 2 | 3] ?? "unknown";
}
