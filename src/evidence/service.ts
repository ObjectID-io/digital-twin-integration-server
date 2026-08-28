import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { zipSync, strToU8 } from "fflate";
import { AppError } from "../common/errors.js";
import type { AppConfig } from "../config/types.js";
import type { AccountingContext, ObjectIdAdapter, TwinEvent } from "../objectid/types.js";
import type { StorageRouter } from "../storage/storage-router.js";

const BUNDLE_FORMAT = "objectid.digital-twin-evidence-bundle.v2";
const DATASET_FORMAT = "objectid.digital-twin-export-dataset.v1";
const DATASET_EVENT = 70;
const MAX_DATASET_BYTES = 256 * 1024 * 1024;

export interface EvidenceManifestEntry {
  datasetObjectId: string; datasetType: string; storageUri: string; path: string;
  payloadHash: string; byteLength: number; periodFrom: number; periodTo: number; createdAt: number;
  event: { eventId: string; transactionDigest: string | null; revision: number; payloadHash: string } | null;
}

export interface EvidenceManifest {
  format: typeof BUNDLE_FORMAT; generatedAt: string; network: string; packageId: string;
  twinId: string; snapshotDatasetId: string;
  integrity: { algorithm: "SHA-256"; scope: "uncompressed-file-bytes"; onChainObject: "OIDTwinDataset"; eventType: 70 };
  dataset: EvidenceManifestEntry;
}

export class TwinEvidenceService {
  constructor(private readonly objectid: ObjectIdAdapter, private readonly storage: StorageRouter, private readonly config: AppConfig) {}

  async createSnapshot(twinId: string, selection: { fromTimestamp?: number; toTimestamp?: number }, accounting?: AccountingContext) {
    const managed = (await this.storage.listManagedObjects()).filter((item) =>
      item.twinId.toLowerCase() === twinId.toLowerCase() && ["dataset", "datasets"].includes(item.category));
    const windows: Array<{ sourceUri: string; retainedAt: string; periodFrom: number; periodTo: number; payload: unknown }> = [];
    let sourceBytes = 0;
    for (const item of managed) {
      const bytes = await bufferOf(await this.storage.read(item.uri));
      let payload: any;
      try { payload = JSON.parse(bytes.toString("utf8")); }
      catch { throw new AppError("EVIDENCE_SOURCE_INVALID", `Stored telemetry object '${item.uri}' is not valid JSON`, 409, "CONNECTOR"); }
      const parsedCreatedAt = Date.parse(item.createdAt);
      const fallback = Number.isSafeInteger(parsedCreatedAt) && parsedCreatedAt >= 0 ? parsedCreatedAt : Date.now();
      const periodFrom = safeTimestamp(payload?.fromTimestamp, fallback);
      const periodTo = safeTimestamp(payload?.toTimestamp, periodFrom);
      if (overlaps(periodFrom, periodTo, selection)) {
        sourceBytes += bytes.length;
        if (sourceBytes > MAX_DATASET_BYTES) throw new AppError("EVIDENCE_SOURCE_TOO_LARGE", `Selected telemetry exceeds ${MAX_DATASET_BYTES} bytes`, 413, "VALIDATION");
        windows.push({ sourceUri: item.uri, retainedAt: item.createdAt, periodFrom, periodTo, payload });
      }
    }
    windows.sort((left, right) => left.periodFrom - right.periodFrom || left.sourceUri.localeCompare(right.sourceUri));
    if (!windows.length) throw new AppError("EVIDENCE_SOURCE_EMPTY", "No retained telemetry is available for the selected interval", 404, "CONNECTOR");
    const periodFrom = Math.min(...windows.map((window) => window.periodFrom));
    const periodTo = Math.max(...windows.map((window) => window.periodTo));
    const datasetPayload = {
      format: DATASET_FORMAT, twinId, createdAt: new Date().toISOString(),
      selection: { fromTimestamp: selection.fromTimestamp ?? null, toTimestamp: selection.toTimestamp ?? null },
      periodFrom, periodTo, sourceWindowCount: windows.length, windows,
    };
    const bytes = Buffer.from(JSON.stringify(datasetPayload));
    if (bytes.length > MAX_DATASET_BYTES) throw new AppError("EVIDENCE_DATASET_TOO_LARGE", `Export Dataset exceeds ${MAX_DATASET_BYTES} bytes`, 413, "VALIDATION");
    const stored = await this.storage.store({
      data: bytes, contentType: "application/json", fileName: "export-dataset.json", category: "evidence", twinId,
      metadata: { datasetType: "on-demand-export", format: DATASET_FORMAT },
    });
    const mutation = await this.objectid.addDataset(twinId, {
      datasetType: "on-demand-export", schemaUri: "objectid-schema://digital-twin/export-dataset/v1",
      storageUri: stored.uri, payloadHash: stored.hash, payloadSize: stored.size,
      periodFrom, periodTo, version: "1",
      immutableMetadata: JSON.stringify({ format: DATASET_FORMAT, sourceWindowCount: windows.length, contentType: "application/json" }),
    }, accounting);
    const datasetId = datasetIdFromMutation(mutation) ?? await this.resolveDatasetId(twinId, stored.uri, stored.hash);
    if (!datasetId) throw new AppError("EVIDENCE_DATASET_RESULT_INVALID", "Dataset registration succeeded but its on-chain object ID could not be resolved", 502, "OBJECTID");
    return {
      format: "objectid.digital-twin-evidence-snapshot.v1", twinId, datasetId,
      transactionDigest: String((mutation as any)?.digest ?? "") || null,
      periodFrom, periodTo, sourceWindowCount: windows.length, payloadHash: normalizeHash(stored.hash), byteLength: bytes.length,
    };
  }

