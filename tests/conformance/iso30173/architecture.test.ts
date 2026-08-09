import { describe, expect, it } from "vitest";
import { ObjectIdTwinIndexer, INDEXER_SCHEMA_VERSION } from "../../../src/indexer/objectid.js";
import { FakeObjectIdAdapter } from "../../fixtures/fakeObjectId.js";
import { testConfig } from "../../fixtures/config.js";

describe("ISO/IEC 30173 architecture evidence", () => {
  it("DT-30173-001 keeps the indexer a replaceable derived read model", async () => {
    const adapter = new FakeObjectIdAdapter();
    adapter.setChildren("0xtwin", "OIDTwinEvent", Array.from({ length: 3 }, (_, i) => ({
      eventId: `e${i}`, twinId: "0xtwin", eventType: 1, revisionBefore: i, revisionAfter: i + 1,
      actorDid: "did:a", payloadRef: "", payloadHash: "", createdAt: i,
    })));
    const indexer = new ObjectIdTwinIndexer(adapter, testConfig());
    const first = await indexer.findTwinEvents("0xtwin", { limit: 2 });
    const second = await indexer.findTwinEvents("0xtwin", { cursor: first.nextCursor, limit: 2 });
    expect(first.items).toHaveLength(2); expect(second.items).toHaveLength(1);
    expect(INDEXER_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
