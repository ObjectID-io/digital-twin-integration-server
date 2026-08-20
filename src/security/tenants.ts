import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "../common/errors.js";
import type { AppConfig } from "../config/types.js";
import type { AccountingContext } from "../objectid/types.js";
import { requiredCredential, type CredentialProvider } from "./credentials.js";

interface TenantDefinition extends AccountingContext {
  apiKeyCredential?: string;
  apiKeyHash?: string;
  externalApiKeyHash?: string;
  mqttUsername?: string;
  mqttTwinIds?: string[];
  credentialsVersion?: number;
  credentialsRotatedAt?: string;
  credentialsRevokedAt?: string;
}

export interface TenantCredentialStatus {
  tenantId: string;
  subscriptionId: string;
  active: boolean;
  version: number;
  rotatedAt: string | null;
  revokedAt: string | null;
  mqttUsername: string | null;
  twinIds: string[];
}

const execFileAsync = promisify(execFile);

export class TenantRegistry {
  constructor(private readonly config: AppConfig["security"], private readonly credentials: CredentialProvider) {}

  async configured() { return (await this.definitions()).length > 0; }

  async authenticateApiKey(candidate: string | undefined): Promise<AccountingContext | undefined> {
    const definitions = await this.definitions();
    if (!definitions.length) return undefined;
    if (!candidate) throw invalidApiKey();
    const actual = digest(candidate);
    for (const tenant of definitions) {
      const expected = [
        tenant.apiKeyHash ? Buffer.from(tenant.apiKeyHash, "hex") : digest(await requiredCredential(this.credentials, tenant.apiKeyCredential!)),
        tenant.externalApiKeyHash ? Buffer.from(tenant.externalApiKeyHash, "hex") : undefined,
      ].filter(Boolean) as Buffer[];
      if (expected.some((value) => timingSafeEqual(actual, value))) return accountingOf(tenant);
    }
    throw invalidApiKey();
  }

  async get(tenantId: string): Promise<AccountingContext> {
    const tenant = (await this.definitions()).find((item) => item.tenantId === tenantId);
    if (!tenant) throw new AppError("AUTH_TENANT_UNKNOWN", `Tenant '${tenantId}' is not configured`, 403, "AUTHORIZATION");
    return accountingOf(tenant);
  }

  async default(): Promise<AccountingContext | undefined> {
    if (!this.config.defaultTenantId) return undefined;
    return this.get(this.config.defaultTenantId);
  }

  async findByOwnerDid(ownerDid: string): Promise<AccountingContext | undefined> {
    const tenant = (await this.definitions()).find((item) => item.ownerDid.toLowerCase() === ownerDid.toLowerCase());
    return tenant ? accountingOf(tenant) : undefined;
  }

  async saveDynamic(accounting: AccountingContext, apiKey: string) {
    const file = this.config.testnetFreeSubscriptions?.dynamicTenantFile;
    if (!file) throw new AppError("CONFIG_DYNAMIC_TENANT_FILE_REQUIRED", "Dynamic tenant storage is not configured", 503, "VALIDATION");
    const state = await readDynamic(file);
    const previous = state.tenants.find((tenant) => String(tenant.ownerDid).toLowerCase() === accounting.ownerDid.toLowerCase());
    const item: TenantDefinition = { ...previous, ...accounting, apiKeyHash: createHash("sha256").update(apiKey).digest("hex") };
    state.tenants = [...state.tenants.filter((tenant) => tenant.ownerDid.toLowerCase() !== accounting.ownerDid.toLowerCase()), item];
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }

  async isDynamic(ownerDid: string) {
    const file = this.config.testnetFreeSubscriptions?.dynamicTenantFile;
    return file ? (await readDynamic(file)).tenants.some((tenant) => String(tenant.ownerDid).toLowerCase() === ownerDid.toLowerCase()) : false;
  }

  async credentialStatus(ownerDid: string): Promise<TenantCredentialStatus> {
    const tenant = await this.dynamicTenant(ownerDid);
    return statusOf(tenant);
  }

