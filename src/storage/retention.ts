import { logger } from "../common/logger.js";
import type { ObjectIdAdapter } from "../objectid/types.js";
import type { RetentionConfig } from "./types.js";
import type { StorageRouter } from "./storage-router.js";

const DAY_MS = 86_400_000;

export interface RetentionPolicyResolver {
  retentionDays(ownerDid: string, twinId: string): Promise<number | null>;
}

export class ConfigRetentionPolicyResolver implements RetentionPolicyResolver {
  private readonly policies: Map<string, number | null>;
  constructor(private readonly config: RetentionConfig) { this.policies = new Map(config.ownerPolicies.map((item) => [item.ownerDid.toLowerCase(), item.retentionDays])); }
  async retentionDays(ownerDid: string) { const key = ownerDid.toLowerCase(); return this.policies.has(key) ? this.policies.get(key)! : this.config.defaultDays; }
}

export interface RetentionRunResult {
  startedAt: string;
  completedAt: string;
  scanned: number;
  eligible: number;
  deleted: number;
  skippedUnresolved: number;
  failed: number;
  capped: boolean;
  onChainStates: OnChainStateRetentionResult;
}

export interface OnChainStateRetentionResult {
  enabled: boolean;
  twinsScanned: number;
  statesScanned: number;
  eligible: number;
  pruned: number;
  skippedUnanchored: number;
  failed: number;
  capped: boolean;
}

