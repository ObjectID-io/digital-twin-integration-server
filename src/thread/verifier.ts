import { createHash, type Hash } from "node:crypto";
import canonicalize from "canonicalize";
import type { PaginationOptions } from "../indexer/types.js";
import type { TwinEvent } from "../objectid/types.js";

export const DIGITAL_THREAD_VERIFIER_VERSION = "1.1.0";
export const AUDIT_REPORT_FORMAT_VERSION = "1.0";
export const VALID_TWIN_EVENT_TYPES = new Set([
  1, 2, 3, 10, 20, 21, 22, 30, 31, 40, 41, 42, 45, 46, 50, 51, 52,
  60, 61, 62, 70, 71, 72, 80, 81, 82, 100, 101, 102, 103, 104, 110,
  120, 121, 130, 140, 150, 151, 152, 153, 154, 160, 161, 162, 163, 164,
  170, 171, 172, 180, 181,
]);

export type VerificationStatus = "VERIFIED" | "PARTIAL" | "FAILED" | "NOT_VERIFIED";
export interface ThreadVerification {
  valid: boolean | null;
  complete: boolean;
  reason?: string;
  scope: { type: "FULL_THREAD" | "REVISION_RANGE"; fromRevision?: number; toRevision?: number };
  twinId: string;
  pagesVerified: number;
  firstRevision: number;
  lastRevision: number;
  fromRevision: number;
  toRevision: number;
  eventCount: number;
  missingRevisions: number[];
  duplicateRevisions: number[];
  invalidEvents: Array<{ eventId: string; errors: string[] }>;
  hashErrors: Array<{ eventId: string; error: string }>;
  transactionErrors: Array<{ eventId: string; digest?: string; error: string }>;
  transactionVerification: { status: VerificationStatus; verified: number; failed: number; notVerified: number };
  eventEvidenceDigest: string;
  gaps: Array<{ expectedRevision: number; foundRevision: number }>;
  errors: string[];
}

export class IncrementalThreadVerifier {
  private readonly result: Omit<ThreadVerification, "valid" | "complete" | "reason" | "eventEvidenceDigest">;
  private readonly seen = new Set<number>();
  private readonly digest: Hash = createHash("sha256");
  private previous?: TwinEvent;

  constructor(private readonly twinId: string, private readonly options: PaginationOptions = {}) {
    this.result = {
      scope: options.fromRevision !== undefined || options.toRevision !== undefined
        ? { type: "REVISION_RANGE", fromRevision: options.fromRevision, toRevision: options.toRevision }
        : { type: "FULL_THREAD" },
      twinId, pagesVerified: 0, firstRevision: 0, lastRevision: 0,
      fromRevision: options.fromRevision ?? 0, toRevision: options.toRevision ?? 0, eventCount: 0,
      missingRevisions: [], duplicateRevisions: [], invalidEvents: [], hashErrors: [], transactionErrors: [],
      transactionVerification: { status: "NOT_VERIFIED", verified: 0, failed: 0, notVerified: 0 },
      gaps: [], errors: [],
    };
  }

