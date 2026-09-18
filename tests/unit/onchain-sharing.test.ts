import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';
import { unzipSync } from 'fflate';
import { ACCESS_PACKAGES, normalizePolicy, policyRights, filterPayload, loadChainPolicy } from '../../src/sharing/policy.js';
import { TwinSharing } from '../../src/sharing/service.js';
import { SharedDatasets } from '../../src/sharing/datasets.js';
const id = '0x' + 'a'.repeat(64), pkg = '0x' + 'b'.repeat(64);
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

describe.each(['testnet', 'mainnet'])('on-chain scoped access on %s', network => {
  const did = (n: string) => `did:iota:${network === 'mainnet' ? '' : network + ':'}0x${n.repeat(64)}`;
  const owner = did('1'), reader = did('2');
  const grant = () => ({ did: reader, scopes: 7, validFrom: 100, expiresAt: 2000, historyFrom: 100, historyTo: 300, allMeasurements: false, measurements: ['pvPower'] });
  const policy = () => normalizePolicy({ mode: 'restricted', revision: '1', publicScopes: 0, readers: [grant()] }, network, owner);
  const payload = { measurements: { pvPower: { value: 9, unit: 'kW' }, loadPower: { value: 8 }, latitude: { value: 45 } }, position: { latitude: 45, longitude: 9 }, password: 'SECRET', raw: { excluded: 99 } };
  it('filters exact measures, metadata and location before data leaves the server', () => {
    const rights = policyRights(policy(), reader, 1000);
    expect(filterPayload(payload, rights, 1, 1000)).toEqual({ measurements: { pvPower: { value: 9, unit: 'kW' } } });
    const all = policy(); all.readers[0]!.allMeasurements = true; all.readers[0]!.measurements = [];
    expect(filterPayload({ power: 1, password: 'SECRET', latitude: 45 }, policyRights(all, reader, 1000), 1, 1000)).toEqual({ power: 1 });
    expect(() => filterPayload({ encrypted: true, ciphertext: 'SECRET' }, rights, 1, 1000)).toThrow(/source-side/);
  });
  it('enforces grant boundaries and makes public realtime additive without expanding private history', () => {
    const p = policy();
    expect(policyRights(p, reader, 99).discover).toBe(false); expect(policyRights(p, reader, 100).discover).toBe(true);
    expect(policyRights(p, reader, 2000).discover).toBe(false); expect(policyRights(p, did('3'), 1000).discover).toBe(false);
    expect(() => filterPayload(payload, policyRights(p, reader, 1000), 2, 300)).toThrow(/interval/);
    p.mode = 'public'; p.publicScopes = 1;
    expect(filterPayload(payload, policyRights(p, reader, 1000), 1, 200).measurements).toHaveProperty('loadPower');
    expect(filterPayload(payload, policyRights(p, reader, 1000), 2, 200).measurements).not.toHaveProperty('loadPower');
    expect(() => filterPayload(payload, policyRights(p, '', 1000), 4, 200)).toThrow(/scope/);
  });
  it('rejects invalid scopes, duplicate DIDs, arbitrary paths and missing on-chain policies', async () => {
    for (const patch of [{ scopes: 4 }, { scopes: 32 }, { measurements: ['../secret'] }, { measurements: ['constructor'] }, { allMeasurements: true }]) expect(() => normalizePolicy({ ...policy(), readers: [{ ...grant(), ...patch }] }, network, owner)).toThrow();
    expect(() => normalizePolicy({ ...policy(), readers: [grant(), grant()] }, network, owner)).toThrow(/Duplicate/);
    await expect(loadChainPolicy({ getDynamicFieldObject: async () => ({ error: { code: 'notExists', object_id: id } }) }, id, { version: 2, owner_did: owner, mutable_metadata: '{"objectid":{"visibility":"public"}}' }, network)).rejects.toThrow(/unavailable/);
    await expect(loadChainPolicy({ getDynamicFieldObject: async () => { throw Error('RPC down'); } }, id, { version: 2, owner_did: owner }, network)).rejects.toThrow('RPC down');
  });
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'chain-access-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const fields = { version: 2, owner_did: owner, mutable_metadata: '{}' }; let current = policy(); let now = 1000;
    const chain = { getObject: async () => ({ data: { type: `${pkg}::oid_twin::OIDTwin`, content: { dataType: 'moveObject', fields } } }),
      getDynamicFieldObject: async (args: any) => { expect(args.name.value).toEqual({ dummy_field: false }); expect(args.name.type).toBe(`${ACCESS_PACKAGES[network]}::oid_twin::DataAccessKey`); return { data: { content: { dataType: 'moveObject', fields: { value: { fields: { owner_did: current.ownerDid, mode: ['private', 'restricted', 'public'].indexOf(current.mode), public_scopes: current.publicScopes, revision: current.revision, updated_at: 0, readers: current.readers } } } } } }; } };
    const sharing = new TwinSharing({ network, packageId: pkg, accessPackageId: ACCESS_PACKAGES[network], rpcUrl: 'https://example.test', directory, publicUrl: 'https://is.example', objectid: {} as any, credentials: {} as any, now: () => now, verifyController: async () => true });
    (sharing as any).client = chain;
    const key = Ed25519Keypair.generate();
    async function login() { const c = await sharing.challenge(id, reader); return sharing.verify(id, { challengeId: c.challengeId, did: reader, signature: (await key.signPersonalMessage(new TextEncoder().encode(c.message))).signature }); }
    const storage = { listManagedObjects: async () => [{ twinId: id, category: 'dataset', uri: 'private://secret' }], read: async () => Buffer.from(JSON.stringify({ twinId: id, samples: [{ observedAt: 150, value: payload }, { observedAt: 250, value: payload }, { observedAt: 350, value: payload }] })) };
    const datasets = new SharedDatasets(sharing, storage as any, () => now); cleanups.push(() => datasets.close());
    return { sharing, datasets, login, fields, change: (p: any) => { current = { ...current, ...p, revision: String(Number(current.revision) + 1) }; }, expire: () => { now = 2000; } };
  }
  it('supports history-only login, denies realtime and export, rechecks expiry', async () => {
    const f = await fixture(); f.change({ readers: [{ ...grant(), scopes: 2 }] }); const s = await f.login();
    await expect(f.sharing.read(id, s.token, 'realtime')).rejects.toMatchObject({ status: 403 });
    await expect(f.datasets.create(id, s.token, { fromTimestamp: 100, toTimestamp: 299 })).rejects.toMatchObject({ status: 403 });
    const history = await f.datasets.history(id, s.token, { fromTimestamp: 100, toTimestamp: 299 });
    expect(history.samples).toHaveLength(2); expect(JSON.stringify(history)).not.toMatch(/loadPower|latitude|longitude|SECRET|private:\/\//);
    f.expire(); await expect(f.sharing.read(id, s.token)).rejects.toMatchObject({ status: 403 });
  });
  it('decrypts before filtering and rejects a policy change during source I/O', async () => {
    const f = await fixture(), s = await f.login();
    f.sharing.options.decodePayload = async () => payload;
    const event = { observedAt: 150, payload: { encrypted: true, ciphertext: 'opaque' } };
    expect((await f.sharing.filteredRealtime(id, s.token, event)).payload).toEqual({ measurements: { pvPower: { value: 9, unit: 'kW' } } });
    f.sharing.options.decodePayload = async () => { f.change({ mode: 'private', readers: [] }); return payload; };
    await expect(f.sharing.filteredRealtime(id, s.token, event)).rejects.toMatchObject({ status: 403 });
  });
  it('binds exports to current on-chain revision and filters private storage samples', async () => {
    const f = await fixture(), s = await f.login();
    await expect(f.datasets.create(id, s.token, { fromTimestamp: 100, toTimestamp: 300 })).rejects.toMatchObject({ status: 403 });
    const job = await f.datasets.create(id, s.token, { fromTimestamp: 100, toTimestamp: 299 });
    let status; for (let n = 0; n < 50; n++) { status = await f.datasets.status(id, s.token, job.requestId); if (status.status !== 'preparing') break; await new Promise(r => setTimeout(r, 2)); }
    expect(status?.status).toBe('ready');
    const archive = await f.datasets.download(id, s.token, job.requestId); const files = unzipSync(archive.bytes);
    expect(Buffer.from(files['data.json']!).toString()).not.toMatch(/loadPower|latitude|SECRET|private:\/\//);
    f.change({ readers: [{ ...grant(), measurements: ['loadPower'] }] });
    await expect(f.datasets.download(id, s.token, job.requestId)).rejects.toMatchObject({ status: 403 });
    f.change({ mode: 'private', readers: [] }); await expect(f.sharing.read(id, s.token)).rejects.toMatchObject({ status: 403 });
  });
  it('reports download limits and narrows ZIP measurements without broadening the grant', async () => {
    const f = await fixture(), s = await f.login();
    expect(await f.datasets.context(id, s.token)).toMatchObject({ historyFrom: 100, historyTo: 300, allMeasurements: false, measurements: ['pvPower'], maxRangeMs: 31 * 86400000 });
    await expect(f.datasets.create(id, s.token, { fromTimestamp: 100, toTimestamp: 299, measurements: ['loadPower'] })).rejects.toMatchObject({ status: 403 });
    await expect(f.datasets.create(id, s.token, { fromTimestamp: 100, toTimestamp: 299, measurements: ['constructor'] })).rejects.toMatchObject({ status: 422 });
    f.change({ readers: [{ ...grant(), allMeasurements: true, measurements: [] }] });
    const session = await f.login();
    const job = await f.datasets.create(id, session.token, { fromTimestamp: 100, toTimestamp: 299, measurements: ['pvPower'] });
    let status = await f.datasets.status(id, session.token, job.requestId);
    for (let i = 0; status.status === 'preparing' && i < 30; i++) { await new Promise(r => setTimeout(r, 5)); status = await f.datasets.status(id, session.token, job.requestId); }
    expect(status.status).toBe('ready');
    const archive = await f.datasets.download(id, session.token, job.requestId), files = unzipSync(archive.bytes);
    const data = JSON.parse(Buffer.from(files['data.json']!).toString()), manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString());
    expect(data.samples).toHaveLength(2); expect(JSON.stringify(data)).not.toMatch(/loadPower|latitude|SECRET/);
    expect(manifest.selection.measurements).toEqual(['pvPower']); expect(manifest.accessPolicy.measures).toBe('all');
    f.change({ readers: [{ ...grant(), scopes: 1, historyFrom: 0, historyTo: 0 }] });
    await expect(f.datasets.context(id, session.token)).rejects.toMatchObject({ status: 403 });
    await expect(f.datasets.download(id, session.token, job.requestId)).rejects.toMatchObject({ status: 403 });
  });
});
