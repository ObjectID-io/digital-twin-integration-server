import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfig } from "../fixtures/config.js";
import { TenantRegistry } from "../../src/security/tenants.js";
import type { CredentialProvider } from "../../src/security/credentials.js";

const objectId = (digit: string) => `0x${digit.repeat(64)}`;

function registry() {
  const config = testConfig({ security: { defaultTenantId: "customer-a" } });
  const values: Record<string, unknown> = {
    DTIS_TENANTS_JSON: { tenants: [{
      tenantId: "customer-a",
      customerId: "billing-a",
      ownerDid: `did:iota:testnet:${objectId("a")}`,
      subscriptionId: objectId("1"),
      apiKeyCredential: "CUSTOMER_A_KEY",
    }] },
    CUSTOMER_A_KEY: "tenant-secret",
  };
  const credentials: CredentialProvider = { async get(name) {
    const value = values[name];
    return typeof value === "string" ? value : value ? JSON.stringify(value) : undefined;
  } };
  return new TenantRegistry(config.security, credentials);
}

describe("tenant accounting registry", () => {
  it("resolves an API key to server-side accounting data", async () => {
    await expect(registry().authenticateApiKey("tenant-secret")).resolves.toEqual({
      tenantId: "customer-a",
      customerId: "billing-a",
      ownerDid: `did:iota:testnet:${objectId("a")}`,
      subscriptionId: objectId("1"),
    });
  });

  it("does not accept an unknown tenant key", async () => {
    await expect(registry().authenticateApiKey("wrong")).rejects.toMatchObject({ code: "AUTH_INVALID_API_KEY" });
  });

  it("resolves the configured connector tenant without caller input", async () => {
    await expect(registry().default()).resolves.toMatchObject({ tenantId: "customer-a", subscriptionId: objectId("1") });
  });

  it("persists and authenticates a dynamically provisioned testnet tenant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dtis-tenants-"));
    const config = testConfig({ security: { testnetFreeSubscriptions: { enabled: true, provisioningKeyCredential: "PROVISIONING_KEY", dynamicTenantFile: join(directory, "tenants.json"), periodDays: 30 } } });
    const credentials: CredentialProvider = { async get(name) { return name === "DTIS_TENANTS_JSON" ? JSON.stringify({ tenants: [] }) : undefined; } };
    const dynamic = new TenantRegistry(config.security, credentials);
    const accounting = { tenantId: "free-a", customerId: "free-a", ownerDid: `did:iota:testnet:${objectId("a")}`, subscriptionId: objectId("2") };
    await dynamic.saveDynamic(accounting, "generated-tenant-key");
    await expect(dynamic.authenticateApiKey("generated-tenant-key")).resolves.toEqual(accounting);
    await expect(dynamic.isDynamic(accounting.ownerDid)).resolves.toBe(true);
    const rotated = await dynamic.rotateExternalCredentials(accounting.ownerDid, "external-key", "mqtt-free-a", "mqtt-secret", [objectId("9")]);
    expect(rotated).toMatchObject({ active: true, version: 1, mqttUsername: "mqtt-free-a", twinIds: [objectId("9")] });
    await expect(dynamic.authenticateApiKey("external-key")).resolves.toEqual(accounting);
    const revoked = await dynamic.revokeExternalCredentials(accounting.ownerDid);
    expect(revoked).toMatchObject({ active: false, version: 1 });
    await expect(dynamic.authenticateApiKey("external-key")).rejects.toMatchObject({ code: "AUTH_INVALID_API_KEY" });
    await expect(dynamic.authenticateApiKey("generated-tenant-key")).resolves.toEqual(accounting);
  });
});
