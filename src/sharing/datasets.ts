import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { zipSync } from 'fflate';
import canonicalize from 'canonicalize';
import { join } from 'node:path';
import { DatasetSigner } from './dataset-signing.js';
import { AppError } from '../common/errors.js';
import type { StorageRouter } from '../storage/storage-router.js';
import { filterPayload, type Rights } from './policy.js';
import type { TwinSharing } from './service.js';

export const DATASET_LIMITS = Object.freeze({ ttlMs: 600_000, maxRangeMs: 31 * 86400_000, maxSourceBytes: 16 * 1024 * 1024, maxScanBytes: 256 * 1024 * 1024, maxArchiveBytes: 16 * 1024 * 1024, maxResidentBytes: 64 * 1024 * 1024, maxWindows: 10_000, maxJobs: 32, maxConcurrent: 2 });
type Selection = { fromTimestamp: number; toTimestamp: number; measurements?: string[] };
type Sample = { observedAt: number; value: unknown; sourceHash: string };
type Job = { id: string; twinId: string; did: string; tokenHash: string; revision: string; ownerDid: string; selection: Selection; createdAt: number; expiresAt: number; status: 'preparing' | 'ready' | 'failed'; archive?: Buffer; sha256?: string; sampleCount?: number; error?: { code: string; message: string }; timer: ReturnType<typeof setTimeout> };
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fail(code: string, message: string, status = 422): never { throw new AppError(code, message, status, status === 403 ? 'AUTHORIZATION' : 'VALIDATION'); }