  async rotateExternalCredentials(ownerDid: string, apiKey: string, mqttUsername: string, mqttPassword: string, twinIds: string[]) {
    const file = this.dynamicFile();
    const state = await readDynamic(file);
    const index = state.tenants.findIndex((tenant) => String(tenant.ownerDid).toLowerCase() === ownerDid.toLowerCase());
    if (index < 0) throw new AppError("AUTH_TENANT_UNKNOWN", "A dynamic tenant subscription is required", 404, "AUTHORIZATION");
    const previous = state.tenants[index] as TenantDefinition;
    const next: TenantDefinition = {
      ...previous,
      externalApiKeyHash: createHash("sha256").update(apiKey).digest("hex"),
      mqttUsername,
      mqttTwinIds: [...new Set(twinIds.map((value) => value.toLowerCase()))],
      credentialsVersion: Number(previous.credentialsVersion ?? 0) + 1,
      credentialsRotatedAt: new Date().toISOString(),
      credentialsRevokedAt: undefined,
    };
    state.tenants[index] = next;
    await writeDynamic(file, state);
    await this.updateMqttPassword("upsert", mqttUsername, mqttPassword);
    await this.rewriteMqttAcl(state.tenants as TenantDefinition[]);
    return statusOf(next);
  }

  async revokeExternalCredentials(ownerDid: string) {
    const file = this.dynamicFile();
    const state = await readDynamic(file);
    const index = state.tenants.findIndex((tenant) => String(tenant.ownerDid).toLowerCase() === ownerDid.toLowerCase());
    if (index < 0) throw new AppError("AUTH_TENANT_UNKNOWN", "A dynamic tenant subscription is required", 404, "AUTHORIZATION");
    const previous = state.tenants[index] as TenantDefinition;
    const username = previous.mqttUsername;
    const next: TenantDefinition = {
      ...previous,
      externalApiKeyHash: undefined,
      mqttTwinIds: [],
      credentialsRevokedAt: new Date().toISOString(),
    };
    state.tenants[index] = next;
    await writeDynamic(file, state);
    if (username) await this.updateMqttPassword("delete", username);
    await this.rewriteMqttAcl(state.tenants as TenantDefinition[]);
    return statusOf(next);
  }

  private dynamicFile() {
    const file = this.config.testnetFreeSubscriptions?.dynamicTenantFile;
    if (!file) throw new AppError("CONFIG_DYNAMIC_TENANT_FILE_REQUIRED", "Dynamic tenant storage is not configured", 503, "VALIDATION");
    return file;
  }

  private async dynamicTenant(ownerDid: string): Promise<TenantDefinition> {
    const tenant = (await readDynamic(this.dynamicFile())).tenants.find((value) => String(value.ownerDid).toLowerCase() === ownerDid.toLowerCase());
    if (!tenant) throw new AppError("AUTH_TENANT_UNKNOWN", "A dynamic tenant subscription is required", 404, "AUTHORIZATION");
    return tenant as TenantDefinition;
  }

  private async updateMqttPassword(action: "upsert" | "delete", username: string, password?: string) {
    const file = this.config.testnetFreeSubscriptions?.mqtt?.passwordFile;
    if (!file) return;
    const args = action === "delete" ? ["-D", file, username] : ["-b", file, username, String(password)];
    try { await execFileAsync("mosquitto_passwd", args); }
    catch (error: any) {
      if (action === "delete" && String(error?.stderr ?? "").includes("not found")) return;
      throw new AppError("MQTT_CREDENTIAL_UPDATE_FAILED", "Unable to update MQTT credentials", 503, "CONNECTOR");
    }
  }

