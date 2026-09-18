import { describe, expect, it } from "vitest";
import { ConfigRetentionPolicyResolver, StorageRetentionService } from "../../src/storage/retention.js";
import type { RetentionConfig } from "../../src/storage/types.js";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const DAY = 86_400_000;

function config(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return {
    enabled: true, defaultDays: 5, intervalMs: 3_600_000, startupDelayMs: 60_000,
    maxDeletesPerRun: 500, ownerPolicies: [],
    onChainStates: { enabled: false, retentionDays: 30, maxPrunesPerRun: 50 },
    ...overrides,
  };
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

describe("on-chain state retention", () => {
  const hash = "a".repeat(64);

  function onChainService(states: any[], events: any[]) {
    const pruned: string[] = [];
    const retentionConfig = config({ onChainStates: { enabled: true, retentionDays: 30, maxPrunesPerRun: 50 } });
    const storage = { async listManagedObjects() { return []; } } as any;
    const objectid = {
      async listTwinIdsForRetention() { return ["0xtwin"]; },
      async getTwinStateRetentionSnapshot() { return { states, events }; },
      async pruneState(_twinId: string, stateId: string) { pruned.push(stateId); },
    } as any;
    return { pruned, retention: new StorageRetentionService(retentionConfig, storage, objectid, undefined, () => NOW) };
  }

  it("prunes an expired historical state only when its publication event anchors the same hash", async () => {
    const old = { objectId: "0xold", aspectCode: "telemetry", sampleType: "observed", observedAt: NOW - 40 * DAY, payloadHash: hash };
    const latest = { objectId: "0xlatest", aspectCode: "telemetry", sampleType: "observed", observedAt: NOW - DAY, payloadHash: hash };
    const publication = { eventId: "0xevent", eventType: 30, payloadRef: old.objectId, payloadHash: `sha256:${hash}`, createdAt: NOW - 40 * DAY };
    const { pruned, retention } = onChainService([old, latest], [publication]);

    const result = await retention.run();

    expect(pruned).toEqual(["0xold"]);
    expect(result.onChainStates).toMatchObject({ statesScanned: 2, eligible: 1, pruned: 1, skippedUnanchored: 0, failed: 0 });
  });

  it("prunes a legacy state through the atomic receipt call while keeping the newest stream state", async () => {
    const legacy = { objectId: "0xold", aspectCode: "telemetry", sampleType: "observed", observedAt: NOW - 40 * DAY, payloadHash: hash };
    const latest = { objectId: "0xlatest", aspectCode: "telemetry", sampleType: "observed", observedAt: NOW - 35 * DAY, payloadHash: hash };
    const publication = { eventId: "0xevent", eventType: 30, payloadRef: legacy.objectId, payloadHash: "", createdAt: NOW - 40 * DAY };
    const { pruned, retention } = onChainService([legacy, latest], [publication]);

    const result = await retention.run();

    expect(pruned).toEqual(["0xold"]);
    expect(result.onChainStates).toMatchObject({ eligible: 1, pruned: 1, skippedUnanchored: 0 });
  });

  it("fails closed when a non-empty publication hash disagrees with the state", async () => {
    const old = { objectId: "0xold", aspectCode: "telemetry", sampleType: "observed", observedAt: NOW - 40 * DAY, payloadHash: hash };
    const latest = { objectId: "0xlatest", aspectCode: "telemetry", sampleType: "observed", observedAt: NOW - DAY, payloadHash: hash };
    const publication = { eventId: "0xevent", eventType: 30, payloadRef: old.objectId, payloadHash: `sha256:${"b".repeat(64)}`, createdAt: NOW - 40 * DAY };
    const { pruned, retention } = onChainService([old, latest], [publication]);

    const result = await retention.run();

    expect(pruned).toEqual([]);
    expect(result.onChainStates).toMatchObject({ eligible: 0, pruned: 0, skippedUnanchored: 1 });
  });
});
