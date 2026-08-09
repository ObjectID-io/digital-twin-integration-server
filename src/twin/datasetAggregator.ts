import { datasetSamples, datasetWindowsActive } from "../health/metrics.js";
import { logger } from "../common/logger.js";
import type { DatasetStorageProvider } from "./datasetStorage.js";
import type { StorageProvider } from "../storage/types.js";

export interface DatasetSample { observedAt: number; value: unknown }
export interface DatasetMetadata {
  twinId?: string;
  source?: string;
  datasetType?: string;
  schemaUri?: string;
  profile?: string;
  [key: string]: unknown;
}

interface WindowState {
  samples: DatasetSample[];
  fromTimestamp: number;
  toTimestamp: number;
  timer: NodeJS.Timeout;
  metadata: DatasetMetadata;
}

export class DatasetWindowAggregator {
  private readonly windows = new Map<string, WindowState>();
  constructor(
    private readonly defaultWindowMs: number,
    private readonly storage: DatasetStorageProvider | StorageProvider,
    private readonly onDataset: (key: string, dataset: Record<string, unknown>) => Promise<void>,
  ) {}

  ingest(key: string, value: unknown, metadata: DatasetMetadata, observedAt = Date.now(), windowMs = this.defaultWindowMs) {
    const current = this.windows.get(key);
    if (current) {
      current.samples.push({ observedAt, value });
      current.toTimestamp = observedAt;
      datasetSamples.inc();
      return;
    }
    const timer = setTimeout(() => {
      void this.flush(key).catch((error) => logger.error({ key, error }, "dataset_window_flush_failed"));
    }, windowMs);
    timer.unref();
    this.windows.set(key, {
      samples: [{ observedAt, value }], fromTimestamp: observedAt, toTimestamp: observedAt, timer, metadata,
    });
    datasetSamples.inc();
    datasetWindowsActive.set(this.windows.size);
  }

  async flush(key: string) {
    const current = this.windows.get(key);
    if (!current) return;
    this.windows.delete(key);
    clearTimeout(current.timer);
    datasetWindowsActive.set(this.windows.size);
    const legacy = !current.metadata.twinId || !current.metadata.source;
    const content = legacy ? current.samples.map((sample) => sample.value) : {
      twinId: current.metadata.twinId,
      source: current.metadata.source,
      fromTimestamp: current.fromTimestamp,
      toTimestamp: current.toTimestamp,
      samples: current.samples,
      schemaUri: current.metadata.schemaUri,
      profile: current.metadata.profile,
    };
    const serialized = JSON.stringify(content);
    const stored = "type" in this.storage
      ? await this.storage.store({
        data: Buffer.from(serialized), contentType: "application/json", fileName: "dataset.json",
        category: "dataset", twinId: current.metadata.twinId,
        metadata: { datasetType: String(current.metadata.datasetType ?? "dataset") },
      })
      : legacy ? await this.storage.store(serialized) : await this.storage.store(serialized, "application/json");
    await this.onDataset(key, {
      ...current.metadata,
      storageUri: stored.uri,
      payloadHash: stored.hash,
      payloadSize: stored.size ?? Buffer.byteLength(serialized),
      contentType: stored.contentType ?? "application/json",
      periodFrom: current.fromTimestamp,
      periodTo: current.toTimestamp,
      sampleCount: current.samples.length,
    });
  }

  activeWindows() { return this.windows.size; }
  async close() { await Promise.all([...this.windows.keys()].map((key) => this.flush(key))); }
}