/** Ephemeral, read-only exports. No storage credentials, chain writes or public URLs. */
export class SharedDatasets {
  private jobs = new Map<string, Job>();
  private running = 0;
  private onPolicy = (id: string) => { for (const job of this.jobs.values()) if (job.twinId === id) this.remove(job); };
  constructor(private sharing: TwinSharing, private storage: Pick<StorageRouter, 'listManagedObjects' | 'read'>, private now = () => Date.now(), readonly signer = new DatasetSigner({ keyFile: join(sharing.options.directory, 'dataset-signing-key.json'), issuer: sharing.options.publicUrl, network: sharing.options.network })) {
    sharing.changes.on('policyChanged', this.onPolicy);
  }
  close() { this.sharing.changes.off('policyChanged', this.onPolicy); for (const job of this.jobs.values()) this.remove(job); }
  private remove(job: Job) { clearTimeout(job.timer); delete job.archive; this.jobs.delete(job.id); }
  private prune() { for (const job of this.jobs.values()) if (job.expiresAt <= this.now()) this.remove(job); }
  private active(job: Job) { if (this.jobs.get(job.id) !== job || job.expiresAt <= this.now()) fail('DATASET_EXPIRED', 'Dataset request expired or was revoked. Request a new dataset.', 410); }
  private urls(job: Job) {
    const path = `${this.sharing.options.publicUrl.replace(/\/$/, '')}/api/v1/shared/twins/${job.twinId}/datasets/${job.id}`;
    return { statusUrl: path, ...(job.status === 'ready' ? { downloadUrl: `${path}/download`, authentication: 'Bearer session token' } : {}) };
  }
  private view(job: Job) { return { requestId: job.id, twinId: job.twinId, status: job.status, selection: job.selection, createdAt: job.createdAt, expiresAt: job.expiresAt, ...this.urls(job), ...(job.status === 'ready' ? { sampleCount: job.sampleCount, byteLength: job.archive!.length, sha256: job.sha256 } : {}), ...(job.error ? { error: job.error } : {}) }; }
  async context(twinId: string, token: string) {
    const access = await this.sharing.read(this.sharing.id(twinId), token, 'export');
    const grant = access.rights.owner ? null : access.rights.reader;
    return { serverTime: this.now(), sessionExpiresAt: access.expiresAt, policyRevision: access.revision,
      historyFrom: grant?.historyFrom ?? 0, historyTo: grant?.historyTo ?? 0,
      allMeasurements: access.rights.owner || Boolean(grant?.allMeasurements), measurements: grant?.measurements ?? [],
      maxRangeMs: DATASET_LIMITS.maxRangeMs, maxArchiveBytes: DATASET_LIMITS.maxArchiveBytes, ttlMs: DATASET_LIMITS.ttlMs };
  }
  async create(twinId: string, token: string, input: unknown) {
    twinId = this.sharing.id(twinId);
    const access = await this.sharing.read(twinId, token, 'export');
    const selection = parseSelection(input, this.now());
    validateMeasurements(selection, access.rights);
    const grant = access.rights?.reader;
    if (!access.rights?.owner && grant && (selection.fromTimestamp < grant.historyFrom || (grant.historyTo && selection.toTimestamp >= grant.historyTo))) fail('DATASET_INTERVAL_DENIED', 'Requested interval exceeds the authorized historical period', 403);
    this.prune();
    if (this.running >= DATASET_LIMITS.maxConcurrent || this.jobs.size >= DATASET_LIMITS.maxJobs || [...this.jobs.values()].filter(j => j.did === access.did).length >= 4) fail('DATASET_BUSY', 'Too many dataset requests. Retry later or delete an earlier request.', 429);
    const id = randomUUID(), createdAt = this.now(), expiresAt = Math.min(createdAt + DATASET_LIMITS.ttlMs, access.expiresAt);
    const timer = setTimeout(() => { const job = this.jobs.get(id); if (job) this.remove(job); }, Math.max(1, expiresAt - createdAt)); timer.unref();
    const job: Job = { id, twinId, did: access.did, tokenHash: digest(token), revision: access.revision!, ownerDid: String(access.fields.owner_did), selection, createdAt, expiresAt, status: 'preparing', timer };
    this.jobs.set(id, job); this.running++;
    const initial = this.view(job);
    void this.prepare(job, token).catch(error => {
      if (this.jobs.get(id) !== job) return;
      job.status = 'failed'; delete job.archive;
      // Provider errors may contain private bucket names, paths or credentials.
      job.error = error instanceof AppError && error.code.startsWith('DATASET_')
        ? { code: error.code, message: error.message }
        : { code: 'DATASET_PREPARATION_FAILED', message: 'Dataset could not be prepared. Access or retained storage may be unavailable.' };
    }).finally(() => { this.running--; });
    return initial;
  }
  private async authorized(twinId: string, token: string, requestId: string) {
    twinId = this.sharing.id(twinId);
    const access = await this.sharing.read(twinId, token, 'export');
    this.prune();
    const job = this.jobs.get(requestId);
    if (!job || job.twinId !== twinId || job.did !== access.did || job.tokenHash !== digest(token)) fail('DATASET_NOT_FOUND', 'Dataset request not found or expired', 404);
    if (job.revision !== access.revision) { this.remove(job); fail('DATASET_REVOKED', 'Access settings changed. Request a new dataset.', 403); }
    this.active(job); return job;
  }
  async status(twinId: string, token: string, requestId: string) { return this.view(await this.authorized(twinId, token, requestId)); }
  async cancel(twinId: string, token: string, requestId: string) { this.remove(await this.authorized(twinId, token, requestId)); }
  async download(twinId: string, token: string, requestId: string) {
    const job = await this.authorized(twinId, token, requestId);
    if (job.status !== 'ready' || !job.archive) fail('DATASET_NOT_READY', 'Dataset is not ready for download', 409);
    return { bytes: job.archive, filename: `objectid-dataset-${job.id}.zip`, sha256: job.sha256! };
  }
  private async collect(twinId: string, selection: Selection, rights: Rights, scope: number, ownerDid: string, active: () => void = () => {}) {
    const candidates = (await this.storage.listManagedObjects()).filter(item => item.twinId.toLowerCase() === twinId && ['dataset', 'datasets'].includes(item.category));
    active();
    if (candidates.length > DATASET_LIMITS.maxWindows) fail('DATASET_SOURCE_LIMIT', 'Too many retained windows for this export service', 413);
    let scannedBytes = 0, selectedBytes = 0;
    const samples: Sample[] = [];
    const sources: Array<{ sha256: string; byteLength: number; selectedSamples: number }> = [];
    // Sequential bounded reads avoid loading the whole retained history concurrently.
    for (const item of candidates) {
      active();
      const readLimit = Math.min(DATASET_LIMITS.maxSourceBytes, DATASET_LIMITS.maxScanBytes - scannedBytes);
      if (typeof item.size === 'number' && item.size > readLimit) fail('DATASET_SOURCE_LIMIT', 'Retained telemetry scan exceeds the export size limit', 413);
      const bytes = await boundedBuffer(await this.storage.read(item.uri), readLimit);
      active(); scannedBytes += bytes.length;
      let window: any;
      try { window = JSON.parse(bytes.toString('utf8')); } catch { fail('DATASET_SOURCE_INVALID', 'A retained telemetry window is not valid JSON', 409); }
      if (String(window?.twinId).toLowerCase() !== twinId || !Array.isArray(window.samples)) fail('DATASET_SOURCE_INVALID', 'A retained window has an invalid Twin or sample schema', 409);
      const sourceHash = digest(bytes); let selectedSamples = 0;
      for (const sample of window.samples) {
        active();
        if (!Number.isSafeInteger(sample?.observedAt) || sample.observedAt < 0 || !Object.hasOwn(sample, 'value')) fail('DATASET_SOURCE_INVALID', 'A retained sample has no valid observation timestamp or value', 409);
        // Filter samples, not just windows: never include values outside the requested interval.
        if (sample.observedAt >= selection.fromTimestamp && sample.observedAt <= selection.toTimestamp) {
          selectedBytes += Buffer.byteLength(JSON.stringify(sample)) + 100;
          if (selectedBytes > DATASET_LIMITS.maxArchiveBytes / 3) fail('DATASET_OUTPUT_LIMIT', 'Selected data exceeds the export size limit. Request a shorter interval.', 413);
          let value = await this.sharing.filterSample(twinId, ownerDid, sample.value, rights, scope, sample.observedAt);
          if (selection.measurements) {
            // Narrow only after canonical authorization and source-side decryption.
            value = filterPayload(value, { ...rights, legacy: false, owner: false, publicScopes: 0,
              reader: { did: '', scopes: rights.scopes, validFrom: 0, expiresAt: 0, historyFrom: 0, historyTo: 0, allMeasurements: false, measurements: selection.measurements } }, scope, sample.observedAt);
          }
          samples.push({ observedAt: sample.observedAt, value, sourceHash }); selectedSamples++;
        }
      }
      if (selectedSamples) sources.push({ sha256: sourceHash, byteLength: bytes.length, selectedSamples });
    }
    if (!samples.length) fail('DATASET_EMPTY', 'No retained samples exist in the requested interval', 404);
    samples.sort((a, b) => a.observedAt - b.observedAt || a.sourceHash.localeCompare(b.sourceHash));
    return { samples, sources };
  }
  async history(twinId: string, token: string, input: unknown) {
    twinId = this.sharing.id(twinId);
    const access = await this.sharing.read(twinId, token, 'storage');
    const selection = parseSelection(input, this.now()), grant = access.rights.reader;
    validateMeasurements(selection, access.rights);
    if (!access.rights.owner && grant && (selection.fromTimestamp < grant.historyFrom || (grant.historyTo && selection.toTimestamp >= grant.historyTo))) fail('DATASET_INTERVAL_DENIED', 'Requested interval exceeds the authorized historical period', 403);
    if (this.running >= DATASET_LIMITS.maxConcurrent) fail('DATASET_BUSY', 'Too many historical requests', 429);
    this.running++;
    try {
      const { samples } = await this.collect(twinId, selection, access.rights, 2, String(access.fields.owner_did));
      const current = await this.sharing.read(twinId, token, 'storage');
      if (current.revision !== access.revision) fail('DATASET_REVOKED', 'Access changed during the historical query', 403);
      return { twinId, selection, policyRevision: access.revision, samples };
    } finally { this.running--; }
  }
  private async prepare(job: Job, token: string) {
    const initialAccess = await this.sharing.read(job.twinId, token, 'export');
    const { samples, sources } = await this.collect(job.twinId, job.selection, initialAccess.rights, 4, job.ownerDid, () => this.active(job));
    const json = Buffer.from(JSON.stringify({ format: 'objectid.shared-telemetry.v1', twinId: job.twinId, selection: job.selection, samples }));
    const csv = Buffer.from('observed_at_ms,observed_at_utc,source_sha256,value_json\r\n' + samples.map(s => `${s.observedAt},${new Date(s.observedAt).toISOString()},${s.sourceHash},${csvCell(JSON.stringify(s.value))}`).join('\r\n') + '\r\n');
    if (json.length + csv.length > DATASET_LIMITS.maxArchiveBytes) fail('DATASET_OUTPUT_LIMIT', 'Selected data exceeds the export size limit. Request a shorter interval.', 413);
    const encrypted = samples.filter(s => (s.value as any)?.encrypted === true).length;
    const synthetic = samples.filter(s => (s.value as any)?.simulation?.synthetic === true).length;
    const manifest = {
      format: 'objectid.shared-dataset-manifest.v2', datasetId: job.id, generatedAt: new Date(this.now()).toISOString(),
      twinId: job.twinId, ownerDid: job.ownerDid, network: this.sharing.options.network, packageId: this.sharing.options.packageId,
      accessPolicy: { revision: job.revision, measures: initialAccess.rights.owner || initialAccess.rights.reader?.allMeasurements ? 'all' : initialAccess.rights.reader?.measurements ?? [], scope: 'export' },
      selection: { ...job.selection, timestampUnit: 'unix-milliseconds', timestampField: 'observedAt', inclusive: true },
      observedPeriod: { fromTimestamp: samples[0]!.observedAt, toTimestamp: samples.at(-1)!.observedAt },
      sampleCount: samples.length, sourceWindowCount: sources.length, sources,
      dataClassification: { declaredSyntheticSamples: synthetic, encryptedSamples: encrypted, otherSamples: samples.length - synthetic, note: 'Synthetic flags are source declarations. Unmarked or encrypted samples are not assumed to be real.' },
      integrity: { algorithm: 'SHA-256', scope: 'uncompressed-file-bytes', onChainAnchored: false, note: 'The Integration Server signs this export manifest. This is not an owner signature or an on-chain provenance attestation.' },
      files: [{ path: 'data.json', sha256: digest(json), byteLength: json.length }, { path: 'data.csv', sha256: digest(csv), byteLength: csv.length }],
      limitations: ['Only retained, flushed telemetry windows are included; gaps and expired data are not reconstructed.', 'Encrypted sources require authorized source-side filtering; unfilterable sources are denied.', 'No private storage URI or storage credentials are included.'],
    };
    const signedManifest = await this.signer.signManifest(manifest);
    const archive = Buffer.from(zipSync({ 'data.json': json, 'data.csv': csv, 'manifest.json': Buffer.from(canonicalize(signedManifest)!) }, { level: 0 }));
    if (archive.length > DATASET_LIMITS.maxArchiveBytes) fail('DATASET_OUTPUT_LIMIT', 'Prepared archive exceeds the export size limit', 413);
    // Recheck after I/O and before exposing a ready archive.
    const access = await this.sharing.read(job.twinId, token, 'export'); this.active(job);
    if (access.revision !== job.revision) fail('DATASET_REVOKED', 'Access settings changed during dataset preparation', 403);
    const residentBytes = [...this.jobs.values()].reduce((sum, j) => sum + (j.archive?.length ?? 0), 0);
    if (residentBytes + archive.length > DATASET_LIMITS.maxResidentBytes) fail('DATASET_CAPACITY', 'Dataset export capacity is full. Retry later.', 429);
    job.archive = archive; job.sha256 = digest(archive); job.sampleCount = samples.length; job.status = 'ready';
  }
}

