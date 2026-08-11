import { ChainReader } from "./chain-reader.js";
import { getFullnodeUrl, IotaClient } from "@iota/iota-sdk/client";
import { ownsDidController } from "./did-auth.js";

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
console.log(JSON.stringify({ twins, twinId: dashboard.twin.data.objectId, events: dashboard.events.length, identifiers: dashboard.identifiers.length, controllerVerified }, null, 2));
