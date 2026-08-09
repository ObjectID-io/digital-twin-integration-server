import { describe, expect, it } from "vitest";
import { ObjectIdIndexerAdapter } from "../../src/indexer/objectid.js";
import type { TwinEvent } from "../../src/objectid/types.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

describe("indexed pagination boundary", () => {
  it("pages 1500 filtered events provider-side without calling getDigitalThread", async () => {
    const adapter = new FakeObjectIdAdapter();
    adapter.setChildren("0xtwin", "OIDTwinEvent", Array.from({ length: 1500 }, (_, index): TwinEvent => event(index + 1)));
    const indexer = new ObjectIdIndexerAdapter(adapter, testConfig());
    const revisions: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await indexer.findTwinEvents("0xtwin", { cursor, limit: 100, fromRevision: 1, toRevision: 1500, eventTypes: [60], fromTimestamp: 1, toTimestamp: 1500 });
      revisions.push(...page.items.map((item) => item.revisionAfter)); pages += 1; cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (cursor);
    expect(pages).toBe(15); expect(revisions).toHaveLength(1500);
    expect(new Set(revisions).size).toBe(1500); expect(revisions[0]).toBe(1); expect(revisions.at(-1)).toBe(1500);
    expect(adapter.getDigitalThreadCalls).toBe(0);
  });
});

function event(revision: number): TwinEvent {
  return { eventId: `e${revision}`, twinId: "0xtwin", eventType: 60, revisionBefore: revision - 1, revisionAfter: revision, actorDid: "did:a", payloadRef: "ipfs://x", payloadHash: `sha256:${"a".repeat(64)}`, createdAt: revision };
}