function parseSelection(input: unknown, now: number): Selection {
  const value = input as any;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['fromTimestamp', 'toTimestamp', 'measurements'].includes(k))) fail('DATASET_SELECTION_INVALID', 'Provide fromTimestamp, toTimestamp and optional measurement keys');
  const { fromTimestamp, toTimestamp } = value;
  if (!Number.isSafeInteger(fromTimestamp) || !Number.isSafeInteger(toTimestamp) || fromTimestamp < 0 || toTimestamp < fromTimestamp || toTimestamp > now || toTimestamp - fromTimestamp > DATASET_LIMITS.maxRangeMs) fail('DATASET_SELECTION_INVALID', 'Use a valid past interval of at most 31 days, in Unix milliseconds');
  const measurements = value.measurements;
  if (measurements !== undefined && (!Array.isArray(measurements) || !measurements.length || measurements.length > 64 || measurements.some((k: unknown) => typeof k !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k) || ['constructor', 'prototype'].includes(k)) || new Set(measurements).size !== measurements.length)) fail('DATASET_SELECTION_INVALID', 'Select between 1 and 64 distinct exact measurement keys');
  return { fromTimestamp, toTimestamp, ...(measurements !== undefined ? { measurements: [...measurements] } : {}) };
}
function validateMeasurements(selection: Selection, rights: Rights) {
  if (selection.measurements && !rights.owner && !rights.reader?.allMeasurements && selection.measurements.some(k => !rights.reader?.measurements.includes(k))) fail('DATASET_MEASUREMENT_DENIED', 'A requested measurement is outside your authorization', 403);
}
function csvCell(value: string) { return `"${value.replace(/"/g, '""')}"`; }
async function boundedBuffer(value: Buffer | Readable, limit: number): Promise<Buffer> {
  if (Buffer.isBuffer(value)) { if (value.length > limit) fail('DATASET_SOURCE_LIMIT', 'Retained telemetry exceeds the export size limit', 413); return value; }
  const chunks: Buffer[] = []; let size = 0;
  try { for await (const chunk of value) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > limit) fail('DATASET_SOURCE_LIMIT', 'Retained telemetry exceeds the export size limit', 413); chunks.push(bytes); } }
  finally { value.destroy(); }
  return Buffer.concat(chunks);
}
