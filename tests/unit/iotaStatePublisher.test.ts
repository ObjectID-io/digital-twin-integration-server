import { Ed25519Keypair } from "@iota/iota-sdk/keypairs/ed25519";
import type { IotaClient } from "@iota/iota-sdk/client";
import { Transaction } from "@iota/iota-sdk/transactions";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config/types.js";
import { AppError } from "../../src/common/errors.js";
import { IotaStatePublisher } from "../../src/objectid/iotaStatePublisher.js";
import type { CredentialProvider } from "../../src/security/credentials.js";

const seed = "00".repeat(32);
const address = Ed25519Keypair.deriveKeypairFromSeed(seed).toIotaAddress();
const id = (digit: string) => `0x${digit.repeat(64)}`;

function objectidConfig(): AppConfig["objectid"] {
  return {
    network: "testnet",
    rpcUrl: "http://localhost:9000",
    packageId: id("1"),
    timeoutMs: 30_000,
    signer: {
      enabled: true,
      seedCredential: "SEED",
      addressCredential: "ADDRESS",
      controllerCapCredential: "CAP",
      subscriptionCredential: "SUBSCRIPTION",
      delegatedAccounts: false,
      clockId: "0x6",
      gasBudget: 100_000_000,
      gasStations: [{ url: "https://gas.objectid.test", tokenCredential: "GAS_TOKEN" }],
    },
  };
}

function credentials(overrides: Record<string, string> = {}): CredentialProvider {
  const values = { SEED: seed, ADDRESS: address, CAP: id("2"), SUBSCRIPTION: id("3"), GAS_TOKEN: "secret", ...overrides };
  return { async get(name) { return values[name as keyof typeof values]; } };
}

describe("IotaStatePublisher", () => {
  it("rejects a seed that does not derive the configured signer address", async () => {
    const publisher = new IotaStatePublisher(objectidConfig(), credentials({ ADDRESS: "0xwrong" }));
    await expect(publisher.initialize()).rejects.toMatchObject({ code: "OBJECTID_SIGNER_ADDRESS_MISMATCH" } satisfies Partial<AppError>);
  });

  it("returns subscription limits and remaining usage from IOTA", async () => {
    const getObject = vi.fn(async () => ({ data: {
      type: `${id("1")}::oid_twin::SubscriptionAccount`,
      content: { dataType: "moveObject", type: `${id("1")}::oid_twin::SubscriptionAccount`, hasPublicTransfer: true, fields: {
        customer_id: "customer-42", controller_id: id("7"), plan: 2, status: 1,
        period_start: "0", period_end: String(Date.now() + 60_000), twin_limit: "20",
        active_twin_count: "3", credit_limit: "40000", credits_used: "1250", updated_at: "1787070600000",
      } },
    } }));
    const publisher = new IotaStatePublisher(objectidConfig(), credentials(), { getObject } as unknown as IotaClient);

    const result = await publisher.getSubscription();

    expect(result).toMatchObject({
      objectId: id("3"), customerId: "customer-42", plan: { code: 2, name: "advanced" },
      status: { code: 1, name: "active" }, activeTwinCount: "3", remainingTwins: "17",
      creditsUsed: "1250", remainingCredits: "38750", current: true,
    });
  });

  it("submits oid_twin::publish_state and waits for its effects", async () => {
    const build = vi.spyOn(Transaction.prototype, "build").mockImplementation(async function (this: Transaction) {
      const command = this.getData().commands[0];
      expect(command?.$kind).toBe("MoveCall");
      if (!command || command.$kind !== "MoveCall" || !command.MoveCall) throw new Error("expected MoveCall");
      expect(command.MoveCall.package).toBe(id("1"));
      expect(command.MoveCall.module).toBe("oid_twin");
      expect(command.MoveCall.function).toBe("publish_state");
      expect(command.MoveCall.arguments).toHaveLength(14);
      return new Uint8Array([1, 2, 3]);
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: {
        sponsor_address: id("9"),
        reservation_id: 42,
        gas_coins: [{ objectId: id("8"), version: "1", digest: "1npP8YvwXd1DW5URq7TpARkKcdobKEnpM6W2Cf2wTnU" }],
      } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ effects: { transactionDigest: "tx-digest" } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const waitForTransaction = vi.fn(async () => ({ digest: "tx-digest", effects: { status: { status: "success" } } }));
    const getObject = vi.fn(async ({ id: objectId }: { id: string }) => objectId === id("5") ? { data: {
      type: `${id("1")}::oid_twin::OIDTwin`,
      content: { dataType: "moveObject", type: `${id("1")}::oid_twin::OIDTwin`, fields: { subscription_id: id("3") } },
    } } : { data: {
      type: `${id("1")}::oid_twin::SubscriptionAccount`,
      content: { dataType: "moveObject", type: `${id("1")}::oid_twin::SubscriptionAccount`, fields: {
        customer_id: "legacy", controller_id: id("7"), plan: 1, status: 1, period_start: "0",
        period_end: String(Date.now() + 60_000), twin_limit: "5", active_twin_count: "1",
        credit_limit: "10000", credits_used: "1", updated_at: "1",
      } },
    } });
    const client = { waitForTransaction, getObject } as unknown as IotaClient;
    const publisher = new IotaStatePublisher(objectidConfig(), credentials(), client);

    await publisher.initialize();
    const result = await publisher.publishState(id("5"), {
      aspectCode: "telemetry",
      sampleType: "observed",
      sourceUri: "mqtt://objectid/twins/telemetry/state",
      payloadInline: '{"temperature":21.5}',
      observedAt: 1_786_436_670_000,
    }) as { digest: string };

    expect(result.digest).toBe("tx-digest");
    expect(build).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gas.objectid.test/v1/reserve_gas");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://gas.objectid.test/v1/execute_tx");
    expect(waitForTransaction).toHaveBeenCalledWith({
      digest: "tx-digest",
      timeout: 30_000,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    vi.unstubAllGlobals();
    build.mockRestore();
  });
});
