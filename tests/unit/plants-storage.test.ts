import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlantService } from "../../src/plants/service.js";
import { EnvironmentCredentialProvider } from "../../src/security/credentials.js";
import { S3StorageProvider } from "../../src/storage/s3.js";
import { StorageRouter } from "../../src/storage/storage-router.js";
import { StorageRetentionService } from "../../src/storage/retention.js";
import { testConfig } from "../fixtures/config.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";

describe("plant storage routing and retention", () => {
  it("roundtrips encrypted plants via the S3 route without any external requests", async () => {
    const root = resolve("data");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "plants-s3-test-"));
    try {
      const objects = new Map<string, Buffer>();
      const send = vi.fn(async (command: any) => {
        if (command.constructor.name === "PutObjectCommand") { objects.set(command.input.Key, command.input.Body); return {}; }
        if (command.constructor.name === "GetObjectCommand") return { Body: { transformToByteArray: async () => objects.get(command.input.Key) } };
        if (command.constructor.name === "ListObjectsV2Command") return { Contents: [...objects.keys()].map((Key) => ({ Key, LastModified: new Date(0) })) };
        throw new Error("Unexpected S3 operation");
      });
      const credentials = new EnvironmentCredentialProvider({ DTIS_PLANT_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
      const providerConfig = { type: "s3" as const, bucket: "plant-test", region: "local" };
      const s3 = new S3StorageProvider(providerConfig, credentials, { send });
      const router = new StorageRouter({ defaultProvider: "unused", providers: { plants: providerConfig }, routes: { plants: "plants" } }, new Map([["plants", s3]]));
      const service = new PlantService(router, credentials, directory);
      await service.put("a", "plant-1", { revision: 0, document: { media: "secret bytes" }, publication: null });
      expect([...objects.keys()][0]).toMatch(/^twins\/unscoped\/plants\//);
      expect([...objects.values()][0]!.toString()).not.toContain("secret bytes");
      expect(await service.list("a")).toEqual([{ id: "plant-1", revision: 1, document: { media: "secret bytes" }, publication: null }]);
      expect(await router.listManagedObjects()).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("never prunes plants even if a provider lists them as managed and scoped", async () => {
    const storage = {
      listManagedObjects: async () => [
        { uri: "plant", twinId: "twin", category: "plants", createdAt: new Date(0).toISOString() },
        { uri: "unscoped", twinId: "unscoped", category: "artifact", createdAt: new Date(0).toISOString() },
      ],
      delete: vi.fn(),
    };
    const adapter = new FakeObjectIdAdapter();
    const owner = vi.spyOn(adapter, "getTwin");
    await new StorageRetentionService(testConfig().retention, storage as unknown as StorageRouter, adapter).run();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(owner).not.toHaveBeenCalled();
  });
});
