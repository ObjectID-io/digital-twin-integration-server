import { Ed25519Keypair } from "@iota/iota-sdk/keypairs/ed25519";
import type { IotaClient } from "@iota/iota-sdk/client";
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
      creditPolicyCredential: "POLICY",
      creditTokenCredential: "CREDIT",
      clockId: "0x6",
      gasBudget: 10_000_000,
    },
  };
}

function credentials(overrides: Record<string, string> = {}): CredentialProvider {
  const values = { SEED: seed, ADDRESS: address, CAP: id("2"), POLICY: id("3"), CREDIT: id("4"), ...overrides };
  return { async get(name) { return values[name as keyof typeof values]; } };
}

describe("IotaStatePublisher", () => {
  it("rejects a seed that does not derive the configured signer address", async () => {
    const publisher = new IotaStatePublisher(objectidConfig(), credentials({ ADDRESS: "0xwrong" }));
    await expect(publisher.initialize()).rejects.toMatchObject({ code: "OBJECTID_SIGNER_ADDRESS_MISMATCH" } satisfies Partial<AppError>);
  });

  it("submits oid_twin::publish_state and waits for its effects", async () => {
    const signAndExecuteTransaction = vi.fn(async ({ transaction }: any) => {
      const command = transaction.getData().commands[0];
      expect(command.$kind).toBe("MoveCall");
      expect(command.MoveCall.package).toBe(id("1"));
      expect(command.MoveCall.module).toBe("oid_twin");
      expect(command.MoveCall.function).toBe("publish_state");
      expect(command.MoveCall.arguments).toHaveLength(15);
      return { digest: "tx-digest", effects: { status: { status: "success" } } };
    });
    const waitForTransaction = vi.fn(async () => ({ digest: "tx-digest" }));
    const client = { signAndExecuteTransaction, waitForTransaction } as unknown as IotaClient;
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
    expect(signAndExecuteTransaction).toHaveBeenCalledOnce();
    expect(waitForTransaction).toHaveBeenCalledWith({ digest: "tx-digest", timeout: 30_000 });
  });
});
