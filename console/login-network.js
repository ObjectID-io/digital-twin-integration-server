export function loginNetwork(did) {
  if (/^did:iota:testnet:0x[0-9a-fA-F]{64}$/.test(did)) return "testnet";
  if (/^did:iota:0x[0-9a-fA-F]{64}$/.test(did)) return "mainnet";
  throw Error("Enter a valid mainnet or testnet IOTA DID with a 64-character hexadecimal identifier.");
}
export function loginPrefix(network, currentNetwork, currentPrefix) {
  return network === currentNetwork ? currentPrefix : network === "mainnet" ? "/mainnet" : "";
}
