import { describe, expect, it } from "vitest";
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
});
