import { randomBytes, randomUUID } from "node:crypto";
import { getFullnodeUrl, IotaClient } from "@iota/iota-sdk/client";
import { verifyPersonalMessageSignature } from "@iota/iota-sdk/verify";

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 30 * 60_000;

export class DidAuthService {
  constructor({ network = "testnet", rpcUrl, audience = "dt-demo.objectid.io", now = () => Date.now(), verifyController } = {}) {
    this.network = network;
    this.audience = audience;
    this.now = now;
    this.client = new IotaClient({ url: rpcUrl || getFullnodeUrl(network) });
    this.verifyController = verifyController ?? ((did, address) => ownsDidController(this.client, did, address));
    this.challenges = new Map();
    this.sessions = new Map();
  }

  createChallenge(did) {
    const normalizedDid = normalizeDid(did, this.network);
    this.prune();
    if (this.challenges.size >= 1000) this.challenges.delete(this.challenges.keys().next().value);
    const challengeId = randomUUID();
    const issuedAt = this.now();
    const expiresAt = issuedAt + CHALLENGE_TTL_MS;
    const nonce = randomBytes(24).toString("base64url");
    const message = [
      "ObjectID Digital Twin Login",
      `Audience: ${this.audience}`,
      `Network: ${this.network}`,
      `DID: ${normalizedDid}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(issuedAt).toISOString()}`,
      `Expires At: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    this.challenges.set(challengeId, { did: normalizedDid, message, expiresAt });
    return { challengeId, message, expiresAt };
  }

  async verify({ challengeId, did, signature }, resolveTwins) {
    const normalizedDid = normalizeDid(did, this.network);
    const challenge = this.challenges.get(String(challengeId ?? ""));
    this.challenges.delete(String(challengeId ?? ""));
    if (!challenge || challenge.expiresAt <= this.now() || challenge.did !== normalizedDid) throw authError("Challenge is invalid or expired");
    if (typeof signature !== "string" || !signature) throw authError("Signature is required");

    let publicKey;
    try {
      publicKey = await verifyPersonalMessageSignature(new TextEncoder().encode(challenge.message), signature);
    } catch {
      throw authError("Signature verification failed");
    }
    const address = publicKey.toIotaAddress();
    if (!(await this.verifyController(normalizedDid, address))) throw authError("The signing seed does not control this DID");

    const twins = await resolveTwins(normalizedDid);
    const token = randomBytes(32).toString("base64url");
    const session = { did: normalizedDid, address, twins, expiresAt: this.now() + SESSION_TTL_MS };
    this.sessions.set(token, session);
    return { token, session: publicSession(session) };
  }

  session(token) {
    this.prune();
    const session = this.sessions.get(String(token ?? ""));
    return session ? publicSession(session) : null;
  }

  async refresh(token, resolveTwins) {
    this.prune();
    const session = this.sessions.get(String(token ?? ""));
    if (!session) throw authError("DID login required");
    session.twins = await resolveTwins(session.did);
    return publicSession(session);
  }

  forgetTwin(token, twinId) {
    this.prune();
    const session = this.sessions.get(String(token ?? ""));
    if (!session) throw authError("DID login required");
    session.twins = session.twins.filter((twin) => twin.twinId !== twinId);
    return publicSession(session);
  }

  rememberTwin(token, twin) {
    this.prune();
    const session = this.sessions.get(String(token ?? ""));
    if (!session) throw authError("DID login required");
    session.twins = [...session.twins.filter((item) => item.twinId !== twin.twinId), twin];
    return publicSession(session);
  }

  destroy(token) { this.sessions.delete(String(token ?? "")); }

  prune() {
    const now = this.now();
    for (const [id, value] of this.challenges) if (value.expiresAt <= now) this.challenges.delete(id);
    for (const [id, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(id);
  }
}

export async function ownsDidController(client, did, address) {
  const controllerOf = did.slice(did.lastIndexOf(":") + 1).toLowerCase();
  let cursor;
  do {
    const page = await client.getOwnedObjects({
      owner: address,
      cursor,
      options: { showType: true, showContent: true },
    });
    const matched = page.data.some((item) => {
      const type = String(item.data?.type ?? item.data?.content?.type ?? "");
      const fields = item.data?.content?.dataType === "moveObject" ? item.data.content.fields : {};
      return type.endsWith("::oid_identity::ControllerCap")
        && String(fields?.controller_of ?? "").toLowerCase() === controllerOf;
    });
    if (matched) return true;
    cursor = page.hasNextPage ? page.nextCursor : undefined;
  } while (cursor);
  return false;
}

function normalizeDid(value, network) {
  const did = String(value ?? "").trim();
  const prefix = network === "mainnet" ? "did:iota:" : `did:iota:${network}:`;
  if (!did.startsWith(prefix) || !/^0x[0-9a-f]{64}$/i.test(did.slice(prefix.length))) throw authError(`A valid ${network} IOTA DID is required`);
  return did;
}

function publicSession(session) {
  return { did: session.did, address: session.address, twins: session.twins, expiresAt: session.expiresAt };
}

function authError(message) {
  const error = new Error(message);
  error.status = 401;
  return error;
}
