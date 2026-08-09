import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../common/errors.js";
import { idempotencyHits } from "../health/metrics.js";

export interface IdempotencyEntry {
  fingerprint: string;
  status?: number;
  body?: unknown;
  state: "pending" | "complete";
  expiresAt: number;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyEntry | undefined>;
  put(key: string, entry: IdempotencyEntry): Promise<void>;
  acquire(key: string, fingerprint: string, ttlMs: number): Promise<{ acquired: boolean; entry?: IdempotencyEntry }>;
  delete(key: string): Promise<void>;
  clear(): Promise<void> | void;
  close(): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  constructor(private readonly ttlMs = 300_000) {}
  async get(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry;
    this.entries.delete(key);
    return undefined;
  }
  async put(key: string, entry: IdempotencyEntry) { this.entries.set(key, entry); }
  async acquire(key: string, fingerprint: string, ttlMs = this.ttlMs) {
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) return { acquired: false, entry: existing };
    this.entries.delete(key);
    this.entries.set(key, { fingerprint, state: "pending", expiresAt: Date.now() + ttlMs });
    return { acquired: true };
  }
  async delete(key: string) { this.entries.delete(key); }
  clear() { this.entries.clear(); }
  async close() {}
}

export class RedisIdempotencyStore implements IdempotencyStore {
  private client?: any;
  constructor(private readonly url: string, private readonly prefix = "dtis:idempotency:") {}

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
    return value ? JSON.parse(value) as IdempotencyEntry : undefined;
  }
  async put(key: string, entry: IdempotencyEntry) {
    const ttl = Math.max(1, entry.expiresAt - Date.now());
    await (await this.connectedClient()).set(this.prefix + key, JSON.stringify(entry), { PX: ttl });
  }
  async acquire(key: string, fingerprint: string, ttlMs: number) {
    const entry: IdempotencyEntry = { fingerprint, state: "pending", expiresAt: Date.now() + ttlMs };
    const result = await (await this.connectedClient()).set(this.prefix + key, JSON.stringify(entry), { PX: ttlMs, NX: true });
    return result === "OK" ? { acquired: true } : { acquired: false, entry: await this.get(key) };
  }
  async delete(key: string) { await (await this.connectedClient()).del(this.prefix + key); }
  async clear() {
    const client = await this.connectedClient();
    for await (const keys of client.scanIterator({ MATCH: `${this.prefix}*`, COUNT: 100 })) {
      if (keys.length) await client.del(keys);
    }
  }
  async close() { if (this.client?.isOpen) await this.client.quit(); }
}

function fingerprint(request: Request) {
  return createHash("sha256").update(JSON.stringify({ method: request.method, path: request.path, body: request.body })).digest("hex");
}

export function idempotencyMiddleware(store: IdempotencyStore, ttlMs = 300_000) {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();
    const key = request.header("idempotency-key");
    if (!key) return next();
    try {
      const requestFingerprint = fingerprint(request);
      const claim = await store.acquire(key, requestFingerprint, ttlMs);
      if (!claim.acquired) {
        if (claim.entry?.fingerprint !== requestFingerprint) {
          return next(new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was reused with a different request", 409, "VALIDATION"));
        }
        if (claim.entry.state === "complete") {
          idempotencyHits.inc();
          return response.status(claim.entry.status ?? 200).json(claim.entry.body);
        }
        return next(new AppError("IDEMPOTENCY_IN_PROGRESS", "A request with this Idempotency-Key is already in progress", 409, "VALIDATION"));
      }

      const originalJson = response.json.bind(response);
      response.json = ((body: unknown) => {
        if (response.statusCode < 500) {
          void store.put(key, { fingerprint: requestFingerprint, status: response.statusCode, body, state: "complete", expiresAt: Date.now() + ttlMs });
        } else void store.delete(key);
        return originalJson(body);
      }) as Response["json"];
      next();
    } catch (error) { next(error); }
  };
}
