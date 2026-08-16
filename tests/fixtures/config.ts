import type { AppConfig } from "../../src/config/types.js";

type TestOverrides = Omit<Partial<AppConfig>, "server" | "objectid" | "security" | "policy" | "queue" | "idempotency" | "dataset" | "storage"> & {
  server?: Partial<AppConfig["server"]>;
  objectid?: Partial<AppConfig["objectid"]>;
  security?: Partial<AppConfig["security"]>;
  policy?: Partial<AppConfig["policy"]>;
  queue?: Partial<AppConfig["queue"]>;
  idempotency?: Partial<AppConfig["idempotency"]>;
  dataset?: Partial<Omit<AppConfig["dataset"], "aggregation">> & { aggregation?: Partial<AppConfig["dataset"]["aggregation"]> };
  storage?: Partial<AppConfig["storage"]>;
};

export function testConfig(overrides: TestOverrides = {}): AppConfig {
  const base: AppConfig = {
    server: { host: "127.0.0.1", port: 8080, bodyLimitBytes: 4096, trustProxy: false },
    objectid: { network: "testnet", rpcUrl: "http://localhost", packageId: "0xpackage", timeoutMs: 1000 },
    profiles: { directory: "./profiles" },
    connectors: { rest: { enabled: true }, mqtt: { enabled: false } },
    commands: { enabled: false, storeFile: "./data/test/commands.json", requestTopicTemplate: "objectid/twins/{twinId}/commands/request", resultTopic: "objectid/twins/+/commands/+/result", catalogs: [] },
    security: { credentialProvider: "environment", authMode: "disabled", apiKeyCredential: "DTIS_API_KEY", jwtSecretCredential: "DTIS_JWT_SECRET", rateLimitPerMinute: 1000 },
    cache: { type: "memory", ttlMs: 60_000 },
    policy: { cacheTtlMs: 1_000 },
    queue: { type: "memory", maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, pollIntervalMs: 1 },
    idempotency: { provider: "memory", ttlMs: 60_000 },
    dataset: { directory: "./data/test", aggregation: { enabled: true, defaultWindowSeconds: 300, shutdownFlushTimeoutMs: 1_000 } },
    storage: { defaultProvider: "local", providers: { local: { type: "filesystem", basePath: "./data/test", uriPrefix: "file://" } }, routes: {} },
    retention: { enabled: false, defaultDays: 5, intervalMs: 3_600_000, startupDelayMs: 60_000, maxDeletesPerRun: 500, ownerPolicies: [] },
  };
  const localProvider = base.storage.providers.local;
  if (localProvider?.type !== "filesystem") throw new Error("Test local storage must be filesystem");
  const storage: AppConfig["storage"] = overrides.storage
    ? { ...base.storage, ...overrides.storage, providers: overrides.storage.providers ?? base.storage.providers, routes: overrides.storage.routes ?? base.storage.routes }
    : {
      ...base.storage,
      providers: {
        local: { ...localProvider, basePath: overrides.dataset?.directory ?? localProvider.basePath },
      },
    };
  return {
    ...base, ...overrides,
    server: { ...base.server, ...overrides.server }, objectid: { ...base.objectid, ...overrides.objectid },
    security: { ...base.security, ...overrides.security }, policy: { ...base.policy, ...overrides.policy },
    queue: { ...base.queue, ...overrides.queue }, idempotency: { ...base.idempotency, ...overrides.idempotency },
    dataset: { ...base.dataset, ...overrides.dataset, aggregation: { ...base.dataset.aggregation, ...overrides.dataset?.aggregation } },
    storage,
  };
}
