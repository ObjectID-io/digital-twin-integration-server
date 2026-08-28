import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { TwinEvidenceService } from "../../src/evidence/service.js";

const twinId = `0x${"11".repeat(32)}`;
const datasetId = `0x${"22".repeat(32)}`;
const eventId = `0x${"33".repeat(32)}`;
const packageId = `0x${"44".repeat(32)}`;
const rawWindow = Buffer.from(JSON.stringify({ twinId, fromTimestamp: 100, toTimestamp: 200, samples: [{ observedAt: 100, value: 21.5 }] }));

function fixture() {
  let evidenceBytes = Buffer.alloc(0);
  let evidenceHash = "";
  const datasets: any[] = [];
  const events: any[] = [];
  const adapter = {
    getTwinChildren: async (_twinId: string, type: string) => type === "OIDTwinDataset" ? datasets : [],
    getDigitalThread: async () => events,
    addDataset: async (_twinId: string, input: any) => {
      datasets.push({ data: { objectId: datasetId, content: { fields: {
        dataset_type: input.datasetType, storage_uri: input.storageUri, payload_hash: input.payloadHash,
        period_from: input.periodFrom, period_to: input.periodTo, created_at: 201,
      } } } });
      events.push({ eventId, twinId, eventType: 70, revisionBefore: 1, revisionAfter: 2, actorDid: "did:iota:testnet:actor",
        payloadRef: datasetId, payloadHash: input.payloadHash, createdAt: 202, transactionDigest: "transaction-digest" });
      return { digest: "transaction-digest", objectChanges: [{ type: "created", objectType: `${packageId}::oid_twin::OIDTwinDataset`, objectId: datasetId }] };
    },
  };
  const storage = {
    listManagedObjects: async () => [{ uri: "s3://raw/window.json", twinId, category: "dataset", createdAt: new Date(200).toISOString(), size: rawWindow.length }],
    read: async (uri: string) => uri === "s3://raw/window.json" ? rawWindow : evidenceBytes,
    store: async ({ data }: any) => {
      evidenceBytes = Buffer.from(data); evidenceHash = createHash("sha256").update(evidenceBytes).digest("hex");
      return { uri: "s3://evidence/export.json", hash: `sha256:${evidenceHash}`, hashAlgorithm: "sha256", size: evidenceBytes.length, contentType: "application/json" };
    },
  };
  const service = new TwinEvidenceService(adapter as any, storage as any, { objectid: { network: "testnet", packageId } } as any);
  return { service, getEvidenceBytes: () => evidenceBytes, getEvidenceHash: () => evidenceHash, adapter };
}

describe("TwinEvidenceService", () => {
  it("creates exactly one on-demand Dataset and Digital Thread event", async () => {
    const { service, adapter, getEvidenceBytes } = fixture();
    const created = await service.createSnapshot(twinId, {});
    expect(created).toMatchObject({ datasetId, sourceWindowCount: 1, periodFrom: 100, periodTo: 200 });
    await expect(adapter.getDigitalThread()).resolves.toHaveLength(1);
    expect(JSON.parse(getEvidenceBytes().toString())).toMatchObject({ format: "objectid.digital-twin-export-dataset.v1", twinId, sourceWindowCount: 1 });
  });

  it("downloads and validates the specific Dataset snapshot", async () => {
    const { service, getEvidenceHash, getEvidenceBytes } = fixture();
    await service.createSnapshot(twinId, {});
    const { bytes: archive, manifest } = await service.createBundle(twinId, datasetId);
    const files = unzipSync(archive); const path = manifest.dataset.path;
    expect(Buffer.from(files[path]!)).toEqual(getEvidenceBytes());
    const valid = await service.validateBundle(twinId, { manifest, file: { path, sha256: getEvidenceHash(), byteLength: getEvidenceBytes().length } });
    expect(valid.valid).toBe(true);
    expect(valid.assessment).toMatchObject({
      format: "objectid.digital-twin-technical-conformity-report.v1",
      verdict: "CONFORMANT",
      assuranceLevel: "CRYPTOGRAPHICALLY_VERIFIED",
      coverage: { total: 14, passed: 14, failed: 0 },
      scope: { twinId, snapshotDatasetId: datasetId, network: "testnet", packageId },
    });
    expect(valid.assessment.checks).toHaveLength(14);
    expect(valid.assessment.evidence).toMatchObject({
      onChainDataset: { objectId: datasetId },
      digitalThreadEvent: { eventId, transactionDigest: "transaction-digest" },
    });
    expect(valid.assessment.limitations.join(" ")).toContain("not an ISO certification");
  });

  it("rejects a changed Dataset file", async () => {
    const { service, getEvidenceBytes } = fixture();
    await service.createSnapshot(twinId, {});
    const { manifest } = await service.createBundle(twinId, datasetId);
    const changed = await service.validateBundle(twinId, { manifest, file: { path: manifest.dataset.path, sha256: "00".repeat(32), byteLength: getEvidenceBytes().length } });
    expect(changed.valid).toBe(false);
    expect(changed.checks.fileMatchesManifest).toBe(false);
    expect(changed.assessment).toMatchObject({ verdict: "NON_CONFORMANT", coverage: { total: 14, passed: 13, failed: 1 } });
    expect(changed.assessment.checks.find((check) => check.id === "FILE-03")).toMatchObject({ passed: false });
  });
});
