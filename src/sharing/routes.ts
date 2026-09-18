import express from 'express';
import rateLimit from 'express-rate-limit';
import type { TwinSharing } from './service.js';
import type { TwinRealtimeHub, TwinRealtimeEvent } from '../realtime/hub.js';
import type { SharedDatasets } from './datasets.js';

export function sharingRoutes(sharing: TwinSharing, realtime: TwinRealtimeHub, datasets?: SharedDatasets) {
  const router = express.Router();
  router.use((_q, r, next) => { r.set('Cache-Control', 'no-store'); next(); });
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  router.post('/:id/challenge', limiter, async (q, r) => { r.json(await sharing.challenge(String(q.params.id), q.body?.did)); });
  router.post('/:id/verify', limiter, async (q, r) => { r.json(await sharing.verify(String(q.params.id), q.body)); });
  router.use('/:id', async (q, r, next) => {
    const token = /^Bearer (\S+)$/.exec(q.header('authorization') ?? '')?.[1] ?? '';
    r.locals.sharing = await sharing.read(String(q.params.id), token); r.locals.token = token; next();
  });
  router.get('/:id/dashboard', (q, r) => {
    const f = r.locals.sharing.fields; let m: any = {}; try { m = JSON.parse(f.mutable_metadata || '{}'); } catch { /* validated in service */ }
    r.json({ twinId: q.params.id, name: String(f.name ?? ''), description: String(f.description ?? ''), imageId: m?.objectid?.imageId ?? 'cnc-5-axis', network: sharing.options.network, access: 'restricted', did: r.locals.sharing.did, permissions: r.locals.sharing.permissions });
  });
  router.get('/:id/location/latest', async (q, r) => {
    const id = String(q.params.id); await sharing.read(id, r.locals.token, 'location');
    r.json({ twinId: id, position: realtime.latest(id)?.position ?? null });
  });
  if (datasets) {
    router.get('/:id/datasets/context', limiter, async (q, r) => { r.json(await datasets.context(String(q.params.id), r.locals.token)); });
    router.post('/:id/history/query', limiter, async (q, r) => { r.json(await datasets.history(String(q.params.id), r.locals.token, q.body)); });
    router.post('/:id/datasets', limiter, async (q, r) => {
      const job = await datasets.create(String(q.params.id), r.locals.token, q.body);
      r.status(202).set({ Location: job.statusUrl, 'Retry-After': '2' }).json(job);
    });
    router.get('/:id/datasets/:requestId', limiter, async (q, r) => { r.json(await datasets.status(String(q.params.id), r.locals.token, String(q.params.requestId))); });
    router.delete('/:id/datasets/:requestId', limiter, async (q, r) => { await datasets.cancel(String(q.params.id), r.locals.token, String(q.params.requestId)); r.status(204).end(); });
    router.get('/:id/datasets/:requestId/download', limiter, async (q, r) => {
      const archive = await datasets.download(String(q.params.id), r.locals.token, String(q.params.requestId));
      r.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${archive.filename}"`, 'X-Content-Type-Options': 'nosniff', 'X-Dataset-SHA256': archive.sha256 }).send(archive.bytes);
    });
  }
  router.get('/:id/realtime/latest', async (q, r) => { const id = String(q.params.id); r.json(await sharing.filteredRealtime(id, r.locals.token, realtime.latest(id))); });
  router.get('/:id/realtime/stream', (q, r) => {
    const id = String(q.params.id), token = r.locals.token;
    r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); r.flushHeaders();
    let closed = false, unsubscribe = () => {};
    const close = () => { if (closed) return; closed = true; clearInterval(timer); unsubscribe(); sharing.changes.off(id, revoke); r.end(); };
    const revoke = () => { if (!closed) r.write('event: revoked\ndata: {}\n\n'); close(); };
    let sending = false, nextEvent: TwinRealtimeEvent | undefined;
    const send = async (event?: TwinRealtimeEvent) => {
      if (closed) return;
      if (sending) { if (event) nextEvent = event; return; }
      sending = true;
      try { const filtered = event ? await sharing.filteredRealtime(id, token, event) : null; if (!event) await sharing.read(id, token, 'realtime'); if (!closed) r.write(event ? `event: telemetry\ndata: ${JSON.stringify(filtered)}\n\n` : ': heartbeat\n\n'); }
      catch { revoke(); }
      finally { sending = false; if (nextEvent && !closed) { const next = nextEvent; nextEvent = undefined; void send(next); } }
    };
    // Register revocation before the first asynchronous read, so updates cannot race a send.
    sharing.changes.on(id, revoke);
    unsubscribe = realtime.subscribe(id, event => { void send(event); });
    const timer = setInterval(() => { void send(); }, 5000);
    r.on('close', close);
    const latest = realtime.latest(id); if (latest) void send(latest);
  });
  return router;
}
