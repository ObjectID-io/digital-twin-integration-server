export type AuthMode = "disabled" | "api-key" | "jwt";
import type { StorageConfig } from "../storage/types.js";

export interface AppConfig {
  server: { host: string; port: number; bodyLimitBytes: number; trustProxy: boolean };
  objectid: {
    network: string;
    rpcUrl: string;
    packageId: string;
    timeoutMs: number;
    signer?: {
      enabled: boolean;
      seedCredential: string;
      addressCredential: string;
      controllerCapCredential: string;
      creditPolicyCredential: string;
      creditTokenCredential: string;
      clockId: string;
      gasBudget: number;
    };
  };
  profiles: { directory: string };
  connectors: Record<string, { enabled: boolean; [key: string]: unknown }>;
  security: {
    credentialProvider: "environment" | "file";
    credentialFile?: string;
    authMode: AuthMode;
    apiKeyCredential: string;
    jwtSecretCredential: string;
    serviceDid?: string;
    rateLimitPerMinute: number;
  };
  cache: { type: "memory" | "redis"; ttlMs: number; redisUrl?: string };
  policy: { cacheTtlMs: number };
  queue: { type: "memory"; maxAttempts: number; baseDelayMs: number; maxDelayMs: number; pollIntervalMs: number };
  idempotency: { provider: "memory" | "redis"; ttlMs: number; redisUrl?: string };
  dataset: {
    directory: string;
    aggregation: { enabled: boolean; defaultWindowSeconds: number; shutdownFlushTimeoutMs: number };
  };
  storage: StorageConfig;
}
