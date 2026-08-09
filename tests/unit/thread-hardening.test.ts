import { describe, expect, it } from "vitest";
import { InMemoryTwinIndexer } from "../../src/indexer/memory.js";
import { DigitalThreadService } from "../../src/thread/service.js";
import { canonicalHash, eventEvidenceHash } from "../../src/thread/verifier.js";
import type { TwinEvent } from "../../src/objectid/types.js";

describe("complete paginated Digital Thread verification", () => {
  it("finds a missing revision after event 500", async () => {
    const indexer = new InMemoryTwinIndexer();
    indexer.events.set("0xtwin", Array.from({ length: 1200 }, (_, index) => index + 1).filter((revision) => revision !== 879).map((revision) => event(revision)));
    const result = await new DigitalThreadService(indexer).verifyDigitalThread("0xtwin", { limit: 100 });
    expect(result).toMatchObject({ valid: false, complete: true, eventCount: 1199, pagesVerified: 12 });
    expect(result.missingRevisions).toContain(879);
  });

  it("detects continuity errors across the 100/101 page boundary", async () => {
    const indexer = new InMemoryTwinIndexer();
    const events = Array.from({ length: 200 }, (_, index) => event(index + 1));
    events[100] = event(102, { eventId: "boundary", revisionBefore: 101 });
    indexer.events.set("0xtwin", events);
    const result = await new DigitalThreadService(indexer).verifyDigitalThread("0xtwin", { limit: 100 });
    expect(result.complete).toBe(true); expect(result.valid).toBe(false); expect(result.missingRevisions).toContain(101);
  });

  it("never returns valid true when provider enumeration is partial", async () => {
    const indexer = new InMemoryTwinIndexer(); indexer.complete = false; indexer.events.set("0xtwin", [event(1)]);
    expect(await new DigitalThreadService(indexer).verifyDigitalThread("0xtwin")).toMatchObject({ valid: null, complete: false });
  });

  it("reports verified, partial, failed, and unsupported transaction states", async () => {
    const run = async (values: Array<boolean | undefined>) => {
      const indexer = new InMemoryTwinIndexer();
      const events = values.map((_, index) => event(index + 1, { transactionDigest: `tx${index}` }));
      values.forEach((value, index) => indexer.transactions.set(`tx${index}`, value)); indexer.events.set("0xtwin", events);
      return new DigitalThreadService(indexer).verifyDigitalThread("0xtwin");
    };
    expect((await run([true, true])).transactionVerification.status).toBe("VERIFIED");
    expect((await run([true, undefined])).transactionVerification.status).toBe("PARTIAL");
    const failed = await run([true, false]); expect(failed.transactionVerification.status).toBe("FAILED"); expect(failed.valid).toBe(false);
    expect((await run([undefined])).transactionVerification.status).toBe("NOT_VERIFIED");
  });
});

describe("canonical audit evidence", () => {
  it("hashes semantically identical property order identically", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1, b: 2 })).not.toBe(canonicalHash({ a: 1, b: 3 }));
  });

  it("excludes local transaction metadata from canonical event evidence", () => {
    expect(eventEvidenceHash(event(1, { transactionDigest: "tx-a" }))).toBe(eventEvidenceHash(event(1, { transactionDigest: "tx-b" })));
  });
});

function event(revision: number, extra: Partial<TwinEvent> = {}): TwinEvent {
  return { eventId: `e${revision}`, twinId: "0xtwin", eventType: 60, revisionBefore: revision - 1, revisionAfter: revision, actorDid: "did:a", payloadRef: "ipfs://x", payloadHash: `sha256:${"a".repeat(64)}`, createdAt: revision, ...extra };
}
