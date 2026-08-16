import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { AppError } from "../common/errors.js";
import type { AppConfig } from "./types.js";
import type { StorageConfig, StorageProviderConfig } from "../storage/types.js";

const defaults: AppConfig = {
  server: { host: "0.0.0.0", port: 8080, bodyLimitBytes: 1_048_576, trustProxy: false },
  objectid: { network: "testnet", rpcUrl: "", packageId: "", timeoutMs: 30_000 },
  profiles: { directory: "./profiles" },
  connectors: { rest: { enabled: true }, mqtt: { enabled: false }, opcua: { enabled: false }, modbus: { enabled: false, status: "PLUGIN_READY" } },
  commands: { enabled: false, storeFile: "./data/commands.json", requestTopicTemplate: "objectid/twins/{twinId}/commands/request", resultTopic: "objectid/twins/+/commands/+/result", catalogs: [] },
  security: {
    credentialProvider: "environment",
    authMode: "disabled",
    apiKeyCredential: "DTIS_API_KEY",
    jwtSecretCredential: "DTIS_JWT_SECRET",
    rateLimitPerMinute: 120,
  },
  cache: { type: "memory", ttlMs: 300_000 },
  policy: { cacheTtlMs: 15_000 },
  queue: { type: "memory", maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 10_000, pollIntervalMs: 50 },
  idempotency: { provider: "memory", ttlMs: 300_000 },
  dataset: { directory: "./data", aggregation: { enabled: true, defaultWindowSeconds: 300, shutdownFlushTimeoutMs: 5_000 } },
  storage: {
    defaultProvider: "local",
    providers: { local: { type: "filesystem", basePath: "./data", uriPrefix: "file://", createDirectories: true, writable: true } },
    routes: {},
  },
  retention: { enabled: true, defaultDays: 5, intervalMs: 3_600_000, startupDelayMs: 60_000, maxDeletesPerRun: 500, ownerPolicies: [] },
};

function merge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prior = output[key];
    output[key as keyof T] = (
      value && prior && typeof value === "object" && typeof prior === "object" && !Array.isArray(value)
        ? merge(prior, value)
        : value
    ) as T[keyof T];
  }
  return output;
}

function applyEnvironment(config: AppConfig, env: NodeJS.ProcessEnv): AppConfig {
  const next = structuredClone(config);
  if (env.DTIS_SERVER_HOST) next.server.host = env.DTIS_SERVER_HOST;
  if (env.DTIS_SERVER_PORT) next.server.port = Number(env.DTIS_SERVER_PORT);
  if (env.DTIS_BODY_LIMIT_BYTES) next.server.bodyLimitBytes = Number(env.DTIS_BODY_LIMIT_BYTES);
  if (env.DTIS_OBJECTID_NETWORK) next.objectid.network = env.DTIS_OBJECTID_NETWORK;
  if (env.DTIS_OBJECTID_RPC_URL) next.objectid.rpcUrl = env.DTIS_OBJECTID_RPC_URL;
  if (env.DTIS_OBJECTID_PACKAGE_ID) next.objectid.packageId = env.DTIS_OBJECTID_PACKAGE_ID;
  if (env.DTIS_PROFILES_DIRECTORY) next.profiles.directory = env.DTIS_PROFILES_DIRECTORY;
  if (env.DTIS_AUTH_MODE) next.security.authMode = env.DTIS_AUTH_MODE as AppConfig["security"]["authMode"];
  if (env.DTIS_CREDENTIAL_PROVIDER) next.security.credentialProvider = env.DTIS_CREDENTIAL_PROVIDER as "environment" | "file";
  if (env.DTIS_CREDENTIAL_FILE) next.security.credentialFile = env.DTIS_CREDENTIAL_FILE;
  if (env.DTIS_SERVICE_DID) next.security.serviceDid = env.DTIS_SERVICE_DID;
  if (env.DTIS_DATA_DIRECTORY) next.dataset.directory = env.DTIS_DATA_DIRECTORY;
  if (env.DTIS_COMMANDS_ENABLED) next.commands.enabled = env.DTIS_COMMANDS_ENABLED === "true";
  if (env.DTIS_COMMAND_STORE_FILE) next.commands.storeFile = env.DTIS_COMMAND_STORE_FILE;
  if (env.DTIS_RETENTION_ENABLED) next.retention.enabled = env.DTIS_RETENTION_ENABLED === "true";
  if (env.DTIS_RETENTION_DEFAULT_DAYS) next.retention.defaultDays = Number(env.DTIS_RETENTION_DEFAULT_DAYS);
  if (env.DTIS_RETENTION_INTERVAL_MS) next.retention.intervalMs = Number(env.DTIS_RETENTION_INTERVAL_MS);
  if (env.DTIS_CACHE_TYPE) next.cache.type = env.DTIS_CACHE_TYPE as AppConfig["cache"]["type"];
  if (env.DTIS_CACHE_TTL_MS) next.cache.ttlMs = Number(env.DTIS_CACHE_TTL_MS);
  if (env.DTIS_CACHE_REDIS_URL) next.cache.redisUrl = env.DTIS_CACHE_REDIS_URL;
  if (env.DTIS_IDEMPOTENCY_PROVIDER) next.idempotency.provider = env.DTIS_IDEMPOTENCY_PROVIDER as AppConfig["idempotency"]["provider"];
  if (env.DTIS_REDIS_URL) { next.idempotency.provider = "redis"; next.idempotency.redisUrl = env.DTIS_REDIS_URL; }
  return next;
}

