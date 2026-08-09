import { LocalFilesystemStorageProvider } from "../storage/filesystem.js";

/** @deprecated Use StorageProvider/StorageRouter. Kept for source compatibility. */
export interface DatasetStorageProvider {
  store(data: Buffer | string, contentType?: string): Promise<{ uri: string; hash: string; size?: number; contentType?: string }>;
}

/** @deprecated Runtime construction now uses StorageProviderFactory. */
export class LocalFilesystemDatasetStorage implements DatasetStorageProvider {
  private readonly provider: LocalFilesystemStorageProvider;
  constructor(directory: string) {
    this.provider = new LocalFilesystemStorageProvider({ type: "filesystem", basePath: directory, uriPrefix: "file://" });
  }
  async store(data: Buffer | string, contentType = "application/json") {
    return this.provider.store({ data: Buffer.isBuffer(data) ? data : Buffer.from(data), contentType, category: "dataset", fileName: "dataset.json" });
  }
}
