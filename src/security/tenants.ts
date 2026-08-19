import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "../common/errors.js";
import type { AppConfig } from "../config/types.js";
import type { AccountingContext } from "../objectid/types.js";
import { requiredCredential, type CredentialProvider } from "./credentials.js";

interface TenantDefinition extends AccountingContext {
  apiKeyCredential: string;
}

export class TenantRegistry {
  constructor(private readonly config: AppConfig["security"], private readonly credentials: CredentialProvider) {}

  async configured() { return (await this.definitions()).length > 0; }

  async authenticateApiKey(candidate: string | undefined): Promise<AccountingContext | undefined> {
    const definitions = await this.definitions();
    if (!definitions.length) return undefined;
    if (!candidate) throw invalidApiKey();
    const actual = digest(candidate);
    for (const tenant of definitions) {
      const expected = digest(await requiredCredential(this.credentials, tenant.apiKeyCredential));
      if (timingSafeEqual(actual, expected)) return accountingOf(tenant);
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

  private async definitions(): Promise<TenantDefinition[]> {
    const raw = await this.credentials.get(this.config.tenantRegistryCredential);
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new AppError("CONFIG_TENANT_REGISTRY_INVALID", "The tenant registry is not valid JSON", 500, "VALIDATION"); }
    const values = Array.isArray(parsed) ? parsed : (parsed as any)?.tenants;
    if (!Array.isArray(values)) throw new AppError("CONFIG_TENANT_REGISTRY_INVALID", "The tenant registry must contain a tenants array", 500, "VALIDATION");
    const tenants = values.map((value, index) => validateTenant(value, index));
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
    apiKeyCredential: String(value?.apiKeyCredential ?? ""),
  };
  if (!tenant.tenantId || !tenant.customerId || !/^did:iota(?::[a-z0-9-]+)?:0x[0-9a-f]{64}$/i.test(tenant.ownerDid) || !tenant.apiKeyCredential || !/^0x[0-9a-f]{64}$/.test(tenant.subscriptionId)) {
    throw new AppError("CONFIG_TENANT_INVALID", `Tenant registry entry ${index} is invalid`, 500, "VALIDATION");
  }
  return tenant;
}

function accountingOf(tenant: TenantDefinition): AccountingContext {
  return { tenantId: tenant.tenantId, customerId: tenant.customerId, ownerDid: tenant.ownerDid, subscriptionId: tenant.subscriptionId };
}

function digest(value: string) { return createHash("sha256").update(value).digest(); }
function invalidApiKey() { return new AppError("AUTH_INVALID_API_KEY", "Invalid or missing API key", 401, "AUTHORIZATION"); }