  async appendPage(events: TwinEvent[], transactionExists?: (digest: string) => Promise<boolean | undefined>) {
    this.result.pagesVerified += 1;
    for (const event of events) {
      const eventErrors: string[] = [];
      const expectedBefore = this.previous?.revisionAfter ?? (this.options.fromRevision !== undefined ? this.options.fromRevision - 1 : 0);
      if (this.previous && compareEvents(this.previous, event) > 0) eventErrors.push("event is out of order");
      if (normalize(event.twinId) !== normalize(this.twinId)) eventErrors.push("event belongs to another Twin");
      if (!VALID_TWIN_EVENT_TYPES.has(event.eventType)) eventErrors.push(`unknown event type ${event.eventType}`);
      if (!event.actorDid) eventErrors.push("actor is missing");
      if (event.revisionAfter !== event.revisionBefore + 1) eventErrors.push("invalid revision transition");
      if (this.seen.has(event.revisionAfter)) this.result.duplicateRevisions.push(event.revisionAfter);
      this.seen.add(event.revisionAfter);
      if (event.revisionBefore !== expectedBefore) {
        this.result.gaps.push({ expectedRevision: expectedBefore, foundRevision: event.revisionBefore });
        if (event.revisionBefore > expectedBefore) this.result.missingRevisions.push(...range(expectedBefore + 1, event.revisionBefore + 1));
      }
      if (event.payloadHash && !isValidHash(event.payloadHash)) this.result.hashErrors.push({ eventId: event.eventId, error: "payloadHash must be sha256:<64 lowercase hex> or 0x<64 hex>" });
      if ([30, 70, 80, 160, 162].includes(event.eventType) && !event.payloadRef && !event.payloadHash) eventErrors.push("payload reference or hash is required");
      if (eventErrors.length) this.result.invalidEvents.push({ eventId: event.eventId, errors: eventErrors });
      await this.verifyTransaction(event, transactionExists);
      this.digest.update(eventEvidenceHash(event));
      this.result.eventCount += 1;
      this.result.firstRevision ||= event.revisionAfter;
      this.result.lastRevision = event.revisionAfter;
      this.previous = event;
    }
  }

  finish(complete: boolean, reason?: string): ThreadVerification {
    if (complete && this.options.toRevision !== undefined && this.result.lastRevision < this.options.toRevision) {
      this.result.missingRevisions.push(...range(this.result.lastRevision + 1, this.options.toRevision + 1));
    }
    this.result.duplicateRevisions = [...new Set(this.result.duplicateRevisions)];
    this.result.missingRevisions = [...new Set(this.result.missingRevisions)];
    this.result.transactionVerification.status = transactionStatus(this.result.transactionVerification);
    this.result.errors = [
      ...this.result.invalidEvents.flatMap((item) => item.errors.map((error) => `${item.eventId}: ${error}`)),
      ...this.result.hashErrors.map((item) => `${item.eventId}: ${item.error}`),
      ...this.result.transactionErrors.map((item) => `${item.eventId}: ${item.error}`),
    ];
    const invalid = this.result.errors.length > 0 || this.result.gaps.length > 0 || this.result.duplicateRevisions.length > 0 || this.result.missingRevisions.length > 0;
    return {
      ...this.result, complete, reason: complete ? undefined : reason ?? "Indexer/provider cannot enumerate the complete requested range",
      valid: complete ? !invalid : null, fromRevision: this.options.fromRevision ?? (this.result.firstRevision ? this.result.firstRevision - 1 : 0),
      toRevision: this.options.toRevision ?? this.result.lastRevision,
      eventEvidenceDigest: `sha256:${this.digest.digest("hex")}`,
    };
  }

  private async verifyTransaction(event: TwinEvent, exists?: (digest: string) => Promise<boolean | undefined>) {
    if (!event.transactionDigest || !exists) { this.result.transactionVerification.notVerified += 1; return; }
    let present: boolean | undefined;
    try { present = await exists(event.transactionDigest); } catch { present = undefined; }
    if (present === true) this.result.transactionVerification.verified += 1;
    else if (present === false) {
      this.result.transactionVerification.failed += 1;
      this.result.transactionErrors.push({ eventId: event.eventId, digest: event.transactionDigest, error: "transaction was not found" });
    } else this.result.transactionVerification.notVerified += 1;
  }
}

export function verifyEvents(twinId: string, events: TwinEvent[]): ThreadVerification {
  return verifyEventsSynchronously(twinId, events);
}

