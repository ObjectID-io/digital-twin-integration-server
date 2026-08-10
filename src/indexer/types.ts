import type { TwinEvent } from "../objectid/types.js";

export interface PaginationOptions {
  cursor?: string;
  limit?: number;
  fromRevision?: number;
  toRevision?: number;
  eventTypes?: number[];
  fromTimestamp?: number;
  toTimestamp?: number;
}

export interface IndexedPage<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
  complete?: boolean;
  reason?: string;
}

export interface TwinIdentifierMatch {
  twinId: string;
  identifier: unknown;
}

export interface IndexerCheckpoint {
  checkpoint: string;
  network: string;
  packageId: string;
  indexerVersion: string;
  updatedAt: string;
}

export interface TwinIndexer {
  findTwinByIdentifier(scheme: string, value: string): Promise<TwinIdentifierMatch[]>;
  findTwinEvents(twinId: string, options?: PaginationOptions): Promise<IndexedPage<TwinEvent>>;
  findMappings(identifierId: string): Promise<unknown[]>;
  transactionExists?(digest: string): Promise<boolean | undefined>;
  getCheckpoint?(): Promise<IndexerCheckpoint | null>;
  resume?(): Promise<void>;
  rebuild?(): Promise<void>;
  close?(): Promise<void>;
}
