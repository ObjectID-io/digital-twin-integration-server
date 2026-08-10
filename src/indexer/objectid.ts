import { AppError } from "../common/errors.js";
import type { AppConfig } from "../config/types.js";
import type { ObjectIdAdapter, TwinEvent } from "../objectid/types.js";
import { createTwinEventCache, type TwinEventCache } from "./cache.js";
import type { IndexerCheckpoint, PaginationOptions, TwinIndexer } from "./types.js";

export const INDEXER_SCHEMA_VERSION = "1.1.0";

export class ObjectIdIndexerAdapter implements TwinIndexer {
  private readonly cache: TwinEventCache;

  constructor(private readonly objectid: ObjectIdAdapter, private readonly config: AppConfig) {
    this.cache = createTwinEventCache(config);
  }

  async findTwinByIdentifier(scheme: string, value: string) {
    const found = await this.objectid.findTwinByIdentifier(scheme, value);
    return found ? [found] : [];
  }

  async findTwinEvents(twinId: string, options: PaginationOptions = {}) {
    if (this.objectid.findIndexedTwinEvents) {
      try {
        return await this.objectid.findIndexedTwinEvents(twinId, options);
      } catch (error) {
        if (!isIndexerUnavailable(error)) throw error;
      }
    }
    return this.findTwinEventsOnChain(twinId, options);
  }

  private async findTwinEventsOnChain(twinId: string, options: PaginationOptions) {
    const cacheKey = `${this.config.objectid.network}:${this.config.objectid.packageId}:${twinId}`;
    let events: TwinEvent[] | undefined;
    try { events = await this.cache.get(cacheKey); } catch { events = undefined; }
    if (!events) {
      try {
        events = await this.objectid.getDigitalThread(twinId);
      } catch (error) {
        throw new AppError(
          "IOTA_EVENT_READ_FAILED",
          `Unable to read OIDTwinEvent objects for Twin '${twinId}'`,
          503,
          "NETWORK",
          { twinId, retryable: true, cause: error instanceof Error ? error.message : String(error) },
        );
      }
      events = [...events].sort(compareEvents);
      try { await this.cache.set(cacheKey, events); } catch { /* Cache failure must not hide on-chain data. */ }
    }

    const filtered = events.filter((event) => matches(event, options));
    const offset = decodeCursor(options.cursor);
    const limit = normalizedLimit(options.limit);
    if (offset > filtered.length) {
      throw new AppError("INDEXER_CURSOR_INVALID", "Digital Thread cursor is outside the result set", 400, "VALIDATION");
    }
    const items = filtered.slice(offset, offset + limit);
    const hasMore = offset + items.length < filtered.length;
    return {
      items,
      nextCursor: hasMore ? Buffer.from(String(offset + items.length)).toString("base64url") : undefined,
      hasMore,
      complete: true,
    };
  }

  async findMappings(identifierId: string) {
    return this.objectid.findIdentifierMappings ? this.objectid.findIdentifierMappings(identifierId) : [];
  }

  async transactionExists(digest: string) {
    return this.objectid.transactionExists ? this.objectid.transactionExists(digest) : undefined;
  }

  async getCheckpoint(): Promise<IndexerCheckpoint | null> {
    const external = await this.objectid.getIndexerCheckpoint?.();
    if (!external) return null;
    return {
      checkpoint: String(external.checkpoint), network: this.config.objectid.network,
      packageId: this.config.objectid.packageId, indexerVersion: INDEXER_SCHEMA_VERSION,
      updatedAt: String(external.updatedAt ?? new Date().toISOString()),
    };
  }

  async resume() { await this.objectid.resumeIndexer?.(); }
  async rebuild() { await this.objectid.rebuildIndexer?.(); }
  async close() { await this.cache.close(); }
}

function compareEvents(a: TwinEvent, b: TwinEvent) {
  return a.revisionAfter - b.revisionAfter || a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId);
}

function matches(event: TwinEvent, options: PaginationOptions) {
  return (options.fromRevision === undefined || event.revisionAfter >= options.fromRevision)
    && (options.toRevision === undefined || event.revisionAfter <= options.toRevision)
    && (!options.eventTypes?.length || options.eventTypes.includes(event.eventType))
    && (options.fromTimestamp === undefined || event.createdAt >= options.fromTimestamp)
    && (options.toTimestamp === undefined || event.createdAt <= options.toTimestamp);
}

function normalizedLimit(limit?: number) {
  const value = limit ?? 100;
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError("INDEXER_LIMIT_INVALID", "Digital Thread limit must be a positive integer", 400, "VALIDATION");
  }
  return Math.min(value, 500);
}

function decodeCursor(cursor?: string) {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const offset = Number(decoded);
  if (!/^\d+$/.test(decoded) || !Number.isSafeInteger(offset)) {
    throw new AppError("INDEXER_CURSOR_INVALID", "Digital Thread cursor is invalid", 400, "VALIDATION");
  }
  return offset;
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

function isIndexerUnavailable(error: unknown) {
  if (errorCode(error) === "OBJECTID_EVENT_INDEXER_REQUIRED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not initialized|not implemented|indexed twin event.*unavailable/i.test(message);
}

export { ObjectIdIndexerAdapter as ObjectIdTwinIndexer };
