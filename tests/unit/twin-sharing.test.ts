import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';
import { TwinSharing } from '../../src/sharing/service.js';
import { sharingRoutes } from '../../src/sharing/routes.js';
import { TwinRealtimeHub } from '../../src/realtime/hub.js';
import { errorBody } from '../../src/common/errors.js';

const dirs: string[] = [];
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(network = 'testnet') {
  const directory = await mkdtemp(join(tmpdir(), 'oid-sharing-')); dirs.push(directory);
  const id = '0x' + 'a'.repeat(64), packageId = '0x' + 'f'.repeat(64);
  const did = (c: string) => `did:iota:${network === 'mainnet' ? '' : network + ':'}0x${c.repeat(64)}`;
  const owner = did('1'), reader = did('2'), outsider = did('3');
  const key = Ed25519Keypair.generate();
  let failMutation = false, now = Date.now();
  const fields = { name: 'Solar QA', description: 'Synthetic energy', owner_did: owner, steward_did: did('4'), mutable_metadata: JSON.stringify({ other: 'preserved', objectid: { imageId: 'solar-demand', visibility: 'private', dataVisibility: 'private' } }) };
  const adapter: any = { getTwin: async () => ({ data: { type: `${packageId}::oid_twin::OIDTwin`, content: { fields } } }), updateTwin: async (_id: string, input: any) => { if (failMutation) throw new Error('chain unavailable'); fields.mutable_metadata = input.mutableMetadata; return { digest: 'qa-digest' }; } };
  const options = { network, directory, packageId, publicUrl: 'https://is.example/' + network, rpcUrl: 'https://rpc.example', credentials: { get: async () => packageId } as any, objectid: adapter, verifyController: async (did: string, address: string) => did === reader && address === key.toIotaAddress(), now: () => now };
  const service = new TwinSharing(options);
  const input = { mode: 'restricted', allowedDids: [reader], visibility: 'private', liveLocationVisibility: 'private', revision: null as string | null };
  async function grant() { return service.update(id, owner, input); }
  async function login() { const c = await service.challenge(id, reader); const s = await key.signPersonalMessage(new TextEncoder().encode(c.message)); return { ...await service.verify(id, { did: reader, challengeId: c.challengeId, signature: s.signature }), challenge: c, signature: s.signature }; }
  return { id, owner, reader, outsider, fields, service, options, input, grant, login, key, failMutation: () => { failMutation = true; }, advance: (n: number) => { now += n; } };
}
describe.each(['testnet', 'mainnet'])('restricted sharing on %s', network => {
  it('persists a private DID list and preserves metadata; admits only a signed authorized DID', async () => {
    const f = await fixture(network); await f.grant();
    expect(JSON.parse(f.fields.mutable_metadata).objectid.allowedDids).toBeUndefined();
    expect(JSON.parse(f.fields.mutable_metadata).other).toBe('preserved');
    const p = await f.service.policy(f.id, f.owner); expect(p.allowedDids).toEqual([f.reader]);
    const restored = new TwinSharing(f.options); expect((await restored.policy(f.id, f.owner)).allowedDids).toEqual([f.reader]);
    await expect(f.service.challenge(f.id, f.outsider)).rejects.toMatchObject({ status: 403 });
    const session = await f.login(); expect((await f.service.read(f.id, session.token)).did).toBe(f.reader);
    expect(session.challenge.message).toContain(`Server: https://is.example/${network}`);
    expect(await f.service.blocksPublic(f.id)).toBe(true);
    const bytes = await readFile(join(f.options.directory, `${f.id}.json`), 'utf8'); expect(bytes).not.toContain(session.token);
  });
  it('rejects wrong network DIDs, non-owner updates and stale revisions', async () => {
    const f = await fixture(network);
    await expect(f.service.update(f.id, f.outsider, f.input)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.policy(f.id, f.fields.steward_did)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.update(f.id, f.fields.steward_did, f.input)).rejects.toMatchObject({ status: 403 });
    const wrong = network === 'mainnet' ? f.reader.replace('did:iota:', 'did:iota:testnet:') : f.reader.replace(':testnet:', ':');
    await expect(f.service.update(f.id, f.owner, { ...f.input, allowedDids: [wrong] })).rejects.toMatchObject({ status: 422 });
    await f.grant(); await expect(f.grant()).rejects.toMatchObject({ status: 409 });
  });
  it('rejects forged signatures, replay, expired challenges and cross-Twin tokens', async () => {
    const f = await fixture(network); await f.grant();
    const c = await f.service.challenge(f.id, f.reader);
    const signed = await Ed25519Keypair.generate().signPersonalMessage(new TextEncoder().encode(c.message));
    await expect(f.service.verify(f.id, { did: f.reader, challengeId: c.challengeId, signature: signed.signature })).rejects.toMatchObject({ status: 403 });
    const s = await f.login();
    await expect(f.service.verify(f.id, { did: f.reader, challengeId: s.challenge.challengeId, signature: s.signature })).rejects.toMatchObject({ status: 401 });
    await expect(f.service.read('0x' + 'b'.repeat(64), s.token)).rejects.toMatchObject({ status: 401 });
    const exp = await f.service.challenge(f.id, f.reader); f.advance(121000);
    await expect(f.service.verify(f.id, { did: f.reader, challengeId: exp.challengeId, signature: s.signature })).rejects.toMatchObject({ status: 401 });
    f.advance(1800000); await expect(f.service.read(f.id, s.token)).rejects.toMatchObject({ status: 401 });
  });
  it('revokes existing sessions when a DID is removed or ownership changes', async () => {
    const f = await fixture(network); const grant = await f.grant(); const s = await f.login();
    await f.service.update(f.id, f.owner, { ...f.input, mode: 'private', allowedDids: [], revision: grant.revision });
    await expect(f.service.read(f.id, s.token)).rejects.toMatchObject({ status: 403 });
    const g = await fixture(network); await g.grant(); const gs = await g.login(); g.fields.owner_did = g.outsider;
    await expect(g.service.read(g.id, gs.token)).rejects.toMatchObject({ status: 403 });
  });
  it('fails closed on transaction failure while allowing independent public location otherwise', async () => {
    const f = await fixture(network); await f.grant(); const s = await f.login();
    expect(await f.service.blocksPublic(f.id, 'location')).toBe(false);
    const p = await f.service.policy(f.id, f.owner); f.failMutation();
    await expect(f.service.update(f.id, f.owner, { ...f.input, revision: p.revision })).rejects.toThrow('chain unavailable');
    expect(await f.service.blocksPublic(f.id, 'location')).toBe(true);
    await expect(f.service.read(f.id, s.token)).rejects.toMatchObject({ status: 403 });
  });
});
it('exposes only read routes and sanitized Twin identity to the reader', async () => {
  const f = await fixture(); await f.grant(); const s = await f.login();
  const app = express(); app.use(express.json()); app.use('/shared', sharingRoutes(f.service, new TwinRealtimeHub()));
  app.use((e: unknown, _q: any, r: any, _next: any) => { const mapped = errorBody(e); r.status(mapped.status).json(mapped.body); });
  expect((await request(app).get(`/shared/${f.id}/dashboard`)).status).toBe(401);
  const result = await request(app).get(`/shared/${f.id}/dashboard`).set('Authorization', `Bearer ${s.token}`);
  expect(result.status).toBe(200); expect(result.body.imageId).toBe('solar-demand');
  expect(result.body.allowedDids).toBeUndefined(); expect(result.body.owner_did).toBeUndefined();
  expect((await request(app).post(`/shared/${f.id}/commands`).set('Authorization', `Bearer ${s.token}`).send({})).status).toBe(404);
  expect((await request(app).patch(`/shared/${f.id}/dashboard`).set('Authorization', `Bearer ${s.token}`).send({ name: 'tampered' })).status).toBe(404);
});
