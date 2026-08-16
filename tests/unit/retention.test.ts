import { describe, expect, it } from "vitest";
import { ConfigRetentionPolicyResolver, StorageRetentionService } from "../../src/storage/retention.js";
import type { RetentionConfig } from "../../src/storage/types.js";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const DAY = 86_400_000;

function config(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return { enabled: true, defaultDays: 5, intervalMs: 3_600_000, startupDelayMs: 60_000, maxDeletesPerRun: 500, ownerPolicies: [], ...overrides };
}

function service(objects: any[], owners: Record<string, string | null>, retention = config()) {
  const deleted: string[] = [];
  const storage = { async listManagedObjects() { return objects; }, async delete(uri: string) { deleted.push(uri); } } as any;
  const objectid = { async getTwin(twinId: string) { const ownerDid = owners[twinId]; return ownerDid ? { fields: { owner_did: ownerDid } } : null; } } as any;
  return { deleted, retention: new StorageRetentionService(retention, storage, objectid, new ConfigRetentionPolicyResolver(retention), () => NOW) };
}

describe("managed storage retention", () => {
  it("deletes only managed objects older than the default five-day policy", async () => {
    const { deleted, retention } = service([
      { uri: "s3://bucket/twins/0xa/dataset/old", twinId: "0xa", category: "dataset", createdAt: new Date(NOW - 6 * DAY).toISOString() },
      { uri: "s3://bucket/twins/0xa/dataset/recent", twinId: "0xa", category: "dataset", createdAt: new Date(NOW - 4 * DAY).toISOString() },
    ], { "0xa": "did:owner" });
    const result = await retention.run();
    expect(deleted).toEqual(["s3://bucket/twins/0xa/dataset/old"]);
    expect(result).toMatchObject({ scanned: 2, eligible: 1, deleted: 1, skippedUnresolved: 0, failed: 0 });
  });

  it("supports owner-specific retention and an indefinite future SLA tier", async () => {
    const policy = config({ ownerPolicies: [{ ownerDid: "did:premium", retentionDays: 30 }, { ownerDid: "did:archive", retentionDays: null }] });
    const objects = [
      { uri: "premium-10", twinId: "0xp", category: "model", createdAt: new Date(NOW - 10 * DAY).toISOString() },
      { uri: "premium-31", twinId: "0xp", category: "model", createdAt: new Date(NOW - 31 * DAY).toISOString() },
      { uri: "archive-100", twinId: "0xz", category: "evidence", createdAt: new Date(NOW - 100 * DAY).toISOString() },
    ];
    const { deleted, retention } = service(objects, { "0xp": "did:premium", "0xz": "did:archive" }, policy);
    await retention.run();
    expect(deleted).toEqual(["premium-31"]);
  });

  it("fails closed when the current Twin owner cannot be resolved", async () => {
    const { deleted, retention } = service([{ uri: "unknown", twinId: "0xmissing", category: "dataset", createdAt: new Date(NOW - 20 * DAY).toISOString() }], { "0xmissing": null });
    const result = await retention.run();
    expect(deleted).toEqual([]);
    expect(result.skippedUnresolved).toBe(1);
  });
});
