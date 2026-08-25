import type { IotaClient } from "@iota/iota-sdk/client";
import type { Ed25519Keypair } from "@iota/iota-sdk/keypairs/ed25519";
import type { Transaction } from "@iota/iota-sdk/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SponsoredTransactionExecutor } from "../../src/objectid/sponsoredTransactionExecutor.js";

const id = (digit: string) => `0x${digit.repeat(64)}`;

describe("SponsoredTransactionExecutor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tries the second Gas Station when the first one fails before submission", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "station one unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: {
        sponsor_address: id("9"), reservation_id: 42,
        gas_coins: [{ objectId: id("8"), version: "1", digest: "gas-digest" }],
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ effects: { transactionDigest: "tx-digest" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const transaction = {
      setSender: vi.fn(), setGasOwner: vi.fn(), setGasPayment: vi.fn(), setGasBudget: vi.fn(),
      build: vi.fn(async () => new Uint8Array([1, 2, 3])),
    } as unknown as Transaction;
    const keypair = {
      toIotaAddress: () => id("7"),
      signTransaction: vi.fn(async () => ({ signature: "user-signature" })),
    } as unknown as Ed25519Keypair;
    const client = {
      waitForTransaction: vi.fn(async () => ({ digest: "tx-digest", effects: { status: { status: "success" } } })),
    } as unknown as IotaClient;
    const executor = new SponsoredTransactionExecutor(client, keypair, [
      { url: "https://m-gas1.objectid.test", token: "one", reserveDurationSeconds: 30 },
      { url: "https://m-gas2.objectid.test", token: "two", reserveDurationSeconds: 30 },
    ], 100_000_000, 30_000);

    const result = await executor.execute(() => transaction, "delete_twin");

    expect(result.digest).toBe("tx-digest");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://m-gas1.objectid.test/v1/reserve_gas",
      "https://m-gas2.objectid.test/v1/reserve_gas",
      "https://m-gas2.objectid.test/v1/execute_tx",
    ]);
  });
});
