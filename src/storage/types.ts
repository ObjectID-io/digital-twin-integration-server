import type { Readable } from "node:stream";
import type { HealthStatus } from "../connectors/types.js";

export interface StoreInput {
  data: Buffer | Readable;
  contentType?: string;
  fileName?: string;
  category?: string;
  twinId?: string;
  metadata?: Record<string, string>;
}

export interface StoredObject {
  uri: string;
  hash: string;
  hashAlgorithm: "sha256";
  size: number;
  contentType?: string;
}

export interface ManagedStoredObject {
  uri: string;
  twinId: string;
  category: string;
  createdAt: string;
  size?: number;
}

export interface StorageProvider {
  readonly type: string;
  store(input: StoreInput): Promise<StoredObject>;
  read?(uri: string): Promise<Buffer | Readable>;
  exists?(uri: string): Promise<boolean>;
  delete?(uri: string): Promise<void>;
  listManagedObjects?(): Promise<ManagedStoredObject[]>;
  healthCheck(): Promise<HealthStatus>;
  supportsUri?(uri: string): boolean;
}

export type FilesystemStorageConfig = {
  type: "filesystem";
  basePath: string;
  uriPrefix?: string;
  createDirectories?: boolean;
  writable?: boolean;
  required?: boolean;
};

export type S3StorageConfig = {
  type: "s3";
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyEnv?: string;
  secretKeyEnv?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  required?: boolean;
};

export type PlannedStorageConfig = {
  type: "azure-blob" | "ipfs";
  required?: boolean;
  [key: string]: unknown;
};

export type StorageProviderConfig = FilesystemStorageConfig | S3StorageConfig | PlannedStorageConfig;

export interface StorageConfig {
  defaultProvider: string;
  providers: Record<string, StorageProviderConfig>;
  routes: Record<string, string>;
}

export interface RetentionConfig {
  enabled: boolean;
  defaultDays: number;
  intervalMs: number;
  startupDelayMs: number;
  maxDeletesPerRun: number;
  ownerPolicies: Array<{ ownerDid: string; retentionDays: number | null }>;
}
