import { loadChainPolicy, policyRights, permissionSummary, filterPayload, AccessPolicyError, type Rights } from './policy.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { IotaClient, getFullnodeUrl } from '@iota/iota-sdk/client';
import { verifyPersonalMessageSignature } from '@iota/iota-sdk/verify';
import { AppError } from '../common/errors.js';
import type { ObjectIdAdapter, AccountingContext } from '../objectid/types.js';
import type { CredentialProvider } from '../security/credentials.js';
import { ownsIdentityController } from '../security/did-controller.js';

const fail = (message: string, status = 403): never => { throw new AppError('TWIN_SHARING_DENIED', message, status, 'AUTHORIZATION'); };
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const fieldsOf = (v: any) => v?.data?.content?.fields ?? v?.content?.fields ?? v?.fields ?? {};
function metadata(v: unknown): any {
  try { const m = typeof v === 'string' ? JSON.parse(v || '{}') : v ?? {}; if (!m || typeof m !== 'object' || Array.isArray(m) || (m.objectid != null && (typeof m.objectid !== 'object' || Array.isArray(m.objectid)))) return fail('Invalid Twin metadata', 422); return m; }
  catch { return fail('Invalid Twin metadata', 422); }
}
type Policy = { mode: 'private' | 'restricted' | 'public'; allowedDids: string[]; storageDids?: string[]; ownerDid: string; revision: string; pending?: boolean };
type Grant = { did: string; twinId: string; expiresAt: number };
export class TwinSharing {
  readonly changes = new EventEmitter();
  private queues = new Map<string, Promise<unknown>>();
  private challenges = new Map<string, { did: string; twinId: string; message: string; expiresAt: number }>();
  private sessions = new Map<string, Grant>();
  private client: IotaClient;
  constructor(readonly options: { network: string; packageId: string; accessPackageId?: string; rpcUrl: string; publicUrl: string; directory: string; credentials: CredentialProvider; objectid: ObjectIdAdapter; decodePayload?: (ownerDid: string, twinId: string, payload: unknown) => Promise<unknown>; verifyController?: (did: string, address: string) => Promise<boolean>; now?: () => number }) {
    this.client = new IotaClient({ url: options.rpcUrl || getFullnodeUrl(options.network as 'testnet' | 'mainnet') });
    this.changes.setMaxListeners(0);
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  id(v: unknown) { const id = String(v ?? '').toLowerCase(); if (!/^0x[0-9a-f]{64}$/.test(id)) return fail('Invalid Twin ID', 400); return id; }
  did(v: unknown) { const did = String(v ?? '').trim().toLowerCase(), prefix = this.options.network === 'mainnet' ? 'did:iota:' : `did:iota:${this.options.network}:`; if (!did.startsWith(prefix) || !/^0x[0-9a-f]{64}$/.test(did.slice(prefix.length))) return fail(`A valid ${this.options.network} DID is required`, 422); return did; }
  async twin(id: string) {
    const twin: any = this.options.accessPackageId ? await this.client.getObject({ id: this.id(id), options: { showType: true, showContent: true } }) : await this.options.objectid.getTwin(this.id(id));
    if (String(twin?.data?.type ?? twin?.data?.content?.type ?? twin?.content?.type ?? twin?.type).toLowerCase() !== `${this.options.packageId}::oid_twin::OIDTwin`.toLowerCase()) return fail('Twin unavailable', 404);
    return fieldsOf(twin);
  }
  private path(id: string) { return join(this.options.directory, `${this.id(id)}.json`); }
  async stored(id: string): Promise<Policy | null> {
    try { const value = JSON.parse(await readFile(this.path(id), 'utf8')); if (!['private', 'restricted', 'public'].includes(value.mode) || !Array.isArray(value.allowedDids) || typeof value.ownerDid !== 'string' || (value.storageDids !== undefined && (!Array.isArray(value.storageDids) || value.storageDids.some((did: unknown) => typeof did !== 'string' || !value.allowedDids.includes(did))))) return fail('Access policy unavailable', 503); return value; }
    catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async chainPolicy(id: string, fields?: any) {
    try { return await loadChainPolicy(this.client, id, fields ?? (this.options.accessPackageId ? await this.twin(id) : fieldsOf(await this.options.objectid.getTwin(id))), this.options.network, this.options.accessPackageId); }
    catch (e) { throw new AppError('TWIN_POLICY_UNAVAILABLE', e instanceof AccessPolicyError ? e.message : 'On-chain access policy unavailable', 503, 'AUTHORIZATION'); }
  }
  async publicAccess(id: string) {
    const p = await this.chainPolicy(id);
    if (!p) return null;
    return { ownerDid: p.ownerDid, twinPublic: p.mode === 'public', dataPublic: Boolean(p.publicScopes & 1), liveLocationPublic: Boolean(p.publicScopes & 8), rights: policyRights(p, '', this.now()) };
  }
  async blocksPublic(id: string, kind: boolean | 'location' = true) {
    const chain = await this.publicAccess(id);
    if (chain) return !chain.twinPublic || (kind === true && !chain.dataPublic) || (kind === 'location' && !chain.liveLocationPublic);
    const p = await this.stored(id); return Boolean(p && (p.pending || (kind === true && p.mode !== 'public')));
  }
  filter(value: unknown, rights: Rights, scope: number, observedAt: number) {
    try { return filterPayload(value, rights, scope, observedAt); }
    catch (e) { throw new AppError('DATASET_SCOPE_FILTER', e instanceof Error ? e.message : 'Data filtering unavailable', e instanceof AccessPolicyError ? e.status : 409, 'AUTHORIZATION'); }
  }
  async filterSample(id: string, ownerDid: string, payload: any, rights: Rights, scope: number, observedAt: number) {
    if (rights.legacy && [2, 4].includes(scope)) return this.filter(payload, rights, scope, observedAt);
    const decoded = payload?.encrypted === true && this.options.decodePayload ? await this.options.decodePayload(ownerDid, id, payload) : payload;
    return this.filter(decoded, rights, scope, observedAt);
  }
  async filteredRealtime(id: string, token: string, event: any) {
    const access = await this.read(id, token, 'realtime');
    if (!event) return { twinId: id, payload: null };
    const payload = await this.filterSample(id, access.fields.owner_did, event.payload, access.rights, 1, event.observedAt);
    const current = await this.read(id, token, 'realtime');
    if (current.revision !== access.revision) return fail('Permissions changed during this request');
    return { twinId: id, observedAt: event.observedAt, receivedAt: event.receivedAt, payload, encryption: { encrypted: false } };
  }
  async filteredPublicRealtime(id: string, event: any) {
    const access = await this.publicAccess(id);
    if (!access) return event;
    if (!access.twinPublic || !access.dataPublic) return fail('Public telemetry unavailable', 404);
    const payload = await this.filterSample(id, access.ownerDid, event.payload, access.rights, 1, event.observedAt);
    const current = await this.publicAccess(id);
    if (!current?.twinPublic || !current.dataPublic || current.rights.revision !== access.rights.revision) return fail('Public permissions changed', 404);
    return { twinId: id, observedAt: event.observedAt, receivedAt: event.receivedAt, payload, encryption: { encrypted: false } };
  }
  private async commit(id: string, policy: Policy) {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const tmp = `${this.path(id)}.${randomUUID()}.tmp`, file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(policy)); await file.sync(); } finally { await file.close(); }
    await rename(tmp, this.path(id));
    this.changes.emit(id);
    this.changes.emit('policyChanged', id);
  }
  async manage(id: string, did: string) {
    const f = await this.twin(id), owner = String(f.owner_did ?? '').toLowerCase();
    if (owner !== this.did(did)) return fail('Only the owner can manage data access');
    return f;
  }
  async policy(id: string, did: string) {
    const f = await this.manage(id, did);
    const chain = await this.chainPolicy(id, f);
    if (chain) return { ...chain, visibility: chain.mode, liveLocationVisibility: chain.publicScopes & 8 ? 'public' : 'private',
      allowedDids: chain.readers.map(r => r.did), storageDids: chain.readers.filter(r => r.scopes & 2).map(r => r.did), pending: false, needsActivation: false };
    const m = metadata(f.mutable_metadata), saved = await this.stored(id);
    const mode = m.objectid?.dataVisibility ?? m.dataVisibility;
    const ownPolicy = saved?.ownerDid === String(f.owner_did).toLowerCase();
    return { mode: ['public', 'restricted'].includes(mode) ? mode : 'private', visibility: m.objectid?.visibility === 'public' ? 'public' : 'private', liveLocationVisibility: m.objectid?.liveLocationVisibility === 'public' ? 'public' : 'private', allowedDids: ownPolicy ? saved.allowedDids : [], storageDids: ownPolicy ? (saved.storageDids ?? []).filter(d => saved.allowedDids.includes(d)) : [], revision: saved?.revision ?? null, pending: Boolean(saved?.pending) };
  }
  async update(id: string, did: string, input: any, accounting?: AccountingContext) {
    id = this.id(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const f = await this.manage(id, did);
      if (await this.chainPolicy(id, f)) return fail('On-chain permissions must be signed by the owner in the webview', 409);
      if (!['private', 'restricted', 'public'].includes(input?.mode) || !['private', 'public'].includes(input?.visibility) || !['private', 'public'].includes(input?.liveLocationVisibility)) return fail('Invalid access mode', 422);
      if (input.mode === 'public' && input.visibility !== 'public') return fail('Public data requires a public Twin', 422);
      if (!Array.isArray(input.allowedDids) || input.allowedDids.length > 100) return fail('Provide at most 100 authorized DIDs', 422);
      const allowedDids = [...new Set<string>(input.allowedDids.map((d: unknown) => this.did(d)))];
      if (input.mode === 'restricted' && !allowedDids.length) return fail('Add at least one authorized DID, or choose Private to revoke all access', 422);
      const ownerDid = String(f.owner_did).toLowerCase(), revision = randomUUID();
      const current = await this.stored(id);
      if (input.revision !== (current?.revision ?? null)) return fail('Access settings changed. Close and reopen the dialog.', 409);
      // Legacy clients preserve existing flags only for DIDs still authorized by the same owner.
      const requestedStorage = input.storageDids === undefined
        ? (current?.ownerDid === ownerDid ? current.storageDids ?? [] : []).filter(d => allowedDids.includes(d))
        : input.storageDids;
      if (!Array.isArray(requestedStorage) || requestedStorage.length > 100) return fail('Invalid storage access permissions', 422);
      const storageDids = [...new Set<string>(requestedStorage.map((d: unknown) => this.did(d)))];
      if (storageDids.some(d => !allowedDids.includes(d))) return fail('Storage access requires realtime access for the same DID', 422);
      const m = metadata(f.mutable_metadata);
      // Deny reads throughout the distributed update; a failed transaction stays closed.
      await this.commit(id, { mode: 'private', allowedDids: [], ownerDid, revision, pending: true });
      const mutation = await this.options.objectid.updateTwin(id, {
        name: String(f.name ?? ''), description: String(f.description ?? ''),
        mutableMetadata: JSON.stringify({ ...m, objectid: { ...m.objectid, visibility: input.visibility, dataVisibility: input.mode, liveLocationVisibility: input.visibility === 'public' ? input.liveLocationVisibility : 'private' } }),
      }, accounting);
      await this.commit(id, { mode: input.mode, allowedDids: input.mode === 'restricted' ? allowedDids : [], storageDids: input.mode === 'restricted' ? storageDids : [], ownerDid, revision });
      return { mode: input.mode, visibility: input.visibility, liveLocationVisibility: input.liveLocationVisibility, revision, digest: (mutation as any)?.digest ?? null };
    });
    this.queues.set(id, job);
    try { return await job; } finally { if (this.queues.get(id) === job) this.queues.delete(id); }
  }
  async assertRead(id: string, did: string, scope: 'discover' | 'realtime' | 'storage' | 'export' | 'location' | 'evidence' = 'discover') {
    return (await this.authorize(id, did, scope)).fields;
  }
  private async authorize(id: string, did: string, scope: 'discover' | 'realtime' | 'storage' | 'export' | 'location' | 'evidence') {
    const f = await this.twin(id);
    const chain = await this.chainPolicy(id, f);
    if (chain) {
      const rights = policyRights(chain, this.did(did), this.now());
      const bit = { discover: 0, realtime: 1, storage: 2, export: 4, location: 8, evidence: 16 }[scope];
      if (!rights.discover || (bit && !(rights.scopes & bit))) return fail('Your DID is not authorized for this data scope');
      return { fields: f, policy: chain, rights };
    }
    const m = metadata(f.mutable_metadata), p = await this.stored(id);
    if (!p || p.pending || p.mode !== 'restricted' || (m.objectid?.dataVisibility ?? m.dataVisibility) !== 'restricted' || p.ownerDid !== String(f.owner_did).toLowerCase()) return fail('Restricted access is unavailable or revoked');
    if (!p.allowedDids.includes(this.did(did)) && ![f.owner_did, f.steward_did].map(x => String(x).toLowerCase()).includes(this.did(did))) return fail('Your DID is not authorized for this Twin');
    if (['storage', 'export'].includes(scope) && this.did(did) !== String(f.owner_did).toLowerCase() && !(p.allowedDids.includes(this.did(did)) && p.storageDids?.includes(this.did(did)))) return fail('Your DID is authorized for realtime data only');
    const owner = this.did(did) === String(f.owner_did).toLowerCase();
    const scopes = owner ? 31 : 1 | (p.storageDids?.includes(this.did(did)) ? 6 : 0);
    const rights: Rights = { legacy: true, discover: true, scopes, publicScopes: 0, owner, revision: p.revision, expiresAt: 0,
      reader: { did: this.did(did), scopes, validFrom: 0, expiresAt: 0, historyFrom: 0, historyTo: 0, allMeasurements: true, measurements: [] } };
    if (scope === 'location' || scope === 'evidence') { if (!owner) return fail('Activate explicit on-chain resource access first'); }
    return { fields: f, policy: p, rights };
  }
  private prune() { for (const [k, v] of this.challenges) if (v.expiresAt <= this.now()) this.challenges.delete(k); for (const [k, v] of this.sessions) if (v.expiresAt <= this.now()) this.sessions.delete(k); }
  async challenge(id: string, rawDid: unknown) {
    id = this.id(id); const did = this.did(rawDid); await this.assertRead(id, did); this.prune();
    if (this.challenges.size >= 1000) return fail('Too many pending requests', 429);
    const challengeId = randomUUID(), expiresAt = this.now() + 120_000;
    const message = ['ObjectID restricted Twin read access', `Network: ${this.options.network}`, `Package: ${this.options.packageId}`, `Twin: ${id}`, `DID: ${did}`, `Server: ${this.options.publicUrl.replace(/\/$/, '')}`, `Nonce: ${randomBytes(32).toString('hex')}`, `Expires: ${expiresAt}`].join('\n');
    this.challenges.set(challengeId, { did, twinId: id, message, expiresAt });
    return { challengeId, message, expiresAt };
  }
  async verify(id: string, input: any) {
    id = this.id(id); const c = this.challenges.get(String(input?.challengeId)); this.challenges.delete(String(input?.challengeId));
    if (!c || c.twinId !== id || c.expiresAt <= this.now() || c.did !== this.did(input?.did)) return fail('Invalid or expired challenge', 401);
    if (typeof input.signature !== 'string' || input.signature.length > 2048) return fail('Invalid signature', 401);
    let address: string;
    try { address = (await verifyPersonalMessageSignature(new TextEncoder().encode(c.message), input.signature)).toIotaAddress(); } catch { return fail('Invalid signature', 401); }
    if (!await (this.options.verifyController?.(c.did, address) ?? this.ownsController(c.did, address))) return fail('DID controller not owned');
    await this.assertRead(id, c.did); this.prune(); if (this.sessions.size >= 1000) return fail('Too many active sessions', 429);
    const token = randomBytes(32).toString('base64url'), expiresAt = this.now() + 1800_000;
    this.sessions.set(hash(token), { did: c.did, twinId: id, expiresAt }); return { token, expiresAt };
  }
  async read(id: string, token: string, scope: 'discover' | 'realtime' | 'storage' | 'export' | 'location' | 'evidence' = 'discover') {
    id = this.id(id); const grant = this.sessions.get(hash(token));
    if (!grant || grant.twinId !== id || grant.expiresAt <= this.now()) return fail('Restricted session expired. Reconnect with your DID.', 401);
    const { fields, policy: p, rights } = await this.authorize(id, grant.did, scope);
    if (grant.expiresAt <= this.now()) return fail('Restricted session expired. Reconnect with your DID.', 401);
    return { fields, did: grant.did, expiresAt: Math.min(grant.expiresAt, rights.expiresAt || Infinity), revision: p.revision, rights, permissions: permissionSummary(rights) };
  }
  private async ownsController(did: string, address: string) {
    const pkg = await this.options.credentials.get('DTIS_IDENTITY_PACKAGE_ID');
    if (!pkg || !/^0x[0-9a-f]{64}$/i.test(pkg)) return fail('DID verification is not configured on this Integration Server', 503);
    return ownsIdentityController(this.client, this.options.network, pkg, did, address);
  }
}
