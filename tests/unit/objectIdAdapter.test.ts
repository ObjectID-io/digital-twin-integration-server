import type { IotaClient } from "@iota/iota-sdk/client";
import { describe, expect, it, vi } from "vitest";
import { ProviderObjectIdAdapter } from "../../src/objectid/adapter.js";
import { testConfig } from "../fixtures/config.js";

describe("ProviderObjectIdAdapter event metadata", () => {
  it("hydrates the creating transaction digest through IOTA RPC", async () => {
    const eventId = `0x${"1".repeat(64)}`;
    const oid = {
      getObjectsByTypeAndOwner: vi.fn(async () => [{ objectId: eventId }]),
      getObject: vi.fn(async () => ({
        data: { objectId: eventId, content: { fields: {
          twin_id: "0xtwin", event_type: 30, revision_before: "2", revision_after: "3",
          actor_did: "did:iota:testnet:actor", payload_ref: "0xstate", payload_hash: "", created_at: "123",
        } } },
      })),
    };
    const getObject = vi.fn(async () => ({ data: { previousTransaction: "tx-digest" } }));
    const rpcClient = { getObject } as unknown as IotaClient;
    const adapter = new ProviderObjectIdAdapter(testConfig(), oid, undefined, rpcClient);

    const events = await adapter.getTwinEvents("0xtwin");

    expect(events[0]?.transactionDigest).toBe("tx-digest");
    expect(getObject).toHaveBeenCalledWith({ id: eventId, options: { showPreviousTransaction: true } });
  });
});
