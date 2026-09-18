import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { unzipSync } from 'fflate';
import express from 'express';
import request from 'supertest';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';
import { TwinSharing } from '../../src/sharing/service.js';
import { SharedDatasets, DATASET_LIMITS } from '../../src/sharing/datasets.js';
import { sharingRoutes } from '../../src/sharing/routes.js';
import { TwinRealtimeHub } from '../../src/realtime/hub.js';
import { LocalFilesystemStorageProvider } from '../../src/storage/filesystem.js';
import { StorageRouter } from '../../src/storage/storage-router.js';
import { errorBody } from '../../src/common/errors.js';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const id = '0x' + 'a'.repeat(64), otherId = '0x' + 'b'.repeat(64), packageId = '0x' + 'f'.repeat(64);
const selection = { fromTimestamp: 100, toTimestamp: 200 };
async function fixture(network = 'testnet', storageAccess = true) {
  const directory = await mkdtemp(join(tmpdir(), 'oid-exports-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const did = (c: string) => `did:iota:${network === 'mainnet' ? '' : network + ':'}0x${c.repeat(64)}`;
  const owner = did('1'), reader = did('2'), second = did('3');
  const key = Ed25519Keypair.generate(); let now = Date.now();
  const fields = { name: 'Solar test', owner_did: owner, steward_did: did('4'), mutable_metadata: '{}' };
  const objectid: any = { getTwin: async () => ({ data: { type: `${packageId}::oid_twin::OIDTwin`, content: { fields } } }), updateTwin: async (_: string, input: any) => { fields.mutable_metadata = input.mutableMetadata; return { digest: 'test' }; } };
  const sharing = new TwinSharing({ network, packageId, directory: join(directory, 'policies'), publicUrl: `https://is.example${network === 'mainnet' ? '/mainnet' : ''}`, rpcUrl: 'https://rpc.example', credentials: { get: async () => packageId } as any, objectid, now: () => now, verifyController: async (did, address) => [reader, second].includes(did) && address === key.toIotaAddress() });
  const input = { mode: 'restricted', visibility: 'private', liveLocationVisibility: 'private', allowedDids: [reader, second], storageDids: storageAccess ? [reader, second] : [], revision: null as string | null };
  await sharing.update(id, owner, input);
  async function login(did = reader) { const challenge = await sharing.challenge(id, did); const signed = await key.signPersonalMessage(new TextEncoder().encode(challenge.message)); return sharing.verify(id, { did, challengeId: challenge.challengeId, signature: signed.signature }); }
  const provider = new LocalFilesystemStorageProvider({ type: 'filesystem', basePath: join(directory, 'private-store') });
  const storage = new StorageRouter({ defaultProvider: 'private', routes: {}, providers: { private: { type: 'filesystem', basePath: join(directory, 'private-store') } } }, new Map([['private', provider]]));
  const datasets = new SharedDatasets(sharing, storage, () => now); cleanup.push(() => datasets.close());
  const app = express(); app.use(express.json()); app.use('/shared', sharingRoutes(sharing, new TwinRealtimeHub(), datasets)); app.use((error: unknown, _q: any, r: any, _next: any) => { const mapped = errorBody(error); r.status(mapped.status).json(mapped.body); });
  const store = (samples: any[], twinId = id, extra = {}) => storage.store({ data: Buffer.from(JSON.stringify({ twinId, fromTimestamp: 50, toTimestamp: 300, samples, ...extra })), category: 'dataset', twinId, fileName: 'dataset.json' });
  const update = async (patch: any) => sharing.update(id, owner, { ...input, revision: (await sharing.policy(id, owner)).revision, ...patch });
  return { directory, fields, owner, reader, second, sharing, datasets, storage, login, app, store, update, input, advance: (ms: number) => { now += ms; } };
}
async function finished(f: Awaited<ReturnType<typeof fixture>>, token: string, requestId: string) {
  for (let n = 0; n < 100; n++) { const result = await f.datasets.status(id, token, requestId); if (result.status !== 'preparing') return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Dataset did not finish');
}
describe.each(['testnet', 'mainnet'])('scoped historical datasets on %s', network => {
  it('defaults legacy grants to realtime and preserves explicit flags for old clients without broadening new grants', async () => {
    const f = await fixture(network, false); const s = await f.login();
    const path = join(f.directory, 'policies', `${id}.json`), policy = await f.sharing.stored(id); delete policy!.storageDids; await writeFile(path, JSON.stringify(policy));
    expect((await f.sharing.read(id, s.token)).permissions.storage).toBe(false);
    const list = vi.spyOn(f.storage, 'listManagedObjects');
    await expect(f.datasets.create(id, s.token, selection)).rejects.toMatchObject({ status: 403 }); expect(list).not.toHaveBeenCalled();
    await f.update({ storageDids: [f.reader] });
    await f.update({ storageDids: undefined });
    expect((await f.sharing.policy(id, f.owner)).storageDids).toEqual([f.reader]);
    await f.update({ allowedDids: [f.second], storageDids: undefined });
    expect((await f.sharing.policy(id, f.owner)).storageDids).toEqual([]);
    await f.update({ storageDids: undefined });
    expect((await f.sharing.policy(id, f.owner)).storageDids).toEqual([]);
  });
  it('validates storage flags and cannot turn a non-authorized DID into a storage reader', async () => {
    const f = await fixture(network);
    await expect(f.update({ storageDids: [f.owner] })).rejects.toMatchObject({ status: 422 });
    await expect(f.update({ storageDids: true })).rejects.toMatchObject({ status: 422 });
    await expect(f.update({ storageDids: ['did:iota:invalid'] })).rejects.toMatchObject({ status: 422 });
    await expect(f.sharing.assertRead(id, f.fields.steward_did, 'storage')).rejects.toMatchObject({ status: 403 });
  });
  it('exports exact interval from private storage with verifiable hashes, no private URI, and no other Twins', async () => {
    const f = await fixture(network), s = await f.login();
    const encrypted = { encrypted: true, ciphertext: 'PRIVATE-CIPHERTEXT' };
    await f.store([{ observedAt: 50, value: 'outside-before' }, { observedAt: 200, value: encrypted }, { observedAt: 100, value: { power: 22, simulation: { synthetic: true } } }, { observedAt: 300, value: 'outside-after' }]);
    await f.store([{ observedAt: 100, value: 'OTHER-TWIN-SECRET' }], otherId);
    const job = await f.datasets.create(id, s.token, selection); expect(job.status).toBe('preparing');
    const result = await finished(f, s.token, job.requestId); expect(result.status).toBe('ready'); expect(result.sampleCount).toBe(2);
    expect(result.downloadUrl).toContain(network === 'mainnet' ? '/mainnet/api/' : 'example/api/'); expect(result.downloadUrl).not.toContain(s.token);
    const download = await f.datasets.download(id, s.token, job.requestId), files = unzipSync(download.bytes);
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString()), data = JSON.parse(Buffer.from(files['data.json']!).toString());
    expect(data.samples.map((v: any) => v.observedAt)).toEqual([100, 200]); expect(data.samples[1].value).toEqual(encrypted);
    expect(manifest.dataClassification).toMatchObject({ declaredSyntheticSamples: 1, encryptedSamples: 1 }); expect(manifest.integrity.onChainAnchored).toBe(false);
    expect(manifest.format).toBe('objectid.shared-dataset-manifest.v2');
    expect(manifest.signature).toMatchObject({ type: 'ObjectIDIntegrationServerSignature', algorithm: 'Ed25519', network, purpose: 'dataset-export' });
    for (const file of manifest.files) expect(createHash('sha256').update(files[file.path]!).digest('hex')).toBe(file.sha256);
    expect(createHash('sha256').update(download.bytes).digest('hex')).toBe(result.sha256);
    const content = Object.values(files).map(v => Buffer.from(v).toString()).join('\n');
    expect(content).not.toMatch(/outside-before|outside-after|OTHER-TWIN-SECRET|file:\/\/|s3:\/\//);
  });
  it('enforces session, DID and Twin boundaries at HTTP download, with no query-token fallback', async () => {
    const f = await fixture(network), s = await f.login(), second = await f.login(f.second), anotherSession = await f.login();
    await f.store([{ observedAt: 100, value: 1 }]);
    const created = await request(f.app).post(`/shared/${id}/datasets`).set('Authorization', `Bearer ${s.token}`).send(selection); expect(created.status).toBe(202);
    const rid = created.body.requestId; await finished(f, s.token, rid);
    const url = `/shared/${id}/datasets/${rid}/download`;
    expect((await request(f.app).get(url)).status).toBe(401);
    expect((await request(f.app).get(`${url}?token=${s.token}`)).status).toBe(401);
    expect((await request(f.app).get(url).set('Authorization', `Bearer ${second.token}`)).status).toBe(404);
    expect((await request(f.app).get(url).set('Authorization', `Bearer ${anotherSession.token}`)).status).toBe(404);
    expect((await request(f.app).get(url.replace(id, otherId)).set('Authorization', `Bearer ${s.token}`)).status).toBe(401);
    const ok = await request(f.app).get(url).set('Authorization', `Bearer ${s.token}`); expect(ok.status).toBe(200); expect(ok.headers['cache-control']).toBe('no-store'); expect(ok.headers['content-type']).toContain('application/zip');
  });
  it('revokes ready downloads on storage downgrade while realtime remains readable; regrant cannot restore old archives', async () => {
    const f = await fixture(network), s = await f.login(); await f.store([{ observedAt: 100, value: 1 }]);
    const job = await f.datasets.create(id, s.token, selection); await finished(f, s.token, job.requestId);
    await f.update({ storageDids: [] });
    expect((await f.sharing.read(id, s.token)).permissions).toMatchObject({ realtime: true, storage: false });
    await expect(f.datasets.download(id, s.token, job.requestId)).rejects.toMatchObject({ status: 403 });
    await f.update({ storageDids: [f.reader] });
    await expect(f.datasets.download(id, s.token, job.requestId)).rejects.toMatchObject({ status: 404 });
  });
  it('blocks pending preparation after revocation and never publishes its result', async () => {
    const f = await fixture(network), s = await f.login(); await f.store([{ observedAt: 100, value: 1 }]);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.storage.read.bind(f.storage); vi.spyOn(f.storage, 'read').mockImplementation(async uri => { await gate; return original(uri); });
    const job = await f.datasets.create(id, s.token, selection);
    await f.update({ storageDids: [] }); release(); await new Promise(resolve => setTimeout(resolve, 10));
    await f.update({ storageDids: [f.reader] });
    await expect(f.datasets.status(id, s.token, job.requestId)).rejects.toMatchObject({ status: 404 });
  });
  it('expires archives and blocks access after owner transfer', async () => {
    const f = await fixture(network), s = await f.login(); await f.store([{ observedAt: 100, value: 1 }]);
    const job = await f.datasets.create(id, s.token, selection); await finished(f, s.token, job.requestId);
    f.fields.owner_did = f.second;
    await expect(f.datasets.download(id, s.token, job.requestId)).rejects.toMatchObject({ status: 403 });
    f.fields.owner_did = f.owner; f.advance(DATASET_LIMITS.ttlMs + 1);
    await expect(f.datasets.download(id, s.token, job.requestId)).rejects.toMatchObject({ status: 404 });
  });
});
it('validates ranges, reports empty intervals, and allows cancellation', async () => {
  const f = await fixture(), s = await f.login();
  for (const input of [{}, { fromTimestamp: '100', toTimestamp: 200 }, { fromTimestamp: 200, toTimestamp: 100 }, { fromTimestamp: 0, toTimestamp: Date.now() }, { ...selection, uri: 's3://other/secret' }, { fromTimestamp: 0, toTimestamp: Date.now() + 1000 }]) await expect(f.datasets.create(id, s.token, input)).rejects.toMatchObject({ status: 422 });
  const job = await f.datasets.create(id, s.token, selection); expect((await finished(f, s.token, job.requestId)).error?.code).toBe('DATASET_EMPTY');
  await f.datasets.cancel(id, s.token, job.requestId); await expect(f.datasets.status(id, s.token, job.requestId)).rejects.toMatchObject({ status: 404 });
});
it('redacts provider failures and rejects foreign payloads or malformed timestamps', async () => {
  const f = await fixture(), s = await f.login(); await f.store([{ observedAt: 100, value: 1 }]);
  const spy = vi.spyOn(f.storage, 'read').mockRejectedValue(new Error('s3://secret-bucket password=TOPSECRET'));
  const failed = await f.datasets.create(id, s.token, selection); const result = await finished(f, s.token, failed.requestId);
  expect(result.error?.code).toBe('DATASET_PREPARATION_FAILED'); expect(JSON.stringify(result)).not.toMatch(/secret-bucket|TOPSECRET/);
  spy.mockResolvedValue(Buffer.from(JSON.stringify({ twinId: otherId, samples: [] })));
  const foreign = await f.datasets.create(id, s.token, selection); expect((await finished(f, s.token, foreign.requestId)).error?.code).toBe('DATASET_SOURCE_INVALID');
  spy.mockResolvedValue(Buffer.from(JSON.stringify({ twinId: id, samples: [{ observedAt: '100', value: 1 }] })));
  const malformed = await f.datasets.create(id, s.token, selection); expect((await finished(f, s.token, malformed.requestId)).error?.code).toBe('DATASET_SOURCE_INVALID');
});
it('bounds concurrent preparation and streamed bytes', async () => {
  const f = await fixture(), s = await f.login(); await f.store([{ observedAt: 100, value: 1 }]);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.storage, 'read').mockImplementation(async () => { await gate; return Readable.from([Buffer.alloc(DATASET_LIMITS.maxSourceBytes + 1)]); });
  const jobs = await Promise.all([f.datasets.create(id, s.token, selection), f.datasets.create(id, s.token, selection)]);
  await expect(f.datasets.create(id, s.token, selection)).rejects.toMatchObject({ status: 429 }); release();
  for (const job of jobs) expect((await finished(f, s.token, job.requestId)).error?.code).toBe('DATASET_SOURCE_LIMIT');
});
