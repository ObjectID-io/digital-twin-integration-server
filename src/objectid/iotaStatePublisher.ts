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
    const result = await this.twinCall("delete_twin", twinId, () => [], accounting);
    return { id: requiredObjectId(twinId, "twinId"), deleted: true, digest: result.digest, transaction: result };
  }

  async provisionFreeTestnetSubscription(ownerDid: string, customerId: string, periodDays: number) {
    if (this.config.network !== "testnet") throw new AppError("OBJECTID_FREE_SUBSCRIPTION_TESTNET_ONLY", "Free subscriptions are available only on testnet", 403, "AUTHORIZATION");
    const signer = this.requiredSignerConfig();
    if (!signer.subscriptionAdminCapCredential) throw new AppError("CREDENTIAL_MISSING", "SubscriptionAdminCap credential is not configured", 503, "AUTHORIZATION");
    if (!this.objects) await this.initialize();
    const adminCapId = await requiredCredential(this.credentials, signer.subscriptionAdminCapCredential);
    const ownerControllerId = ownerDid.slice(ownerDid.lastIndexOf(":") + 1);
    const cap = await this.client.getObject({ id: this.objects!.controllerCapId, options: { showContent: true } });
    const content = cap.data?.content;
    const fields = content?.dataType === "moveObject" ? content.fields as Record<string, unknown> : {};
    const integrationControllerId = objectIdField(fields.controller_of);
    const periodStart = Date.now();
    const periodEnd = periodStart + periodDays * 86_400_000;
    const result = await this.execute("create_customer_subscription", (tx) => tx.moveCall({
      target: this.target("create_customer_subscription"),
      arguments: [
        tx.object(requiredObjectId(adminCapId, "subscriptionAdminCapId")), tx.pure.string(customerId),
        tx.pure.address(requiredObjectId(ownerControllerId, "ownerControllerId")),
        tx.pure.address(integrationControllerId), tx.pure.u8(1), tx.pure.u64(periodStart), tx.pure.u64(periodEnd),
        tx.pure.u64(0), tx.pure.u64(0), tx.object(signer.clockId),
      ],
    }));
    const created = result.objectChanges?.find((change: any) => change.type === "created" && String(change.objectType ?? "").endsWith("::oid_twin::SubscriptionAccount")) as any;
    if (!created?.objectId) throw new AppError("OBJECTID_SUBSCRIPTION_CREATE_RESULT_INVALID", "Subscription creation succeeded without a SubscriptionAccount", 502, "OBJECTID");
    return { subscriptionId: created.objectId, digest: String(result.digest) };
  }

  async renewFreeTestnetSubscription(subscriptionId: string, periodDays: number) {
    if (this.config.network !== "testnet") throw new AppError("OBJECTID_FREE_SUBSCRIPTION_TESTNET_ONLY", "Free subscriptions are available only on testnet", 403, "AUTHORIZATION");
    const signer = this.requiredSignerConfig();
    if (!signer.subscriptionAdminCapCredential) throw new AppError("CREDENTIAL_MISSING", "SubscriptionAdminCap credential is not configured", 503, "AUTHORIZATION");
    const adminCapId = await requiredCredential(this.credentials, signer.subscriptionAdminCapCredential);
    const periodStart = Date.now(); const periodEnd = periodStart + periodDays * 86_400_000;
    const result = await this.execute("renew_subscription", (tx) => tx.moveCall({ target: this.target("renew_subscription"), arguments: [
      tx.object(requiredObjectId(adminCapId, "subscriptionAdminCapId")), tx.object(requiredObjectId(subscriptionId, "subscriptionId")),
      tx.pure.u8(1), tx.pure.u64(periodStart), tx.pure.u64(periodEnd), tx.pure.u64(0), tx.pure.u64(0), tx.object(signer.clockId),
    ] }));
    return { digest: String(result.digest) };
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
    if (!String(object.data?.type ?? "").endsWith("::oid_twin::SubscriptionAccount")) {
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
    const payloadHash = stringValue(value(input, "payloadHash", "payload_hash"), createHash("sha256").update(payloadInline).digest("hex"));
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

  private async validateTwinAccounting(twinId: string, subscriptionId: string, accounting?: AccountingContext) {
    const object = await this.client.getObject({ id: requiredObjectId(twinId, "twinId"), options: { showContent: true, showType: true } });
    if (object.error) throw new AppError("OBJECTID_TWIN_NOT_FOUND", "The Twin could not be read before submission", 404, "OBJECTID", { twinId });
    const content = object.data?.content;
    const fields = content?.dataType === "moveObject" ? content.fields as Record<string, unknown> : {};
    const actualSubscriptionId = objectIdField(fields.subscription_id);
    if (actualSubscriptionId.toLowerCase() !== subscriptionId.toLowerCase()) {
      throw new AppError("OBJECTID_TENANT_TWIN_MISMATCH", "The authenticated tenant does not own this Twin subscription", 403, "AUTHORIZATION", { twinId, subscriptionId, actualSubscriptionId });
    }
    const subscription = await this.readSubscription(subscriptionId);
    this.assertTenantSubscription(subscription, accounting);
    if (!subscription.current || BigInt(subscription.remainingCredits) < 1n) {
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
    return `${this.config.packageId}::oid_twin::${functionName}`;
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