export async function loadConfig(path = process.env.DTIS_CONFIG ?? "./config/config.yaml", env = process.env) {
  let fileConfig: Partial<AppConfig> = {};
  try {
    const parsed = YAML.parse(await readFile(resolve(path), "utf8")) as Partial<AppConfig> & {
      datasetAggregation?: Partial<AppConfig["dataset"]["aggregation"]>;
      storage?: Partial<StorageConfig> & { provider?: string; filesystem?: Record<string, unknown>; s3?: Record<string, unknown> };
    };
    if (parsed.datasetAggregation) {
      parsed.dataset = { ...defaults.dataset, ...parsed.dataset, aggregation: { ...defaults.dataset.aggregation, ...parsed.dataset?.aggregation, ...parsed.datasetAggregation } };
      delete parsed.datasetAggregation;
    }
    if (parsed.storage?.provider) parsed.storage = normalizeSingleStorage(parsed.storage);
    fileConfig = parsed;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const config = applyEnvironment(merge(defaults, fileConfig), env);
  const local = config.storage.providers.local;
  if (local?.type === "filesystem" && local.basePath === "./data" && config.dataset.directory !== "./data") {
    local.basePath = config.dataset.directory;
  }
  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    throw new AppError("CONFIG_INVALID_PORT", "server.port must be between 1 and 65535", 500, "VALIDATION");
  }
  if (!Number.isInteger(config.server.bodyLimitBytes) || config.server.bodyLimitBytes < 1024) {
    throw new AppError("CONFIG_INVALID_BODY_LIMIT", "server.bodyLimitBytes must be at least 1024", 500, "VALIDATION");
  }
  if (!["disabled", "api-key", "jwt"].includes(config.security.authMode)) {
    throw new AppError("CONFIG_INVALID_AUTH", "security.authMode is invalid", 500, "VALIDATION");
  }
  if (!config.dataset.aggregation.defaultWindowSeconds || config.dataset.aggregation.defaultWindowSeconds < 1) {
    throw new AppError("CONFIG_INVALID_DATASET_WINDOW", "dataset aggregation window must be at least one second", 500, "VALIDATION");
  }
  if (!Number.isInteger(config.queue.maxAttempts) || config.queue.maxAttempts < 1) {
    throw new AppError("CONFIG_INVALID_QUEUE_ATTEMPTS", "queue.maxAttempts must be at least one", 500, "VALIDATION");
  }
  if (!["memory", "redis"].includes(config.idempotency.provider)) {
    throw new AppError("CONFIG_INVALID_IDEMPOTENCY", "idempotency.provider is invalid", 500, "VALIDATION");
  }
  if (!["memory", "redis"].includes(config.cache.type)) {
    throw new AppError("CONFIG_INVALID_CACHE", "cache.type is invalid", 500, "VALIDATION");
  }
  if (!Number.isInteger(config.cache.ttlMs) || config.cache.ttlMs < 1) {
    throw new AppError("CONFIG_INVALID_CACHE_TTL", "cache.ttlMs must be a positive integer", 500, "VALIDATION");
  }
  if (config.commands.enabled && !config.connectors.mqtt?.enabled) {
    throw new AppError("CONFIG_COMMANDS_MQTT_REQUIRED", "commands.enabled requires the MQTT connector", 500, "VALIDATION");
  }
  if (!Array.isArray(config.commands.catalogs)) {
    throw new AppError("CONFIG_COMMAND_CATALOG_INVALID", "commands.catalogs must be an array", 500, "VALIDATION");
  }
  if (!Number.isFinite(config.retention.defaultDays) || config.retention.defaultDays < 1) {
    throw new AppError("CONFIG_RETENTION_DAYS_INVALID", "retention.defaultDays must be at least one day", 500, "VALIDATION");
  }
  if (!Number.isInteger(config.retention.intervalMs) || config.retention.intervalMs < 60_000) {
    throw new AppError("CONFIG_RETENTION_INTERVAL_INVALID", "retention.intervalMs must be at least 60000", 500, "VALIDATION");
  }
  if (!Number.isInteger(config.retention.maxDeletesPerRun) || config.retention.maxDeletesPerRun < 1) {
    throw new AppError("CONFIG_RETENTION_BATCH_INVALID", "retention.maxDeletesPerRun must be at least one", 500, "VALIDATION");
  }
  for (const policy of config.retention.ownerPolicies) {
    if (!policy.ownerDid || (policy.retentionDays !== null && (!Number.isFinite(policy.retentionDays) || policy.retentionDays < 1))) throw new AppError("CONFIG_RETENTION_OWNER_POLICY_INVALID", "Owner retention policies require an ownerDid and retentionDays >= 1 or null", 500, "VALIDATION");
  }
  if (config.cache.type === "redis" && !(config.cache.redisUrl ?? config.idempotency.redisUrl)) {
    throw new AppError("CONFIG_CACHE_REDIS_URL_REQUIRED", "Redis cache requires cache.redisUrl or idempotency.redisUrl", 500, "VALIDATION");
  }
  validateStorage(config.storage);
  return config;
}

