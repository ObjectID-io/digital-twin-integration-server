import { randomUUID } from "node:crypto";
import { AppError } from "../common/errors.js";
import { logger } from "../common/logger.js";
import { datasetsCreated, queueDepth, queueJobs, queueJobsFailed, queueRetries } from "../health/metrics.js";
import type { AccountingContext, ObjectIdAdapter } from "../objectid/types.js";
import type { QueueItem, QueueProvider } from "./memoryQueue.js";

export type IngestionJobType = "PUBLISH_STATE" | "ADD_DATASET" | "EMIT_EVENT";

export interface IngestionJob {
  id: string;
  idempotencyKey: string;
  type: IngestionJobType;
  twinId: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: number;
  accounting?: AccountingContext;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  pollIntervalMs: number;
}

export class IngestionWorker {
  readonly failedJobs: Array<{ job: IngestionJob; error: AppError }> = [];
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    private readonly queue: QueueProvider<IngestionJob>,
    private readonly objectid: ObjectIdAdapter,
    private readonly options: RetryOptions,
  ) {}

  createJob(type: IngestionJobType, twinId: string, payload: Record<string, unknown>, idempotencyKey: string = randomUUID(), accounting?: AccountingContext): IngestionJob {
    return { id: randomUUID(), idempotencyKey, type, twinId, payload, attempts: 0, createdAt: Date.now(), accounting };
  }

  async enqueue(job: IngestionJob) {
    await this.queue.enqueue({ id: job.id, payload: job, attempts: job.attempts, createdAt: job.createdAt });
    queueJobs.inc({ type: job.type });
    queueDepth.set(this.queue.size());
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.processNext(), this.options.pollIntervalMs);
    this.timer.unref();
  }

  async processNext() {
    if (this.processing) return false;
    const item = await this.queue.dequeue();
    queueDepth.set(this.queue.size());
    if (!item) return false;
    this.processing = true;
    try { await this.execute(item.payload); }
    catch (error) { await this.handleFailure(item, normalizeError(error)); }
    finally { this.processing = false; }
    return true;
  }

  async drain(maxWaitMs = 5_000) {
    const deadline = Date.now() + maxWaitMs;
    while ((this.queue.size() > 0 || this.processing) && Date.now() < deadline) {
      if (!this.processing) { const processed = await this.processNext(); if (!processed) await delay(this.options.pollIntervalMs); }
      else await delay(5);
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.drain();
  }

  private async execute(job: IngestionJob) {
    const payload = { ...job.payload, externalReference: job.idempotencyKey };
    if (job.type === "PUBLISH_STATE") await this.objectid.publishState(job.twinId, payload, job.accounting);
    else if (job.type === "ADD_DATASET") { await this.objectid.addDataset(job.twinId, payload, job.accounting); datasetsCreated.inc(); }
    else await this.objectid.emitTwinEvent(job.twinId, payload, job.accounting);
  }

  private async handleFailure(item: QueueItem<IngestionJob>, error: AppError) {
    const job = item.payload;
    const retryable = error.details.retryable === true;
    const nextAttempt = job.attempts + 1;
    if (!retryable || nextAttempt >= this.options.maxAttempts) return this.fail(job, error);

    if (error.details.submissionUnknown === true) {
      const existing = await this.objectid.findMutationByIdempotencyKey(job.twinId, job.idempotencyKey);
      if (existing === true) return;
      if (existing === undefined) {
        return this.fail(job, new AppError(
          "OBJECTID_RETRY_SAFETY_UNAVAILABLE",
          "Mutation outcome is unknown and the configured ObjectID provider cannot verify its idempotency reference",
          503,
          "OBJECTID",
        ));
      }
    }

    const retry = { ...job, attempts: nextAttempt };
    const exponential = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** (nextAttempt - 1));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.2)));
    await this.queue.enqueue({ ...item, attempts: nextAttempt, payload: retry, availableAt: Date.now() + exponential + jitter });
    queueRetries.inc({ type: job.type });
    queueDepth.set(this.queue.size());
  }

  private fail(job: IngestionJob, error: AppError) {
    this.failedJobs.push({ job, error });
    queueJobsFailed.inc({ type: job.type, reason: error.code });
    logger.error({ jobId: job.id, type: job.type, code: error.code, error: error.message, details: error.details }, "ingestion_job_failed");
  }
}

function normalizeError(error: unknown) {
  return error instanceof AppError ? error : new AppError("INGESTION_FAILED", error instanceof Error ? error.message : String(error));
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
