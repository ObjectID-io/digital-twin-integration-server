import { IotaClient } from "@iota/iota-sdk/client";
import { Transaction } from "@iota/iota-sdk/transactions";

const GAS_BUDGET = 100_000_000;

export function buildCreateTwinTransaction(context, input) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${context.packageId}::oid_twin::create_twin`,
    arguments: [
      tx.object(input.creditTokenId), tx.object(context.creditPolicyId), tx.object(context.controllerCapId),
      tx.pure.string(input.twinType), tx.pure.string(input.targetKind), tx.pure.option("address", input.targetObjectId || null),
      tx.pure.string(input.targetDid || ""), tx.pure.u8(Number(input.lifecycleState)), tx.pure.u8(Number(input.fidelityLevel)),
      tx.pure.u8(Number(input.maturityLevel)), tx.pure.string(input.name), tx.pure.string(input.description || ""),
      tx.pure.string(input.namespace), tx.pure.string(input.immutableMetadata || "{}"), tx.pure.string(input.mutableMetadata || "{}"),
      tx.object(context.clockId),
    ],
  });
  tx.setGasBudget(GAS_BUDGET);
  return tx;
}

export function buildDeleteTwinTransaction(context, twinId, creditTokenId) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${context.packageId}::oid_twin::delete_twin`,
    arguments: [tx.object(creditTokenId), tx.object(context.creditPolicyId), tx.object(context.controllerCapId), tx.object(twinId), tx.object(context.clockId)],
  });
  tx.setGasBudget(GAS_BUDGET);
  return tx;
}

export async function executeTwinTransaction({ keypair, network, transaction }) {
  const client = new IotaClient({ url: network === "mainnet" ? "https://api.mainnet.iota.cafe" : "https://api.testnet.iota.cafe" });
  transaction.setSender(keypair.toIotaAddress());
  const submitted = await client.signAndExecuteTransaction({ signer: keypair, transaction });
  const result = await client.waitForTransaction({ digest: submitted.digest, options: { showEffects: true, showObjectChanges: true } });
  const status = result.effects?.status?.status;
  if (status && status !== "success") throw new Error(result.effects?.status?.error || "IOTA transaction failed");
  return result;
}

export function createdTwinId(result, packageId) {
  return result.objectChanges?.find((change) => change.type === "created" && change.objectType === `${packageId}::oid_twin::OIDTwin`)?.objectId ?? "";
}

export function usableCreditTokens(context) {
  return (context?.creditTokens ?? []).filter((token) => /^\d+$/.test(token.balance) && BigInt(token.balance) > 0n);
}
