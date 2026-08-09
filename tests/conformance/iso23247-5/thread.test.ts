import { describe, expect, it } from "vitest";
import { verifyEvents } from "../../../src/thread/verifier.js";
import type { TwinEvent } from "../../../src/objectid/types.js";

const hash = `sha256:${"a".repeat(64)}`;
const event = (revision: number, extra: Partial<TwinEvent> = {}): TwinEvent => ({
  eventId: `e${revision}`, twinId: "0xtwin", eventType: 60, revisionBefore: revision - 1,
  revisionAfter: revision, actorDid: "did:a", payloadRef: "ipfs://evidence", payloadHash: hash,
  createdAt: revision, ...extra,
});

describe("ISO 23247-5 Digital Thread evidence", () => {
  it("DT-23247-5-001 verifies a continuous reconstructed event sequence", () => {
    expect(verifyEvents("0xtwin", [event(1), event(2), event(3)])).toMatchObject({ valid: true, firstRevision: 1, lastRevision: 3, eventCount: 3 });
  });

  it("DT-23247-5-002 detects missing and duplicate revisions", () => {
    const result = verifyEvents("0xtwin", [event(1), event(3, { revisionBefore: 2 }), event(3, { eventId: "duplicate" })]);
    expect(result.valid).toBe(false); expect(result.missingRevisions).toContain(2); expect(result.duplicateRevisions).toContain(3);
  });

  it("DT-23247-5-003 detects invalid event type, twin, actor, transition, order, and hash", () => {
    const result = verifyEvents("0xtwin", [event(2), event(1, { eventType: 999, twinId: "0xother", actorDid: "", revisionAfter: 4, payloadHash: "bad" })]);
    expect(result.valid).toBe(false); expect(result.invalidEvents.length).toBeGreaterThan(0); expect(result.hashErrors).toHaveLength(1);
  });
});
