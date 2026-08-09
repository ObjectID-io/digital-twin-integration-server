import type { TwinEvent } from "../objectid/types.js";
import type { IndexerCheckpoint, PaginationOptions, TwinIdentifierMatch, TwinIndexer } from "./types.js";

export class InMemoryTwinIndexer implements TwinIndexer {
  readonly events = new Map<string, TwinEvent[]>();
  readonly identifiers = new Map<string, TwinIdentifierMatch[]>();
  readonly mappings = new Map<string, unknown[]>();
  readonly transactions = new Map<string, boolean | undefined>();
  checkpoint: IndexerCheckpoint | null = null;
  complete = true;
  incompleteReason = "Indexer/provider cannot enumerate the complete requested range";

  async findTwinByIdentifier(scheme: string, value: string) { return this.identifiers.get(`${scheme.toLowerCase()}:${value}`) ?? []; }

  async findTwinEvents(twinId: string, options: PaginationOptions = {}) {
    const filtered = (this.events.get(twinId) ?? []).filter((event) =>
      (options.fromRevision === undefined || event.revisionAfter >= options.fromRevision)
      && (options.toRevision === undefined || event.revisionAfter <= options.toRevision)
      && (!options.eventTypes?.length || options.eventTypes.includes(event.eventType))
      && (options.fromTimestamp === undefined || event.createdAt >= options.fromTimestamp)
      && (options.toTimestamp === undefined || event.createdAt <= options.toTimestamp));
    const offset = decodeCursor(options.cursor);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const items = filtered.slice(offset, offset + limit);
    const hasMore = offset + items.length < filtered.length;
    return {
      items, hasMore, nextCursor: hasMore ? encodeCursor(offset + items.length) : undefined,
      complete: this.complete, reason: this.complete ? undefined : this.incompleteReason,
    };
  }

  async findMappings(identifierId: string) { return this.mappings.get(identifierId) ?? []; }
  async transactionExists(digest: string) { return this.transactions.get(digest); }
  async getCheckpoint() { return this.checkpoint; }
  async resume() {}
  async rebuild() { this.events.clear(); this.identifiers.clear(); this.mappings.clear(); }
}

function encodeCursor(offset: number) { return Buffer.from(String(offset)).toString("base64url"); }
function decodeCursor(cursor?: string) {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
