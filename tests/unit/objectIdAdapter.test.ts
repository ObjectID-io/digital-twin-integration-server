import type { IotaClient } from "@iota/iota-sdk/client";
import { describe, expect, it, vi } from "vitest";
import { ProviderObjectIdAdapter } from "../../src/objectid/adapter.js";
import { testConfig } from "../fixtures/config.js";

describe("ProviderObjectIdAdapter event metadata", () => {
  it("hydrates the creating transaction digest through IOTA RPC", async () => {
    const eventId = `0x${"1".repeat(64)}`;
    const stateId = `0x${"2".repeat(64)}`;
    const oid = {
      getObjectsByTypeAndOwner: vi.fn(async () => [{ objectId: eventId }]),
      getObject: vi.fn(async () => ({
        data: { objectId: eventId, content: { fields: {
          twin_id: "0xtwin", event_type: 30, revision_before: "2", revision_after: "3",
          actor_did: "did:iota:testnet:actor", payload_ref: stateId, payload_hash: "", created_at: "123",
        } } },
      })),
    };
    const getObject = vi.fn(async ({ id }: { id: string }) => id === eventId
      ? { data: { previousTransaction: "tx-digest" } }
      : { data: { content: { dataType: "moveObject", type: "0xpackage::oid_twin::OIDTwinState", fields: {
        aspect_code: "telemetry", sample_type: "observed", source_uri: "mqtt://state",
        payload_hash: "abc123", payload_uri: "", payload_inline: '{"simulationScenario":"overheat"}',
        observed_at: "123", valid_from: "123", valid_to: "0", quality_score: 100,
        creator_did: "did:iota:testnet:actor", superseded: false,
      } } } });
    const rpcClient = { getObject } as unknown as IotaClient;
    const adapter = new ProviderObjectIdAdapter(testConfig(), oid, undefined, rpcClient);

    const events = await adapter.getTwinEvents("0xtwin");

    expect(events[0]?.transactionDigest).toBe("tx-digest");
    expect(events[0]?.referencedState).toMatchObject({
      objectId: stateId, payloadHash: "abc123", payload: { simulationScenario: "overheat" }, qualityScore: 100,
    });
    expect(getObject).toHaveBeenCalledWith({ id: eventId, options: { showPreviousTransaction: true } });
    expect(getObject).toHaveBeenCalledWith({ id: stateId, options: { showContent: true } });
  });
});
