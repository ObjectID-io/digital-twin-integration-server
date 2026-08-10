export const EVENT_LABELS = Object.freeze({
  1: "Twin created", 2: "Twin updated", 3: "Twin deleted", 10: "Lifecycle changed",
  20: "Aspect added", 21: "Aspect updated", 22: "Aspect removed",
  30: "State published", 31: "State superseded",
  40: "Relation added", 41: "Relation updated", 42: "Relation removed",
  45: "Identifier added", 46: "Identifier removed",
  50: "Interface added", 51: "Interface updated", 52: "Interface removed",
  60: "Model added", 61: "Model updated", 62: "Model removed",
  70: "Dataset added", 71: "Dataset removed", 72: "Dataset updated",
  80: "Command issued", 81: "Command updated", 82: "Command completed",
  100: "Design released", 101: "Manufactured", 102: "Assembled", 103: "Tested", 104: "Commissioned",
  110: "Configuration changed", 120: "Maintenance started", 121: "Maintenance completed",
  130: "Repaired", 140: "Decommissioned",
  150: "Composition created", 151: "Composition updated", 152: "Composition removed",
  153: "Composition member added", 154: "Composition member removed",
  160: "Maturity assessment created", 161: "Maturity assessment updated", 162: "Maturity assessment finalized",
  163: "Maturity indicator added", 164: "Maturity indicator removed",
  170: "Identifier mapping added", 171: "Identifier mapping updated", 172: "Identifier mapping removed",
  180: "Role grant added", 181: "Role grant removed",
});

export function eventLabel(type) {
  return EVENT_LABELS[Number(type)] ?? `Event type ${type ?? "unknown"}`;
}

export function isIotaObjectId(value) {
  return /^0x[0-9a-f]{64}$/i.test(String(value ?? ""));
}

export function objectExplorerUrl(objectId, network = "testnet") {
  return `https://explorer.iota.org/object/${encodeURIComponent(objectId)}?network=${encodeURIComponent(network)}`;
}

export function transactionExplorerUrl(digest, network = "testnet") {
  return `https://explorer.iota.org/txblock/${encodeURIComponent(digest)}?network=${encodeURIComponent(network)}`;
}
