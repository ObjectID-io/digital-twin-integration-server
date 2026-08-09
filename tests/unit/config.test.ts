import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.js";

describe("configuration", () => {
  it("applies environment overrides", async () => {
    const config = await loadConfig("./tests/fixtures/missing.yaml", { DTIS_SERVER_PORT: "9090", DTIS_OBJECTID_NETWORK: "mainnet", DTIS_AUTH_MODE: "api-key" });
    expect(config.server.port).toBe(9090);
    expect(config.objectid.network).toBe("mainnet");
    expect(config.security.authMode).toBe("api-key");
  });
  it("rejects invalid ports", async () => {
    await expect(loadConfig("./tests/fixtures/missing.yaml", { DTIS_SERVER_PORT: "99999" })).rejects.toMatchObject({ code: "CONFIG_INVALID_PORT" });
  });
  it("rejects an S3 provider without a bucket", async () => {
    await expect(loadConfig("./tests/fixtures/storage-invalid.yaml", {})).rejects.toMatchObject({ code: "CONFIG_STORAGE_BUCKET_REQUIRED" });
  });
});