function normalizeSingleStorage(storage: Partial<StorageConfig> & { provider?: string; filesystem?: Record<string, unknown>; s3?: Record<string, unknown> }): StorageConfig {
  const type = storage.provider === "minio" ? "s3" : storage.provider;
  if (type !== "filesystem" && type !== "s3" && type !== "azure-blob" && type !== "ipfs") {
    throw new AppError("CONFIG_INVALID_STORAGE_PROVIDER", `Unknown storage provider '${String(storage.provider)}'`, 500, "VALIDATION");
  }
  const details = type === "filesystem" ? storage.filesystem : type === "s3" ? storage.s3 : {};
  return {
    defaultProvider: "default",
    providers: { default: { type, ...(details ?? {}) } as StorageProviderConfig },
    routes: storage.routes ?? {},
  };
}

function validateStorage(storage: StorageConfig) {
  if (!storage.providers[storage.defaultProvider]) {
    throw new AppError("CONFIG_STORAGE_DEFAULT_MISSING", `Default storage provider '${storage.defaultProvider}' is not configured`, 500, "VALIDATION");
  }
  for (const [category, provider] of Object.entries(storage.routes)) {
    if (!storage.providers[provider]) throw new AppError("CONFIG_STORAGE_ROUTE_INVALID", `Storage route '${category}' references unknown provider '${provider}'`, 500, "VALIDATION");
  }
  for (const [name, provider] of Object.entries(storage.providers)) {
    if (provider.type === "filesystem" && !provider.basePath) {
      throw new AppError("CONFIG_STORAGE_BASE_PATH_REQUIRED", `Filesystem provider '${name}' requires basePath`, 500, "VALIDATION");
    }
    if (provider.type === "s3") {
      if (!provider.bucket) throw new AppError("CONFIG_STORAGE_BUCKET_REQUIRED", `S3 provider '${name}' requires bucket`, 500, "VALIDATION");
      if (!provider.region) throw new AppError("CONFIG_STORAGE_REGION_REQUIRED", `S3 provider '${name}' requires region`, 500, "VALIDATION");
      if (Boolean(provider.accessKeyEnv) !== Boolean(provider.secretKeyEnv)) {
        throw new AppError("CONFIG_STORAGE_CREDENTIAL_PAIR_REQUIRED", `S3 provider '${name}' must configure both credential names or use the default AWS credential chain`, 500, "VALIDATION");
      }
    }
  }
}
