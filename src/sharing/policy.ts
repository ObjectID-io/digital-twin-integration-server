import type { IotaClient } from '@iota/iota-sdk/client';
// Canonical evaluator shared with the webview (transpiled to server/access-policy.js).
export const SCOPES = { realtime: 1, history: 2, export: 4, location: 8, evidence: 16, admin: 32 } as const;
export const ACCESS_PACKAGES: Record<string, string> = {
  testnet: '0x417d724f26f1af41a258c5ea22ae8476adc8a4d0e550ae62624b061cf18aa765',
  mainnet: '0x877834453155dcf6c5f0350e7232a6bec84612e1e09685803cdec9069a664418',
};
export type Reader = { did: string; scopes: number; validFrom: number; expiresAt: number; historyFrom: number; historyTo: number; allMeasurements: boolean; measurements: string[] };
export type AccessPolicy = { mode: 'private' | 'restricted' | 'public'; publicScopes: number; readers: Reader[]; ownerDid: string; revision: string; updatedAt: number; source: 'chain' };
export type Rights = { legacy?: boolean; discover: boolean; scopes: number; publicScopes: number; reader: Reader | null; owner: boolean; admin?: boolean; revision: string; expiresAt: number };
export class AccessPolicyError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
const reject = (message: string, status = 422): never => { throw new AccessPolicyError(message, status); };
const object = (v: any): any => v?.fields ?? v ?? {};
export function canonicalDid(value: unknown, network: string): string {
  const did = String(value ?? '').trim().toLowerCase();
  const prefix = network === 'mainnet' ? 'did:iota:' : `did:iota:${network}:`;
  if (!did.startsWith(prefix) || !/^0x[0-9a-f]{64}$/.test(did.slice(prefix.length))) reject(`A valid ${network} DID is required`);
  return did;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' && !/^\d+$/.test(String(value))) reject(`Invalid ${label}`);
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) reject(`Invalid ${label}`); return n;
}
export function normalizeReader(value: any, network: string, now = 0): Reader {
  const v = object(value);
  const reader: Reader = { did: canonicalDid(v.did ?? v.subject_did, network), scopes: integer(v.scopes, 'scopes'),
    validFrom: integer(v.validFrom ?? v.valid_from ?? 0, 'valid from'), expiresAt: integer(v.expiresAt ?? v.expires_at ?? 0, 'expiry'),
    historyFrom: integer(v.historyFrom ?? v.history_from ?? 0, 'history start'), historyTo: integer(v.historyTo ?? v.history_to ?? 0, 'history end'),
    allMeasurements: v.allMeasurements ?? v.all_measurements, measurements: v.measurements };
  if (reader.scopes > 63 || ((reader.scopes & 4) !== 0 && (reader.scopes & 2) === 0)) reject('Export requires history; unsupported scope');
  if ((reader.scopes & 32) && (reader.scopes !== 63 || !reader.allMeasurements || reader.measurements?.length || reader.historyFrom || reader.historyTo)) reject('Admin requires all capabilities, all measurements and unrestricted history');
  if (reader.expiresAt && (reader.expiresAt <= reader.validFrom || reader.expiresAt <= now)) reject('Access expiry must follow its start and be in the future');
  if (reader.historyTo && reader.historyTo <= reader.historyFrom) reject('History end must follow its start');
  if (!(reader.scopes & 2) && (reader.historyFrom || reader.historyTo)) reject('History bounds require historical access');
  if (typeof reader.allMeasurements !== 'boolean' || !Array.isArray(reader.measurements) || reader.measurements.length > 64) reject('Invalid measurement selection');
  if (reader.measurements.some(k => typeof k !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k) || ['constructor', 'prototype'].includes(k)) || new Set(reader.measurements).size !== reader.measurements.length) reject('Use distinct exact measurement keys');
  if (reader.allMeasurements && reader.measurements.length) reject('Choose all measurements or an explicit list');
  if ((reader.scopes & 3) && !reader.allMeasurements && !reader.measurements.length) reject('Select at least one measurement');
  return reader;
}
export function normalizePolicy(input: any, network: string, ownerDid: string, now = 0): AccessPolicy {
  if (!input || !['private', 'restricted', 'public'].includes(input.mode) || !Array.isArray(input.readers) || input.readers.length > 100) reject('Invalid access policy');
  const publicScopes = integer(input.publicScopes ?? 0, 'public scopes');
  if ((publicScopes & 25) !== publicScopes || publicScopes > 31 || (input.mode !== 'public' && publicScopes)) reject('Only public realtime, location and evidence can be enabled');
  const readers = input.readers.map((r: unknown) => normalizeReader(r, network, now));
  if (new Set(readers.map((r: Reader) => r.did)).size !== readers.length) reject('Duplicate DID');
  if ((input.mode === 'private' && readers.length) || (input.mode === 'restricted' && !readers.length)) reject('Restricted visibility requires readers; private visibility has none');
  const revision = String(input.revision ?? '0'); if (!/^\d+$/.test(revision) || BigInt(revision) > 18446744073709551615n) reject('Invalid policy revision');
  return { mode: input.mode, publicScopes, readers, ownerDid: canonicalDid(ownerDid, network), revision, updatedAt: integer(input.updatedAt ?? 0, 'updated time'), source: 'chain' };
}
/** No cache or metadata fallback for migrated Twins. Missing/unreadable policy denies access. */
export async function loadChainPolicy(client: Pick<IotaClient, 'getDynamicFieldObject'>, twinId: string, fields: any, network: string, accessPackage = ACCESS_PACKAGES[network]): Promise<AccessPolicy | null> {
  if (String(fields.version) === '1' || fields.version === undefined) return null;
  if (String(fields.version) !== '2' || fields.deletion_prepared === true || !accessPackage) reject('Twin access is unavailable', 503);
  const result = await client.getDynamicFieldObject({ parentObjectId: twinId, name: { type: `${accessPackage}::oid_twin::DataAccessKey`, value: { dummy_field: false } }, options: { showContent: true } });
  const content = result.data?.content;
  if (result.error || content?.dataType !== 'moveObject') return reject('On-chain access policy unavailable', 503);
  const value = object(object(content.fields).value);
  if (String(value.owner_did).toLowerCase() !== String(fields.owner_did).toLowerCase()) reject('Access policy owner mismatch', 503);
  const modes = ['private', 'restricted', 'public'];
  return normalizePolicy({ mode: modes[Number(value.mode)], publicScopes: value.public_scopes, readers: value.readers, revision: value.revision, updatedAt: value.updated_at }, network, value.owner_did);
}
export function policyRights(policy: AccessPolicy, did: string, now = Date.now()): Rights {
  const owner = policy.ownerDid === did.toLowerCase();
  const reader = policy.readers.find(r => r.did === did.toLowerCase() && r.validFrom <= now && (!r.expiresAt || now < r.expiresAt)) ?? null;
  return { discover: owner || policy.mode === 'public' || Boolean(reader), scopes: owner ? 31 : policy.publicScopes | (reader?.scopes ?? 0),
    publicScopes: policy.publicScopes, reader, owner, admin: Boolean(reader && (reader.scopes & 32)), revision: policy.revision, expiresAt: owner ? 0 : reader?.expiresAt ?? 0 };
}
export function measurementAllowed(rights: Rights, scope: number, key: string, observedAt: number): boolean {
  if (![1, 2, 4].includes(scope) || !(rights.scopes & scope)) return false;
  if (rights.owner || (rights.publicScopes & scope)) return true;
  const r = rights.reader;
  return Boolean(r && (r.scopes & scope) && (r.allMeasurements || r.measurements.includes(key)) &&
    (scope === 1 || (observedAt >= r.historyFrom && (!r.historyTo || observedAt < r.historyTo))));
}
export function permissionSummary(rights: Rights) {
  return { realtime: Boolean(rights.scopes & 1), storage: Boolean(rights.scopes & 2), history: Boolean(rights.scopes & 2),
    export: Boolean(rights.scopes & 4), location: Boolean(rights.scopes & 8), evidence: Boolean(rights.scopes & 16), admin: Boolean(rights.admin) };
}
/** Reconstruct a safe response: do not copy arbitrary metadata, aggregates or raw blobs. */
export function filterPayload(payload: any, rights: Rights, scope: number, observedAt: number): any {
  if (rights.legacy && [2, 4].includes(scope) && (rights.scopes & scope)) return payload;
  if (!(rights.scopes & scope)) reject('This data scope is not authorized', 403);
  if (payload == null) return null;
  if (payload.encrypted === true || payload.ciphertext || payload.cipherText) reject('Encrypted data requires source-side filtering before sharing', 409);
  if (typeof payload !== 'object' || Array.isArray(payload)) reject('This payload schema does not support controlled sharing', 409);
  if (scope !== 1 && !rights.owner && rights.reader && (observedAt < rights.reader.historyFrom || (rights.reader.historyTo && observedAt >= rights.reader.historyTo))) reject('Historical sample is outside the authorized interval', 403);
  const out: Record<string, any> = {};
  for (const key of ['schema', 'assetId', 'machineName', 'sequence', 'observedAt']) {
    if (['string', 'number'].includes(typeof payload[key])) out[key] = payload[key];
  }
  if (typeof payload.simulation?.synthetic === 'boolean') out.simulation = { synthetic: payload.simulation.synthetic };
  const measurements = payload.measurements;
  const scalar = (v: unknown) => typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
  const locationKeys = /^(lat|latitude|lon|lng|longitude|altitude|heading|headingDegrees|speed|speedKph|accuracy|accuracyMeters|position|location|gps|coordinates)$/i;
  if (measurements && typeof measurements === 'object' && !Array.isArray(measurements)) {
    out.measurements = {};
    for (const [key, value] of Object.entries(measurements)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype'].includes(key) || locationKeys.test(key) || !measurementAllowed(rights, scope, key, observedAt)) continue;
      const v: any = value;
      if (scalar(v)) out.measurements[key] = v;
      else if (v && scalar(v.value)) out.measurements[key] = { value: v.value, ...(typeof v.unit === 'string' ? { unit: v.unit } : {}), ...(typeof v.label === 'string' ? { label: v.label.slice(0, 128) } : {}), ...(typeof v.semanticKey === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v.semanticKey) ? { semanticKey: v.semanticKey } : {}) };
    }
  } else {
    // Flat legacy telemetry is supported only for explicitly evaluated scalar keys.
    for (const [key, value] of Object.entries(payload)) {
      if (!Object.hasOwn(out, key) && !locationKeys.test(key) && /^(temperature|vibration|rpm|activePower|power|pressure|energy|pvPower|loadPower|gridPower|gridImportPower|gridExportPower|solarIrradiance)$/.test(key) && scalar(value) && measurementAllowed(rights, scope, key, observedAt)) out[key] = value;
    }
  }
  if (rights.scopes & 8) {
    for (const key of ['position', 'location', 'gps']) {
      const p = payload[key]; if (!p || typeof p !== 'object') continue;
      const clean: Record<string, unknown> = {};
      for (const k of ['lat', 'latitude', 'lon', 'lng', 'longitude', 'altitude', 'speedKph', 'headingDegrees', 'accuracyMeters', 'observedAt']) if (typeof p[k] === 'number' && Number.isFinite(p[k])) clean[k] = p[k];
      if (p.type === 'Point' && Array.isArray(p.coordinates) && p.coordinates.length >= 2 && p.coordinates.length <= 3 && p.coordinates.every((n: any) => typeof n === 'number' && Number.isFinite(n))) { clean.type = 'Point'; clean.coordinates = p.coordinates; clean.crs = 'EPSG:4326'; }
      out[key] = clean;
    }
  }
  return out;
}
