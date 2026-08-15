import { randomBytes } from "node:crypto";
import { toBase64 } from "@iota/bcs";
import { IotaClient } from "@iota/iota-sdk/client";
import { verifyTransactionSignature } from "@iota/iota-sdk/verify";
import { buildCreateTwinTransaction, createdTwinId } from "../src/twin-mutations.js";

const GAS_BUDGET = 100_000_000;
const RESERVATION_SECONDS = 10;

export class GasStationBroker {
  constructor({ client, stations = [], now = () => Date.now(), fetchImpl = fetch } = {}) {
    this.client = client;
    this.stations = stations.filter((station) => station.url && station.token);
    this.now = now;
    this.fetch = fetchImpl;
    this.pending = new Map();
  }

  get configured() { return this.stations.length > 0; }

  async prepareCreate({ sessionToken, session, context, input }) {
    if (!this.configured) throw serviceError("Gas station configuration is incomplete");
    const normalized = validateCreateTwinInput(input);
    const credit = context.creditTokens.find((token) => token.objectId === normalized.creditTokenId && BigInt(token.balance) > 0n);
    if (!credit) throw requestError("The selected OID Credit token is not spendable by this signer");

    const { station, reservation } = await this.reserveGas();
    const transaction = buildCreateTwinTransaction(context, normalized);
    transaction.setSender(session.address);
    transaction.setGasOwner(reservation.sponsor_address);
    transaction.setGasPayment(reservation.gas_coins);
    transaction.setGasBudget(GAS_BUDGET);
    const bytes = await transaction.build({ client: this.client });
    const pendingId = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + RESERVATION_SECONDS * 1000;
    this.prune();
    this.pending.set(pendingId, {
      sessionToken, address: session.address, packageId: context.packageId, name: normalized.name,
      station, reservationId: reservation.reservation_id, bytes, expiresAt,
    });
    return { pendingId, transactionBytes: toBase64(bytes), expiresAt, sponsorAddress: reservation.sponsor_address };
  }

  async executeCreate({ sessionToken, session, pendingId, signature }) {
    this.prune();
    const pending = this.pending.get(String(pendingId ?? ""));
    this.pending.delete(String(pendingId ?? ""));
    if (!pending || pending.expiresAt <= this.now() || pending.sessionToken !== sessionToken || pending.address !== session.address) {
      throw requestError("Sponsored transaction is invalid or expired");
    }
    let publicKey;
    try { publicKey = await verifyTransactionSignature(pending.bytes, String(signature ?? "")); }
    catch { throw requestError("Sponsored transaction signature is invalid"); }
    if (publicKey.toIotaAddress() !== session.address) throw requestError("Transaction signature does not match the authenticated DID signer");

    const payload = await gasRequest(this.fetch, pending.station, "/v1/execute_tx", {
      reservation_id: pending.reservationId,
      tx_bytes: toBase64(pending.bytes),
      user_sig: signature,
    });
    const digest = String(payload?.effects?.transactionDigest ?? payload?.result?.effects?.transactionDigest ?? "");
    if (!digest) throw serviceError("Gas station response does not contain a transaction digest");
    const result = await this.client.waitForTransaction({ digest, options: { showEffects: true, showObjectChanges: true } });
    if (result.effects?.status?.status !== "success") throw serviceError(result.effects?.status?.error || "Sponsored IOTA transaction failed");
    return { digest, twinId: createdTwinId(result, pending.packageId), name: pending.name, sponsored: true };
  }

  async reserveGas() {
    let lastError;
    for (const station of this.stations) {
      try {
        const payload = await gasRequest(this.fetch, station, "/v1/reserve_gas", {
          gas_budget: GAS_BUDGET,
          reserve_duration_secs: RESERVATION_SECONDS,
        });
        const reservation = payload?.result;
        if (!reservation?.sponsor_address || reservation?.reservation_id === undefined || !Array.isArray(reservation?.gas_coins) || !reservation.gas_coins.length) {
          throw new Error("Invalid gas reservation response");
        }
        return { station, reservation };
      } catch (error) { lastError = error; }
    }
    throw serviceError(`Unable to reserve sponsored gas: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  prune() {
    const now = this.now();
    for (const [id, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(id);
  }
}

export function createGasStationClient({ network, rpcUrl }) {
  return new IotaClient({ url: rpcUrl || (network === "mainnet" ? "https://api.mainnet.iota.cafe" : "https://api.testnet.iota.cafe") });
}

export function validateCreateTwinInput(value = {}) {
  const input = {
    name: bounded(value.name, "Name", 1, 128), description: bounded(value.description, "Description", 0, 1024),
    namespace: bounded(value.namespace, "Namespace", 1, 128), twinType: bounded(value.twinType, "Twin type", 1, 64),
    targetKind: bounded(value.targetKind, "Target kind", 1, 64), targetDid: bounded(value.targetDid, "Target DID", 0, 256),
    targetObjectId: String(value.targetObjectId ?? "").trim(), creditTokenId: objectId(value.creditTokenId, "OID Credit token"),
    lifecycleState: integer(value.lifecycleState, "Lifecycle state", 1, 10), fidelityLevel: integer(value.fidelityLevel, "Fidelity level", 0, 255),
    maturityLevel: integer(value.maturityLevel, "Maturity level", 0, 255),
    immutableMetadata: jsonText(value.immutableMetadata, "Immutable metadata"), mutableMetadata: jsonText(value.mutableMetadata, "Mutable metadata"),
  };
  if (input.targetObjectId && !/^0x[0-9a-f]{64}$/i.test(input.targetObjectId)) throw requestError("Target object ID is invalid");
  return input;
}

async function gasRequest(fetchImpl, station, path, body) {
  const response = await fetchImpl(`${station.url.replace(/\/$/, "")}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${station.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`));
  return payload;
}

function bounded(value, label, minimum, maximum) {
  const text = String(value ?? "").trim();
  if (text.length < minimum || text.length > maximum) throw requestError(`${label} must contain between ${minimum} and ${maximum} characters`);
  return text;
}
function integer(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw requestError(`${label} must be between ${minimum} and ${maximum}`);
  return number;
}
function objectId(value, label) {
  const id = String(value ?? "").trim();
  if (!/^0x[0-9a-f]{64}$/i.test(id)) throw requestError(`${label} is invalid`);
  return id;
}
function jsonText(value, label) {
  const text = bounded(value ?? "{}", label, 2, 4096);
  try { JSON.parse(text); } catch { throw requestError(`${label} must be valid JSON`); }
  return text;
}
function requestError(message) { const error = new Error(message); error.status = 400; return error; }
function serviceError(message) { const error = new Error(message); error.status = 503; return error; }