export class StorageRetentionService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<RetentionRunResult>;
  private lastRun?: RetentionRunResult;

  constructor(
    private readonly config: RetentionConfig,
    private readonly storage: StorageRouter,
    private readonly objectid: ObjectIdAdapter,
    private readonly policies: RetentionPolicyResolver = new ConfigRetentionPolicyResolver(config),
    private readonly now = () => Date.now(),
  ) {}

  start() {
    if (!this.config.enabled || this.timer) return;
    this.timer = setTimeout(() => void this.run().finally(() => this.scheduleNext()), this.config.startupDelayMs);
    this.timer.unref();
  }

  async stop() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; await this.running; }
  status() { return { enabled: this.config.enabled, defaultDays: this.config.defaultDays, intervalMs: this.config.intervalMs, running: Boolean(this.running), lastRun: this.lastRun ?? null }; }

  run() {
    if (!this.running) this.running = this.execute().finally(() => { this.running = undefined; });
    return this.running;
  }

  private scheduleNext() {
    if (!this.config.enabled || this.timer === undefined) return;
    this.timer = setTimeout(() => void this.run().finally(() => this.scheduleNext()), this.config.intervalMs);
    this.timer.unref();
  }

  private async execute(): Promise<RetentionRunResult> {
    const startedAt = new Date(this.now()).toISOString();
    const objects = await this.storage.listManagedObjects();
    const owners = new Map<string, string | null>();
    let eligible = 0, deleted = 0, skippedUnresolved = 0, failed = 0;
    for (const object of objects.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (object.category === "plants" || object.twinId === "unscoped") continue;
      if (!owners.has(object.twinId)) owners.set(object.twinId, await this.ownerDid(object.twinId));
      const ownerDid = owners.get(object.twinId);
      if (!ownerDid) { skippedUnresolved += 1; continue; }
      const days = await this.policies.retentionDays(ownerDid, object.twinId);
      if (days === null || new Date(object.createdAt).getTime() > this.now() - days * DAY_MS) continue;
      eligible += 1;
      if (deleted >= this.config.maxDeletesPerRun) continue;
      try { await this.storage.delete(object.uri); deleted += 1; }
      catch (error) { failed += 1; logger.error({ uri: object.uri, twinId: object.twinId, error }, "storage_retention_delete_failed"); }
    }
    const onChainStates = await this.pruneOnChainStates();
    const result = { startedAt, completedAt: new Date(this.now()).toISOString(), scanned: objects.length, eligible, deleted, skippedUnresolved, failed, capped: eligible > deleted + failed, onChainStates };
    this.lastRun = result;
    logger.info(result, "storage_retention_run_completed");
    return result;
  }

  private async pruneOnChainStates(): Promise<OnChainStateRetentionResult> {
    const result: OnChainStateRetentionResult = {
      enabled: this.config.onChainStates.enabled,
      twinsScanned: 0, statesScanned: 0, eligible: 0, pruned: 0,
      skippedUnanchored: 0, failed: 0, capped: false,
    };
    if (!result.enabled) return result;
    if (!this.objectid.listTwinIdsForRetention || !this.objectid.getTwinStateRetentionSnapshot || !this.objectid.pruneState) {
      logger.warn("onchain_state_retention_unavailable");
      return result;
    }

    const cutoff = this.now() - this.config.onChainStates.retentionDays * DAY_MS;
    let twinIds: string[];
    try {
      twinIds = await this.objectid.listTwinIdsForRetention();
    } catch (error) {
      result.failed += 1;
      logger.error({ error }, "onchain_state_retention_discovery_failed");
      return result;
    }
    for (const twinId of twinIds) {
      let snapshot;
      try {
        snapshot = await this.objectid.getTwinStateRetentionSnapshot(twinId);
        result.twinsScanned += 1;
      } catch (error) {
        result.failed += 1;
        logger.error({ twinId, error }, "onchain_state_retention_scan_failed");
        continue;
      }
      result.statesScanned += snapshot.states.length;
      const newestByStream = new Map<string, string>();
      for (const state of [...snapshot.states].sort(compareStatesNewestFirst)) {
        const stream = `${state.aspectCode}\u0000${state.sampleType}`;
        if (!newestByStream.has(stream)) newestByStream.set(stream, state.objectId.toLowerCase());
      }
      const publications = new Map(snapshot.events
        .filter((event) => event.eventType === 30 && event.payloadRef)
        .map((event) => [event.payloadRef.toLowerCase(), event]));

      for (const state of [...snapshot.states].sort(compareStatesOldestFirst)) {
        const stream = `${state.aspectCode}\u0000${state.sampleType}`;
        if (newestByStream.get(stream) === state.objectId.toLowerCase()) continue;
        const publication = publications.get(state.objectId.toLowerCase());
        if (!publication || publication.createdAt > cutoff) continue;
        if (!canCreateVerificationReceipt(state.payloadHash, publication.payloadHash)) {
          result.skippedUnanchored += 1;
          continue;
        }
        result.eligible += 1;
        if (result.pruned >= this.config.onChainStates.maxPrunesPerRun) {
          result.capped = true;
          continue;
        }
        try {
          await this.objectid.pruneState(twinId, state.objectId);
          result.pruned += 1;
        } catch (error) {
          result.failed += 1;
          logger.error({ twinId, stateId: state.objectId, error }, "onchain_state_retention_prune_failed");
        }
      }
    }
    return result;
  }

  private async ownerDid(twinId: string) {
    try {
      const twin: any = await this.objectid.getTwin(twinId);
      const fields = twin?.data?.content?.fields ?? twin?.content?.fields ?? twin?.fields ?? twin ?? {};
      const value = fields.owner_did ?? fields.ownerDid;
      return value ? String(value) : null;
    } catch (error) {
      logger.warn({ twinId, error }, "storage_retention_owner_unresolved");
      return null;
    }
  }
}

function compareStatesNewestFirst(a: { observedAt: number; objectId: string }, b: { observedAt: number; objectId: string }) {
  return b.observedAt - a.observedAt || b.objectId.localeCompare(a.objectId);
}

function compareStatesOldestFirst(a: { observedAt: number; objectId: string }, b: { observedAt: number; objectId: string }) {
  return a.observedAt - b.observedAt || a.objectId.localeCompare(b.objectId);
}

function canCreateVerificationReceipt(stateHash: string, publicationHash: string) {
  const stateDigest = hashDigest(stateHash);
  if (!stateDigest) return false;
  // Legacy publish_state events stored no hash. The upgraded atomic prune call
  // reads it from the state and writes EVENT_STATE_PRUNED before deletion.
  if (!publicationHash) return true;
  if (!/^(sha256:|0x)[0-9a-f]{64}$/.test(publicationHash.toLowerCase())) return false;
  return stateDigest === hashDigest(publicationHash);
}

function hashDigest(value: string) {
  const normalized = value.toLowerCase().replace(/^(sha256:|0x)/, "");
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}