  async createBundle(twinId: string, datasetId: string) {
    const { dataset, event } = await this.loadAnchoredDataset(twinId, datasetId);
    const bytes = await bufferOf(await this.storage.read(dataset.storageUri));
    if (bytes.length > MAX_DATASET_BYTES) throw new AppError("EVIDENCE_DATASET_TOO_LARGE", `Export Dataset exceeds ${MAX_DATASET_BYTES} bytes`, 413, "VALIDATION");
    if (sha256(bytes) !== normalizeHash(dataset.payloadHash)) throw new AppError("EVIDENCE_STORAGE_HASH_MISMATCH", "Stored Dataset bytes do not match their on-chain SHA-256", 409, "OBJECTID");
    const path = `data/${safeId(dataset.objectId)}.json`;
    const manifest: EvidenceManifest = {
      format: BUNDLE_FORMAT, generatedAt: new Date().toISOString(), network: this.config.objectid.network,
      packageId: this.config.objectid.packageId ?? "", twinId, snapshotDatasetId: dataset.objectId,
      integrity: { algorithm: "SHA-256", scope: "uncompressed-file-bytes", onChainObject: "OIDTwinDataset", eventType: DATASET_EVENT },
      dataset: manifestEntry(dataset, event, path, bytes.length),
    };
    return { bytes: Buffer.from(zipSync({
      [path]: bytes,
      "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
      "README.txt": strToU8("ObjectID on-demand Digital Twin Dataset\n\nValidate this ZIP in the ObjectID Webview. Its Dataset hash is checked against the live OIDTwinDataset and Digital Thread event on IOTA.\n"),
    }, { level: 6 })), manifest };
  }

  async validateBundle(twinId: string, input: unknown) {
    const body = asRecord(input); const manifest = body.manifest as EvidenceManifest; const file = asRecord(body.file);
    if (!validManifest(manifest)) throw new AppError("EVIDENCE_MANIFEST_INVALID", "A valid ObjectID on-demand evidence manifest is required", 422, "VALIDATION");
    const [rawDatasets, events] = await Promise.all([
      this.objectid.getTwinChildren(twinId, "OIDTwinDataset"), this.objectid.getDigitalThread(twinId),
    ]);
    const dataset = rawDatasets.map(datasetOf).find((item) => item.objectId.toLowerCase() === manifest.snapshotDatasetId.toLowerCase());
    const event = events.find((item) => item.eventType === DATASET_EVENT && item.payloadRef.toLowerCase() === manifest.snapshotDatasetId.toLowerCase());
    const entry = manifest.dataset; const expected = normalizeHash(entry.payloadHash);
    const contextChecks = {
      format: manifest.format === BUNDLE_FORMAT, twinId: manifest.twinId.toLowerCase() === twinId.toLowerCase(),
      network: manifest.network === this.config.objectid.network,
      packageId: manifest.packageId.toLowerCase() === String(this.config.objectid.packageId ?? "").toLowerCase(),
      snapshotDatasetId: entry.datasetObjectId.toLowerCase() === manifest.snapshotDatasetId.toLowerCase(),
    };
    const checks = {
      datasetOnChain: Boolean(dataset), eventOnChain: Boolean(event),
      manifestMatchesDataset: Boolean(dataset) && normalizeHash(dataset!.payloadHash) === expected,
      manifestMetadataMatches: Boolean(dataset) && entry.storageUri === dataset!.storageUri
        && entry.periodFrom === dataset!.periodFrom && entry.periodTo === dataset!.periodTo,
      eventMatchesDataset: Boolean(dataset && event) && normalizeHash(event!.payloadHash) === normalizeHash(dataset!.payloadHash),
      filePresent: Boolean(file.path), filePathMatches: String(file.path ?? "") === entry.path,
      fileMatchesManifest: normalizeHash(String(file.sha256 ?? "")) === expected,
      fileSizeMatches: Number(file.byteLength) === entry.byteLength,
    };
    const valid = Object.values(contextChecks).every(Boolean) && Object.values(checks).every(Boolean);
    return {
      format: "objectid.digital-twin-evidence-validation.v2", validatedAt: new Date().toISOString(),
      twinId, network: this.config.objectid.network, snapshotDatasetId: manifest.snapshotDatasetId, valid,
      contextChecks, checks,
      statement: valid ? "The exported Dataset matches its live OIDTwinDataset and Digital Thread anchor on IOTA." : "One or more Dataset evidence checks failed.",
    };
  }

