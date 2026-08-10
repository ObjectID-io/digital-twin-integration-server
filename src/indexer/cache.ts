import type { AppConfig } from "../config/types.js";
import type { TwinEvent } from "../objectid/types.js";

export interface TwinEventCache {
  get(key: string): Promise<TwinEvent[] | undefined>;
  set(key: string, events: TwinEvent[]): Promise<void>;
  close(): Promise<void>;
}

export class MemoryTwinEventCache implements TwinEventCache {
  private readonly entries = new Map<string, { events: TwinEvent[]; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  async get(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.events;
    this.entries.delete(key);
    return undefined;
  }

  async set(key: string, events: TwinEvent[]) {
    this.entries.set(key, { events, expiresAt: Date.now() + this.ttlMs });
  }

  async close() { this.entries.clear(); }
}

export class RedisTwinEventCache implements TwinEventCache {
  private client?: any;

  constructor(private readonly url: string, private readonly ttlMs: number, private readonly prefix = "dtis:thread:") {}

  private async connectedClient() {
    if (!this.client) {
      const { createClient } = await import("redis");
      this.client = createClient({ url: this.url });
      this.client.on("error", () => undefined);
      await this.client.connect();
    }
    return this.client;
  }

  async get(key: string) {
    const value = await (await this.connectedClient()).get(this.prefix + key);
    return value ? JSON.parse(value) as TwinEvent[] : undefined;
  }

  async set(key: string, events: TwinEvent[]) {
    await (await this.connectedClient()).set(this.prefix + key, JSON.stringify(events), { PX: this.ttlMs });
  }

  async close() { if (this.client?.isOpen) await this.client.quit(); }
}

export function createTwinEventCache(config: AppConfig): TwinEventCache {
  if (config.cache.type === "redis") {
    const url = config.cache.redisUrl ?? config.idempotency.redisUrl;
    if (!url) throw new Error("Redis cache requires cache.redisUrl or idempotency.redisUrl");
    return new RedisTwinEventCache(url, config.cache.ttlMs);
  }
  return new MemoryTwinEventCache(config.cache.ttlMs);
}
