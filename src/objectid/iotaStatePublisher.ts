import { createHash } from "node:crypto";
import { getFullnodeUrl, IotaClient } from "@iota/iota-sdk/client";
import { Ed25519Keypair } from "@iota/iota-sdk/keypairs/ed25519";
import { Transaction } from "@iota/iota-sdk/transactions";
import { AppError, mapObjectIdError } from "../common/errors.js";
import { logger } from "../common/logger.js";
import type { AppConfig } from "../config/types.js";
import { requiredCredential, type CredentialProvider } from "../security/credentials.js";

type ObjectIdConfig = AppConfig["objectid"];

interface SignerObjects {
  controllerCapId: string;
  creditPolicyId: string;
  creditTokenId: string;
}

export class IotaStatePublisher {
  private readonly client: IotaClient;
  private keypair?: Ed25519Keypair;
  private objects?: SignerObjects;

  constructor(private readonly config: ObjectIdConfig, private readonly credentials: CredentialProvider, client?: IotaClient) {
    this.client = client ?? new IotaClient({ url: config.rpcUrl || getFullnodeUrl(config.network as "mainnet" | "testnet" | "devnet" | "localnet") });
  }

  async initialize() {
    const signer = this.requiredSignerConfig();
    const [seedValue, expectedAddress, controllerCapId, creditPolicyId, creditTokenId] = await Promise.all([
      requiredCredential(this.credentials, signer.seedCredential),
      requiredCredential(this.credentials, signer.addressCredential),
      requiredCredential(this.credentials, signer.controllerCapCredential),
      requiredCredential(this.credentials, signer.creditPolicyCredential),
      requiredCredential(this.credentials, signer.creditTokenCredential),
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
    this.keypair = keypair;
    this.objects = { controllerCapId, creditPolicyId, creditTokenId };
    logger.info({ address: derivedAddress, network: this.config.network }, "iota_state_publisher_ready");
  }

  async publishState(twinId: string, input: Record<string, unknown>) {
    if (!this.keypair || !this.objects) await this.initialize();
    const signer = this.requiredSignerConfig();
    const payloadInline = stringValue(input.payloadInline, "");
    const payloadHash = stringValue(input.payloadHash, createHash("sha256").update(payloadInline).digest("hex"));
    const observedAt = unsignedInteger(input.observedAt, Date.now());
    const validFrom = unsignedInteger(input.validFrom, observedAt);
    const validTo = unsignedInteger(input.validTo, 0);
    const qualityScore = unsignedInteger(input.qualityScore, 100);
    if (qualityScore > 100) throw new AppError("OBJECTID_STATE_QUALITY_INVALID", "qualityScore must be between 0 and 100", 422, "VALIDATION");

    const tx = new Transaction();
    tx.setGasBudget(signer.gasBudget);
    tx.moveCall({
      target: `${this.config.packageId}::oid_twin::publish_state`,
      arguments: [
        tx.object(this.objects!.creditTokenId),
        tx.object(this.objects!.creditPolicyId),
        tx.object(this.objects!.controllerCapId),
        tx.object(twinId),
        tx.pure.string(requiredString(input.aspectCode, "aspectCode")),
        tx.pure.string(requiredString(input.sampleType, "sampleType")),
        tx.pure.string(stringValue(input.sourceUri, "")),
        tx.pure.string(payloadHash),
        tx.pure.string(stringValue(input.payloadUri, "")),
        tx.pure.string(payloadInline),
        tx.pure.u64(observedAt),
        tx.pure.u64(validFrom),
        tx.pure.u64(validTo),
        tx.pure.u8(qualityScore),
        tx.object(signer.clockId),
      ],
    });

    try {
      const result = await this.client.signAndExecuteTransaction({
        signer: this.keypair!,
        transaction: tx,
        options: { showEffects: true, showEvents: true, showObjectChanges: true },
      });
      await this.client.waitForTransaction({ digest: result.digest, timeout: this.config.timeoutMs });
      if (result.effects?.status.status !== "success") {
        throw new AppError(
          "OBJECTID_STATE_TRANSACTION_FAILED",
          result.effects?.status.error ?? "IOTA publish_state transaction failed",
          502,
          "OBJECTID",
          { digest: result.digest },
        );
      }
      logger.info({ digest: result.digest, twinId, observedAt }, "iota_twin_state_published");
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapObjectIdError(error);
    }
  }

  private requiredSignerConfig() {
    const signer = this.config.signer;
    if (!signer?.enabled) throw new AppError("OBJECTID_SIGNER_DISABLED", "The IOTA transaction signer is disabled", 503, "OBJECTID");
    if (!this.config.packageId) throw new AppError("OBJECTID_PACKAGE_ID_MISSING", "objectid.packageId is required", 503, "OBJECTID");
    return signer;
  }
}

function requiredString(value: unknown, name: string) {
  const result = stringValue(value, "");
  if (!result) throw new AppError("OBJECTID_STATE_FIELD_REQUIRED", `${name} is required`, 422, "VALIDATION", { field: name });
  return result;
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function unsignedInteger(value: unknown, fallback: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new AppError("OBJECTID_STATE_NUMBER_INVALID", "State timestamps and scores must be non-negative safe integers", 422, "VALIDATION");
  return number;
}
