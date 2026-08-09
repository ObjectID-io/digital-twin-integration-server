import { AppError } from "../common/errors.js";
import type { AppConfig } from "../config/types.js";
import type { ObjectIdAdapter } from "../objectid/types.js";
import type { IndexerCheckpoint, PaginationOptions, TwinIndexer } from "./types.js";

export const INDEXER_SCHEMA_VERSION = "1.1.0";

export class ObjectIdIndexerAdapter implements TwinIndexer {
  constructor(private readonly objectid: ObjectIdAdapter, private readonly config: AppConfig) {}

  async findTwinByIdentifier(scheme: string, value: string) {
    const found = await this.objectid.findTwinByIdentifier(scheme, value);
    return found ? [found] : [];
  }

  async findTwinEvents(twinId: string, options: PaginationOptions = {}) {
    if (!this.objectid.findIndexedTwinEvents) {
      throw new AppError(
        "OBJECTID_EVENT_INDEXER_REQUIRED",
        "The configured ObjectID provider does not expose indexed Twin event pagination",
        501,
        "OBJECTID",
      );
    }
    return this.objectid.findIndexedTwinEvents(twinId, options);
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
}

export { ObjectIdIndexerAdapter as ObjectIdTwinIndexer };
