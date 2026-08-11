import assert from "node:assert/strict";
import test from "node:test";
import { Ed25519Keypair } from "@iota/iota-sdk/keypairs/ed25519";
import { DidAuthService } from "./did-auth.js";

const did = `did:iota:testnet:0x${"a".repeat(64)}`;

test("authenticates a DID with a one-time personal-message signature", async () => {
  const keypair = Ed25519Keypair.generate();
  let controllerCheck;
  const auth = new DidAuthService({
    network: "testnet",
    verifyController: async (candidateDid, address) => { controllerCheck = { candidateDid, address }; return true; },
  });
  const challenge = auth.createChallenge(did);
  const signed = await keypair.signPersonalMessage(new TextEncoder().encode(challenge.message));
  const result = await auth.verify({ challengeId: challenge.challengeId, did, signature: signed.signature }, async () => [
    { twinId: `0x${"b".repeat(64)}`, name: "CNC", roles: ["owner"] },
  ]);

  assert.equal(controllerCheck.candidateDid, did);
  assert.equal(controllerCheck.address, keypair.toIotaAddress());
  assert.equal(result.session.twins[0].roles[0], "owner");
  assert.equal(auth.session(result.token).did, did);
  const refreshed = await auth.refresh(result.token, async () => [{ twinId: `0x${"c".repeat(64)}`, roles: ["creator"] }]);
  assert.equal(refreshed.twins[0].roles[0], "creator");
  assert.equal(auth.forgetTwin(result.token, refreshed.twins[0].twinId).twins.length, 0);
  assert.equal(auth.rememberTwin(result.token, refreshed.twins[0]).twins.length, 1);
  await assert.rejects(() => auth.verify({ challengeId: challenge.challengeId, did, signature: signed.signature }, async () => []), /invalid or expired/);
});

test("rejects a signer that does not own the DID ControllerCap", async () => {
  const keypair = Ed25519Keypair.generate();
  const auth = new DidAuthService({ network: "testnet", verifyController: async () => false });
  const challenge = auth.createChallenge(did);
  const signed = await keypair.signPersonalMessage(new TextEncoder().encode(challenge.message));
  await assert.rejects(() => auth.verify({ challengeId: challenge.challengeId, did, signature: signed.signature }, async () => []), /does not control/);
});
