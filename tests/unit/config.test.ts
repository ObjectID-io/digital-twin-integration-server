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
  it("configures the Digital Thread Redis cache from the environment", async () => {
    const config = await loadConfig("./tests/fixtures/missing.yaml", {
      DTIS_CACHE_TYPE: "redis", DTIS_CACHE_TTL_MS: "15000", DTIS_CACHE_REDIS_URL: "redis://cache:6379",
    });
    expect(config.cache).toEqual({ type: "redis", ttlMs: 15000, redisUrl: "redis://cache:6379" });
  });
  it("rejects an S3 provider without a bucket", async () => {
    await expect(loadConfig("./tests/fixtures/storage-invalid.yaml", {})).rejects.toMatchObject({ code: "CONFIG_STORAGE_BUCKET_REQUIRED" });
  });
});
