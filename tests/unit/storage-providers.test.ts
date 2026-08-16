import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalFilesystemStorageProvider } from "../../src/storage/filesystem.js";
import { S3StorageProvider } from "../../src/storage/s3.js";
import { StorageRouter } from "../../src/storage/storage-router.js";
import type { StorageProvider } from "../../src/storage/types.js";
import { EnvironmentCredentialProvider } from "../../src/security/credentials.js";
import { DatasetWindowAggregator } from "../../src/twin/datasetAggregator.js";

describe("storage providers", () => {
  it("stores and reads exact filesystem bytes with hash, size and NAS URI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dtis-storage-"));
    try {
      const provider = new LocalFilesystemStorageProvider({ type: "filesystem", basePath: directory, uriPrefix: "nas://factory/objectid" });
      const bytes = Buffer.from([0, 1, 2, 3, 255]);
      const stored = await provider.store({ data: bytes, twinId: "0xtwin", category: "model", fileName: "cad.step", contentType: "model/step" });
      expect(stored).toMatchObject({ hashAlgorithm: "sha256", size: 5, contentType: "model/step" });
      expect(stored.hash).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      expect(stored.uri).toMatch(/^nas:\/\/factory\/objectid\/twins\/0xtwin\/models\//);
      expect(await provider.read(stored.uri)).toEqual(bytes);
      expect(await provider.exists(stored.uri)).toBe(true);
      expect(await provider.listManagedObjects()).toEqual([expect.objectContaining({ uri: stored.uri, twinId: "0xtwin", category: "models", size: 5 })]);
      expect((await provider.healthCheck()).healthy).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("puts exact bytes in an S3-compatible bucket and returns a stable URI", async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const provider = new S3StorageProvider(
      { type: "s3", endpoint: "http://minio:9000", region: "local", bucket: "twins", prefix: "customer/", forcePathStyle: true },
      new EnvironmentCredentialProvider({}), { send },
    );
    const bytes = Buffer.from("telemetry");
    const stored = await provider.store({ data: bytes, twinId: "0xtwin", category: "dataset", fileName: "window.json", contentType: "application/json" });
    const command = send.mock.calls[0]![0] as any;
    expect(command.constructor.name).toBe("PutObjectCommand");
    expect(command.input).toMatchObject({ Bucket: "twins", Body: bytes, ContentType: "application/json" });
    expect(command.input.Key).toMatch(/^customer\/twins\/0xtwin\/datasets\/.+-window.json$/);
    expect(stored.uri).toBe(`s3://twins/${command.input.Key}`);
    expect(stored.hash).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  });

  it("paginates only the managed S3 Twin namespace for retention", async () => {
    const send = vi.fn(async (command: any) => command.constructor.name === "ListObjectsV2Command" ? {
      Contents: [{ Key: "customer/twins/0xtwin/datasets/hash-window.json", LastModified: new Date("2026-08-01T00:00:00Z"), Size: 42 }],
      IsTruncated: false,
    } : {});
    const provider = new S3StorageProvider(
      { type: "s3", region: "local", bucket: "twins", prefix: "customer/" },
      new EnvironmentCredentialProvider({}), { send },
    );
    expect(await provider.listManagedObjects()).toEqual([{ uri: "s3://twins/customer/twins/0xtwin/datasets/hash-window.json", twinId: "0xtwin", category: "datasets", createdAt: "2026-08-01T00:00:00.000Z", size: 42 }]);
    expect((send.mock.calls[0]![0] as any).input.Prefix).toBe("customer/twins/");
  });

  it("routes dataset and model categories to different providers", async () => {
    const dataset = fakeProvider("dataset");
    const model = fakeProvider("model");
    const router = new StorageRouter(
      { defaultProvider: "dataset", providers: { dataset: { type: "filesystem", basePath: "/tmp/a" }, model: { type: "filesystem", basePath: "/tmp/b" } }, routes: { model: "model" } },
      new Map([["dataset", dataset.provider], ["model", model.provider]]),
    );
    await router.store({ data: Buffer.from("a"), category: "dataset" });
    await router.store({ data: Buffer.from("b"), category: "model" });
    expect(dataset.store).toHaveBeenCalledTimes(1);
    expect(model.store).toHaveBeenCalledTimes(1);
  });

  it("aggregates a dataset through the S3 abstraction and registers its URI/hash", async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const provider = new S3StorageProvider(
      { type: "s3", region: "local", bucket: "twins", prefix: "telemetry/" },
      new EnvironmentCredentialProvider({}), { send },
    );
    const committed = vi.fn(async (_key: string, _dataset: Record<string, unknown>) => undefined);
    const aggregator = new DatasetWindowAggregator(60_000, provider, committed);

    aggregator.ingest("line-1", { temperature: 21.5 }, { twinId: "0xtwin", source: "mqtt", datasetType: "telemetry" }, 1000);
    await aggregator.flush("line-1");

    const command = send.mock.calls[0]![0] as any;
    const storedBytes = command.input.Body as Buffer;
    const expectedHash = `sha256:${createHash("sha256").update(storedBytes).digest("hex")}`;
    expect(command.input).toMatchObject({ Bucket: "twins", ContentType: "application/json" });
    expect(committed).toHaveBeenCalledWith("line-1", expect.objectContaining({
      storageUri: `s3://twins/${command.input.Key}`,
      payloadHash: expectedHash,
      payloadSize: storedBytes.length,
      sampleCount: 1,
    }));
  });
});

function fakeProvider(name: string) {
  const store = vi.fn(async () => ({ uri: `mock://${name}`, hash: "sha256:test", hashAlgorithm: "sha256" as const, size: 1 }));
  const provider: StorageProvider = { type: name, store, async healthCheck() { return { healthy: true, checkedAt: new Date().toISOString() }; } };
  return { provider, store };
}