function verifyEventsSynchronously(twinId: string, events: TwinEvent[]) {
  const result = basicResult(twinId);
  let previous: TwinEvent | undefined;
  const seen = new Set<number>();
  const digest = createHash("sha256");
  for (const event of events) {
    const errors: string[] = [];
    const expected = previous?.revisionAfter ?? 0;
    if (previous && compareEvents(previous, event) > 0) errors.push("event is out of order");
    if (normalize(event.twinId) !== normalize(twinId)) errors.push("event belongs to another Twin");
    if (!VALID_TWIN_EVENT_TYPES.has(event.eventType)) errors.push(`unknown event type ${event.eventType}`);
    if (!event.actorDid) errors.push("actor is missing");
    if (event.revisionAfter !== event.revisionBefore + 1) errors.push("invalid revision transition");
    if (seen.has(event.revisionAfter)) result.duplicateRevisions.push(event.revisionAfter);
    seen.add(event.revisionAfter);
    if (event.revisionBefore !== expected) {
      result.gaps.push({ expectedRevision: expected, foundRevision: event.revisionBefore });
      if (event.revisionBefore > expected) result.missingRevisions.push(...range(expected + 1, event.revisionBefore + 1));
    }
    if (event.payloadHash && !isValidHash(event.payloadHash)) result.hashErrors.push({ eventId: event.eventId, error: "payloadHash must be sha256:<64 lowercase hex> or 0x<64 hex>" });
    if ([30, 70, 80, 160, 162].includes(event.eventType) && !event.payloadRef && !event.payloadHash) errors.push("payload reference or hash is required");
    if (errors.length) result.invalidEvents.push({ eventId: event.eventId, errors });
    result.transactionVerification.notVerified += 1; digest.update(eventEvidenceHash(event)); result.eventCount += 1;
    result.firstRevision ||= event.revisionAfter; result.lastRevision = event.revisionAfter; previous = event;
  }
  result.fromRevision = result.firstRevision ? result.firstRevision - 1 : 0; result.toRevision = result.lastRevision;
  result.transactionVerification.status = "NOT_VERIFIED";
  result.errors = [...result.invalidEvents.flatMap((item) => item.errors), ...result.hashErrors.map((item) => item.error)];
  result.valid = result.errors.length === 0 && result.gaps.length === 0 && result.duplicateRevisions.length === 0;
  result.eventEvidenceDigest = `sha256:${digest.digest("hex")}`;
  return result;
}

function basicResult(twinId: string): ThreadVerification {
  return { valid: true, complete: true, scope: { type: "FULL_THREAD" }, twinId, pagesVerified: 1, firstRevision: 0, lastRevision: 0, fromRevision: 0, toRevision: 0, eventCount: 0, missingRevisions: [], duplicateRevisions: [], invalidEvents: [], hashErrors: [], transactionErrors: [], transactionVerification: { status: "NOT_VERIFIED", verified: 0, failed: 0, notVerified: 0 }, eventEvidenceDigest: "", gaps: [], errors: [] };
}

export function canonicalEvent(event: TwinEvent) {
  return {
    eventId: event.eventId, twinId: event.twinId, eventType: event.eventType,
    revisionBefore: event.revisionBefore, revisionAfter: event.revisionAfter,
    actorDid: event.actorDid, payloadRef: event.payloadRef, payloadHash: event.payloadHash, createdAt: event.createdAt,
  };
}

export function canonicalHash(value: unknown) {
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new TypeError("Value cannot be represented by RFC 8785 JCS");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function eventEvidenceHash(event: TwinEvent) { return canonicalHash(canonicalEvent(event)); }
function transactionStatus(value: { verified: number; failed: number; notVerified: number }): VerificationStatus {
  if (value.failed > 0) return "FAILED";
  if (value.notVerified > 0 && value.verified > 0) return "PARTIAL";
  if (value.notVerified > 0) return "NOT_VERIFIED";
  return "VERIFIED";
}
function compareEvents(a: TwinEvent, b: TwinEvent) { return a.revisionAfter - b.revisionAfter || a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId); }
function isValidHash(value: string) { return /^(sha256:|0x)[0-9a-f]{64}$/.test(value); }
function range(start: number, end: number) { return start < end ? Array.from({ length: end - start }, (_, index) => start + index) : []; }
function normalize(value: string) { return value.toLowerCase().replace(/^0x0+/, "0x"); }
