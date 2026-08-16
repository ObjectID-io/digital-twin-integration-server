import { AppError } from "../common/errors.js";
import type { StorageConfig, StorageProvider, StoreInput } from "./types.js";

export class StorageRouter implements StorageProvider {
  readonly type = "router";
  constructor(
    private readonly config: StorageConfig,
    private readonly providers: Map<string, StorageProvider>,
  ) {}

  providerNameFor(category = "artifact") { return this.config.routes[category] ?? this.config.defaultProvider; }

  providerFor(category = "artifact") {
    const name = this.providerNameFor(category);
    const provider = this.providers.get(name);
    if (!provider) throw new AppError("STORAGE_PROVIDER_UNAVAILABLE", `Storage provider '${name}' is unavailable`, 503, "CONNECTOR");
    return provider;
  }

  store(input: StoreInput) { return this.providerFor(input.category).store(input); }

  async read(uri: string) {
    const provider = this.providerForUri(uri);
    if (!provider.read) throw new AppError("STORAGE_READ_UNSUPPORTED", "Selected storage provider does not support reads", 405, "CONNECTOR");
    return provider.read(uri);
  }

  async exists(uri: string) {
    const provider = this.providerForUri(uri);
    return provider.exists ? provider.exists(uri) : false;
  }

  async delete(uri: string) {
    const provider = this.providerForUri(uri);
    if (!provider.delete) throw new AppError("STORAGE_DELETE_UNSUPPORTED", "Selected storage provider does not support deletion", 405, "CONNECTOR");
    await provider.delete(uri);
  }

  async listManagedObjects() {
    return (await Promise.all([...this.providers.values()].map((provider) => provider.listManagedObjects?.() ?? Promise.resolve([])))).flat();
  }

  async health() {
    const statuses = Object.fromEntries(await Promise.all([...this.providers].map(async ([name, provider]) => [name, await provider.healthCheck()])));
    const required = new Set([this.config.defaultProvider, ...Object.values(this.config.routes)]);
    for (const [name, providerConfig] of Object.entries(this.config.providers)) if (providerConfig.required === true) required.add(name);
    const requiredReady = [...required].every((name) => statuses[name]?.healthy === true);
    return { requiredReady, providers: statuses };
  }

  async healthCheck() {
    const health = await this.health();
    return { healthy: health.requiredReady, message: health.requiredReady ? undefined : "A required storage provider is unavailable", checkedAt: new Date().toISOString() };
  }

  supportsUri(uri: string) { return [...this.providers.values()].some((provider) => provider.supportsUri?.(uri)); }

  private providerForUri(uri: string) {
    const provider = [...this.providers.values()].find((candidate) => candidate.supportsUri?.(uri));
    if (!provider) throw new AppError("STORAGE_URI_UNSUPPORTED", "No configured storage provider owns this URI", 400, "VALIDATION");
    return provider;
  }
}
