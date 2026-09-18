import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { twinManagementAuth } from '../../src/sharing/management-auth.js';
import { normalizePolicy, policyRights, permissionSummary } from '../../src/sharing/policy.js';

const id = '0x' + 'a'.repeat(64), other = '0x' + 'b'.repeat(64);
for (const network of ['testnet', 'mainnet']) describe(`${network} Twin administration`, () => {
  const did = (n: string) => `did:iota:${network === 'mainnet' ? '' : 'testnet:'}0x${n.repeat(64)}`;
  const grant = { did: did('2'), scopes: 63, validFrom: 100, expiresAt: 200, historyFrom: 0, historyTo: 0, allMeasurements: true, measurements: [] };
  const policy = normalizePolicy({ mode: 'restricted', publicScopes: 0, readers: [grant] }, network, did('1'));
  it('Admin is explicit and time-bounded; all read scopes alone never give control', () => {
    expect(policyRights(policy, did('2'), 99).admin).toBe(false);
    expect(permissionSummary(policyRights(policy, did('2'), 100))).toEqual({ realtime: true, history: true, storage: true, export: true, location: true, evidence: true, admin: true });
    expect(policyRights(policy, did('2'), 200).admin).toBe(false);
    expect(policyRights({ ...policy, readers: [{ ...grant, scopes: 31 }] }, did('2'), 150).admin).toBe(false);
    expect(() => normalizePolicy({ ...policy, readers: [{ ...grant, historyFrom: 50 }] }, network, did('1'))).toThrow(/Admin requires/);
    expect(() => normalizePolicy({ ...policy, readers: [{ ...grant, scopes: 32 }] }, network, did('1'))).toThrow(/Admin requires/);
    expect(() => normalizePolicy({ ...policy, publicScopes: 32 }, network, did('1'))).toThrow();
  });
  it('authenticates an Admin only on the granted Twin and retains its existing accounting', async () => {
    let now = 150; let current = policy;
    const app = express();
    const accounting = { subscriptionId: 'old-subscription', tenantId: 'old-tenant', ownerDid: did('1'), customerId: 'old-customer' };
    const sharing = { read: async (twinId: string, token: string) => {
      if (twinId !== id || token !== 'signed-session') throw Object.assign(new Error('Invalid session'), { status: 401 });
      const rights = policyRights(current, did('2'), now);
      return { fields: { subscription_id: accounting.subscriptionId }, did: did('2'), rights, expiresAt: 200, revision: '1', permissions: permissionSummary(rights) };
    } };
    app.use(twinManagementAuth({ authenticate: async () => { throw Object.assign(new Error('API key required'), { status: 401 }); } }, sharing, { findBySubscriptionId: async sid => sid === accounting.subscriptionId ? accounting : undefined }));
    app.use((q, r) => r.json(q.auth));
    app.use((e: any, _q: any, r: any, _n: any) => r.status(e.status || 500).json({ error: e.message }));
    const get = (path: string, token = 'signed-session') => request(app).get(path).set('x-objectid-twin-session', token).set('x-objectid-caller-did', did('9'));
    const authorized = await get(`/twins/${id}`);
    expect(authorized.status).toBe(200); expect(authorized.body.subject).toBe(did('2')); expect(authorized.body.accounting).toEqual(accounting);
    expect((await get(`/twins/${other}`)).status).toBe(401);
    expect((await get('/subscription')).status).toBe(403);
    expect((await get('/files')).status).toBe(403);
    expect((await get(`/twins/${id}`, 'guessed')).status).toBe(401);
    now = 200; expect((await get(`/twins/${id}`)).status).toBe(403);
    now = 150; current = { ...policy, readers: [] }; expect((await get(`/twins/${id}`)).status).toBe(403);
  });
});
