import { AppError } from "../common/errors.js";
import type { CredentialProvider } from "../security/credentials.js";
import { LocalFilesystemStorageProvider } from "./filesystem.js";
import { S3StorageProvider } from "./s3.js";
import { StorageRouter } from "./storage-router.js";
import type { StorageConfig, StorageProvider, StorageProviderConfig } from "./types.js";

export class StorageProviderFactory {
  constructor(private readonly credentials: CredentialProvider) {}

  create(config: StorageProviderConfig): StorageProvider {
    if (config.type === "filesystem") return new LocalFilesystemStorageProvider(config);
    if (config.type === "s3") return new S3StorageProvider(config, this.credentials);
    throw new AppError(
      "STORAGE_PROVIDER_NOT_IMPLEMENTED",
      `Storage provider '${config.type}' is planned but not implemented`,
      501,
      "CONNECTOR",
    );
  }

  createRouter(config: StorageConfig) {
    const providers = new Map<string, StorageProvider>();
    for (const [name, providerConfig] of Object.entries(config.providers)) {
      try { providers.set(name, this.create(providerConfig)); }
      catch (error) {
        const referenced = name === config.defaultProvider || Object.values(config.routes).includes(name) || providerConfig.required === true;
        if (referenced) throw error;
      }
    }
    return new StorageRouter(config, providers);
  }
}
