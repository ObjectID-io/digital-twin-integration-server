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
    const result = { startedAt, completedAt: new Date(this.now()).toISOString(), scanned: objects.length, eligible, deleted, skippedUnresolved, failed, capped: eligible > deleted + failed };
    this.lastRun = result;
    logger.info(result, "storage_retention_run_completed");
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
