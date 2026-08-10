import { describe, expect, it } from "vitest";
import { AppError } from "../../src/common/errors.js";
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

  it("falls back to cached on-chain child events with filters and stable pagination", async () => {
    const adapter = new ChainOnlyAdapter();
    adapter.setChildren("0xtwin", "OIDTwinEvent", [event(3), event(1), event(2), { ...event(4), eventType: 70 }]);
    const indexer = new ObjectIdIndexerAdapter(adapter, testConfig({ cache: { type: "memory", ttlMs: 60_000 } }));

    const first = await indexer.findTwinEvents("0xtwin", { limit: 2, eventTypes: [60] });
    const second = await indexer.findTwinEvents("0xtwin", { limit: 2, eventTypes: [60], cursor: first.nextCursor });

    expect(first.items.map((item) => item.revisionAfter)).toEqual([1, 2]);
    expect(second.items.map((item) => item.revisionAfter)).toEqual([3]);
    expect(first).toMatchObject({ hasMore: true, complete: true });
    expect(second).toMatchObject({ hasMore: false, complete: true });
    expect(adapter.getDigitalThreadCalls).toBe(1);
    await indexer.close();
  });

  it("returns a complete empty page when a Twin has no events", async () => {
    const indexer = new ObjectIdIndexerAdapter(new ChainOnlyAdapter(), testConfig());
    await expect(indexer.findTwinEvents("0xempty")).resolves.toEqual({ items: [], hasMore: false, complete: true, nextCursor: undefined });
    await indexer.close();
  });

  it("reports invalid cursors and on-chain read failures explicitly", async () => {
    const adapter = new ChainOnlyAdapter();
    const indexer = new ObjectIdIndexerAdapter(adapter, testConfig());
    await expect(indexer.findTwinEvents("0xtwin", { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "INDEXER_CURSOR_INVALID", status: 400 });
    adapter.readError = new Error("RPC unavailable");
    const failing = new ObjectIdIndexerAdapter(adapter, testConfig({ cache: { type: "memory", ttlMs: 1 } }));
    await expect(failing.findTwinEvents("0xfailing")).rejects.toMatchObject({ code: "IOTA_EVENT_READ_FAILED", status: 503, category: "NETWORK" });
    await Promise.all([indexer.close(), failing.close()]);
  });
});

class ChainOnlyAdapter extends FakeObjectIdAdapter {
  readError?: Error;

  async findIndexedTwinEvents(): Promise<never> {
    throw new AppError("OBJECTID_EVENT_INDEXER_REQUIRED", "No proprietary indexer", 501, "OBJECTID");
  }

  override async getDigitalThread(twinId: string) {
    if (this.readError) throw this.readError;
    return super.getDigitalThread(twinId);
  }
}

function event(revision: number): TwinEvent {
  return { eventId: `e${revision}`, twinId: "0xtwin", eventType: 60, revisionBefore: revision - 1, revisionAfter: revision, actorDid: "did:a", payloadRef: "ipfs://x", payloadHash: `sha256:${"a".repeat(64)}`, createdAt: revision };
}