  private async rewriteMqttAcl(tenants: TenantDefinition[]) {
    const mqtt = this.config.testnetFreeSubscriptions?.mqtt;
    if (!mqtt?.aclFile) return;
    const lines = [`user ${mqtt.serviceUsername}`, "topic readwrite #", "topic read $SYS/#", ""];
    for (const tenant of tenants.filter((value) => value.mqttUsername && value.externalApiKeyHash && !value.credentialsRevokedAt)) {
      lines.push(`user ${tenant.mqttUsername}`);
      for (const twinId of tenant.mqttTwinIds ?? []) {
        const root = `objectid/tenants/${tenant.tenantId}/twins/${twinId}`;
        lines.push(
          `topic write ${root}/telemetry/state`,
          `topic write ${root}/telemetry/dataset`,
          `topic read objectid/twins/${twinId}/commands/request`,
          `topic write objectid/twins/${twinId}/commands/+/result`,
        );
      }
      lines.push("");
    }
    await mkdir(dirname(mqtt.aclFile), { recursive: true });
    const temporary = `${mqtt.aclFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o660 });
    await rename(temporary, mqtt.aclFile);
  }

  private async definitions(): Promise<TenantDefinition[]> {
    const raw = await this.credentials.get(this.config.tenantRegistryCredential);
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new AppError("CONFIG_TENANT_REGISTRY_INVALID", "The tenant registry is not valid JSON", 500, "VALIDATION"); }
    const values = Array.isArray(parsed) ? parsed : (parsed as any)?.tenants;
    if (!Array.isArray(values)) throw new AppError("CONFIG_TENANT_REGISTRY_INVALID", "The tenant registry must contain a tenants array", 500, "VALIDATION");
    const staticTenants = values.map((value, index) => validateTenant(value, index));
    const dynamicFile = this.config.testnetFreeSubscriptions?.dynamicTenantFile;
    const dynamicTenants = dynamicFile ? (await readDynamic(dynamicFile)).tenants.map((value, index) => validateTenant(value, staticTenants.length + index)) : [];
    const tenants = [...new Map([...staticTenants, ...dynamicTenants].map((tenant) => [tenant.tenantId, tenant])).values()];
    const ids = new Set<string>();
    for (const tenant of tenants) {
      if (ids.has(tenant.tenantId)) throw new AppError("CONFIG_TENANT_DUPLICATE", `Duplicate tenant '${tenant.tenantId}'`, 500, "VALIDATION");
      ids.add(tenant.tenantId);
    }
    return tenants;
  }
}

function validateTenant(value: any, index: number): TenantDefinition {
  const tenant: TenantDefinition = {
    tenantId: String(value?.tenantId ?? ""),
    customerId: String(value?.customerId ?? ""),
    ownerDid: String(value?.ownerDid ?? ""),
    subscriptionId: String(value?.subscriptionId ?? "").toLowerCase(),
    apiKeyCredential: value?.apiKeyCredential ? String(value.apiKeyCredential) : undefined,
    apiKeyHash: value?.apiKeyHash ? String(value.apiKeyHash) : undefined,
    externalApiKeyHash: value?.externalApiKeyHash ? String(value.externalApiKeyHash) : undefined,
    mqttUsername: value?.mqttUsername ? String(value.mqttUsername) : undefined,
    mqttTwinIds: Array.isArray(value?.mqttTwinIds) ? value.mqttTwinIds.map(String) : [],
    credentialsVersion: Number(value?.credentialsVersion ?? 0),
    credentialsRotatedAt: value?.credentialsRotatedAt ? String(value.credentialsRotatedAt) : undefined,
    credentialsRevokedAt: value?.credentialsRevokedAt ? String(value.credentialsRevokedAt) : undefined,
  };
  if (!tenant.tenantId || !tenant.customerId || !/^did:iota(?::[a-z0-9-]+)?:0x[0-9a-f]{64}$/i.test(tenant.ownerDid) || (!tenant.apiKeyCredential && !/^[0-9a-f]{64}$/.test(tenant.apiKeyHash ?? "")) || !/^0x[0-9a-f]{64}$/.test(tenant.subscriptionId)) {
    throw new AppError("CONFIG_TENANT_INVALID", `Tenant registry entry ${index} is invalid`, 500, "VALIDATION");
  }
  return tenant;
}

function accountingOf(tenant: TenantDefinition): AccountingContext {
  return { tenantId: tenant.tenantId, customerId: tenant.customerId, ownerDid: tenant.ownerDid, subscriptionId: tenant.subscriptionId };
}

function digest(value: string) { return createHash("sha256").update(value).digest(); }
function invalidApiKey() { return new AppError("AUTH_INVALID_API_KEY", "Invalid or missing API key", 401, "AUTHORIZATION"); }

async function readDynamic(file: string): Promise<{ tenants: any[] }> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return { tenants: Array.isArray(value?.tenants) ? value.tenants : [] };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { tenants: [] };
    throw new AppError("CONFIG_DYNAMIC_TENANT_INVALID", "Dynamic tenant storage is invalid", 500, "VALIDATION");
  }
}

async function writeDynamic(file: string, state: { tenants: any[] }) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function statusOf(tenant: TenantDefinition): TenantCredentialStatus {
  return {
    tenantId: tenant.tenantId,
    subscriptionId: tenant.subscriptionId,
    active: Boolean(tenant.externalApiKeyHash && tenant.mqttUsername && !tenant.credentialsRevokedAt),
    version: Number(tenant.credentialsVersion ?? 0),
    rotatedAt: tenant.credentialsRotatedAt ?? null,
    revokedAt: tenant.credentialsRevokedAt ?? null,
    mqttUsername: tenant.mqttUsername ?? null,
    twinIds: tenant.mqttTwinIds ?? [],
  };
}
