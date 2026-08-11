import { ChainReader } from "./chain-reader.js";
import { getFullnodeUrl, IotaClient } from "@iota/iota-sdk/client";
import { ownsDidController } from "./did-auth.js";
import { buildCreateTwinTransaction } from "../src/twin-mutations.js";

const packageId = process.env.IOTA_PACKAGE_ID;
const did = process.env.SMOKE_DID;
const twinId = process.env.TWIN_ID;
if (!packageId || !did || !twinId) throw new Error("IOTA_PACKAGE_ID, SMOKE_DID and TWIN_ID are required");

const reader = new ChainReader({
  network: process.env.IOTA_NETWORK ?? "testnet",
  rpcUrl: process.env.IOTA_RPC_URL,
  graphqlUrl: process.env.IOTA_GRAPHQL_URL,
  packageId,
});
const twins = await reader.listTwinsByDid(did);
const dashboard = await reader.dashboard(twinId);
const controllerVerified = process.env.SMOKE_ADDRESS
  ? await ownsDidController(new IotaClient({ url: process.env.IOTA_RPC_URL || getFullnodeUrl(process.env.IOTA_NETWORK ?? "testnet") }), did, process.env.SMOKE_ADDRESS)
  : undefined;
const mutationObjects = process.env.SMOKE_ADDRESS
  ? (await reader.ownedObjects(process.env.SMOKE_ADDRESS)).filter((item) => String(item.data?.type ?? "").includes("ControllerCap") || String(item.data?.type ?? "").includes("OID_CREDIT")).map((item) => ({
      objectId: item.data?.objectId, type: item.data?.type,
      controllerOf: item.data?.content?.fields?.controller_of,
      balance: item.data?.content?.fields?.balance,
    }))
  : undefined;
let createTwinDryRun;
if (process.env.SMOKE_ADDRESS && process.env.SMOKE_POLICY_ID && process.env.SMOKE_CREDIT_PACKAGE_ID && process.env.SMOKE_IDENTITY_PACKAGE_ID) {
  const controller = mutationObjects.find((item) => item.type === `${process.env.SMOKE_IDENTITY_PACKAGE_ID}::oid_identity::ControllerCap`);
  const credit = mutationObjects.find((item) => item.type === `0x2::token::Token<${process.env.SMOKE_CREDIT_PACKAGE_ID}::oid_credit::OID_CREDIT>`);
  if (controller && credit) {
    const client = new IotaClient({ url: process.env.IOTA_RPC_URL || getFullnodeUrl(process.env.IOTA_NETWORK ?? "testnet") });
    const transaction = buildCreateTwinTransaction({ packageId, creditPolicyId: process.env.SMOKE_POLICY_ID, controllerCapId: controller.objectId, clockId: "0x6" }, {
      creditTokenId: credit.objectId, twinType: "machine", targetKind: "physical-asset", targetObjectId: "", targetDid: "",
      lifecycleState: 1, fidelityLevel: 1, maturityLevel: 1, name: "dry-run-only", description: "", namespace: "smoke",
      immutableMetadata: "{}", mutableMetadata: "{}",
    });
    transaction.setSender(process.env.SMOKE_ADDRESS);
    const bytes = await transaction.build({ client });
    const result = await client.dryRunTransactionBlock({ transactionBlock: bytes });
    createTwinDryRun = result.effects.status;
  }
}
console.log(JSON.stringify({ twins, twinId: dashboard.twin.data.objectId, events: dashboard.events.length, identifiers: dashboard.identifiers.length, controllerVerified, mutationObjects, createTwinDryRun }, null, 2));
