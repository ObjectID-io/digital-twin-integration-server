import type { AppConfig } from "../config/types.js";
import { AppError } from "../common/errors.js";
import { MemoryIdempotencyStore, RedisIdempotencyStore, type IdempotencyStore } from "./idempotency.js";

export function createIdempotencyStore(config: AppConfig): IdempotencyStore {
  if (config.idempotency.provider === "redis") {
    if (!config.idempotency.redisUrl) throw new AppError("REDIS_URL_REQUIRED", "idempotency.redisUrl is required for Redis", 500, "VALIDATION");
    return new RedisIdempotencyStore(config.idempotency.redisUrl);
  }
  return new MemoryIdempotencyStore(config.idempotency.ttlMs);
}