  private async resolveDatasetId(twinId: string, storageUri: string, payloadHash: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const match = (await this.objectid.getTwinChildren(twinId, "OIDTwinDataset")).map(datasetOf)
        .find((dataset) => dataset.storageUri === storageUri && normalizeHash(dataset.payloadHash) === normalizeHash(payloadHash));
      if (match) return match.objectId;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    return undefined;
  }

  private async loadAnchoredDataset(twinId: string, datasetId: string) {
    let dataset: ReturnType<typeof datasetOf> | undefined;
    let event: TwinEvent | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const [rawDatasets, events] = await Promise.all([
        this.objectid.getTwinChildren(twinId, "OIDTwinDataset"), this.objectid.getDigitalThread(twinId),
      ]);
      dataset = rawDatasets.map(datasetOf).find((item) => item.objectId.toLowerCase() === datasetId.toLowerCase());
      event = events.find((item) => item.eventType === DATASET_EVENT && item.payloadRef.toLowerCase() === datasetId.toLowerCase());
      if (dataset && event) return { dataset, event };
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!dataset) throw new AppError("EVIDENCE_DATASET_NOT_FOUND", "The requested Dataset does not belong to this Twin or is not indexed yet", 404, "OBJECTID");
    throw new AppError("EVIDENCE_EVENT_NOT_INDEXED", "The Dataset exists but its Digital Thread event is not indexed yet; retry the download", 503, "OBJECTID");
  }
}

function fieldsOf(value: any) { return value?.data?.content?.fields ?? value?.content?.fields ?? value?.fields ?? {}; }
function objectIdOf(value: any) { return String(value?.data?.objectId ?? value?.objectId ?? value?.id ?? ""); }
function datasetOf(raw: any) { const fields = fieldsOf(raw); return {
  objectId: objectIdOf(raw), datasetType: String(fields.dataset_type ?? fields.datasetType ?? "dataset"),
  storageUri: String(fields.storage_uri ?? fields.storageUri ?? ""), payloadHash: String(fields.payload_hash ?? fields.payloadHash ?? ""),
  periodFrom: Number(fields.period_from ?? fields.periodFrom ?? 0), periodTo: Number(fields.period_to ?? fields.periodTo ?? 0),
  createdAt: Number(fields.created_at ?? fields.createdAt ?? 0),
}; }
function manifestEntry(dataset: ReturnType<typeof datasetOf>, event: TwinEvent | undefined, path: string, byteLength: number): EvidenceManifestEntry { return {
  datasetObjectId: dataset.objectId, datasetType: dataset.datasetType, storageUri: dataset.storageUri, path,
  payloadHash: normalizeHash(dataset.payloadHash), byteLength, periodFrom: dataset.periodFrom, periodTo: dataset.periodTo, createdAt: dataset.createdAt,
  event: event ? { eventId: event.eventId, transactionDigest: event.transactionDigest ?? null, revision: event.revisionAfter, payloadHash: normalizeHash(event.payloadHash) } : null,
}; }
function datasetIdFromMutation(value: any) { const direct = String(value?.datasetId ?? value?.id ?? ""); if (direct) return direct; const created = value?.objectChanges?.find((change: any) => change?.type === "created" && String(change.objectType ?? "").endsWith("::oid_twin::OIDTwinDataset")); return created?.objectId ? String(created.objectId) : undefined; }
function validManifest(value: any): value is EvidenceManifest { return value?.format === BUNDLE_FORMAT && typeof value.twinId === "string" && typeof value.packageId === "string" && typeof value.network === "string" && typeof value.snapshotDatasetId === "string" && value.dataset && value.dataset.datasetObjectId === value.snapshotDatasetId && /^data\/[a-z0-9_.-]+$/i.test(String(value.dataset.path ?? "")) && Number.isSafeInteger(Number(value.dataset.byteLength)) && Number(value.dataset.byteLength) >= 0; }
function overlaps(from: number, to: number, selection: { fromTimestamp?: number; toTimestamp?: number }) { return (selection.fromTimestamp === undefined || to >= selection.fromTimestamp) && (selection.toTimestamp === undefined || from <= selection.toTimestamp); }
function safeTimestamp(value: unknown, fallback: number) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : fallback; }
function normalizeHash(value: string) { return value.trim().toLowerCase().replace(/^sha-?256:/, "").replace(/^0x/, ""); }
function sha256(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function safeId(value: string) { return value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "dataset"; }
function asRecord(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
async function bufferOf(value: Buffer | Readable) { if (Buffer.isBuffer(value)) return value; const chunks: Buffer[] = []; for await (const chunk of value) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return Buffer.concat(chunks); }
