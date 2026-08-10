import assert from "node:assert/strict";
import test from "node:test";
import { canonicalHash, validateAuditEvidence } from "../src/audit-validation.js";

const events = [
  { eventId: "0x01", twinId: "0xtwin", eventType: 1, revisionBefore: 0, revisionAfter: 1, actorDid: "did:iota:testnet:creator", payloadRef: "", payloadHash: "", createdAt: 1000 },
  { eventId: "0x02", twinId: "0xtwin", eventType: 2, revisionBefore: 1, revisionAfter: 2, actorDid: "did:iota:testnet:creator", payloadRef: "ipfs://evidence", payloadHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", createdAt: 2000 },
];

test("recalculates evidence and report hashes independently", async () => {
  const first = await validateAuditEvidence(events, {}, null);
  const verification = { valid: true, complete: true, eventEvidenceDigest: first.evidence.calculated };
  const unsigned = { reportFormatVersion: "1.0", verifierVersion: "1.1.0", verification, evidenceHash: { serialization: "RFC8785-JCS", digest: first.evidence.calculated } };
  const report = { ...unsigned, reportHash: await canonicalHash(unsigned) };
  const result = await validateAuditEvidence(events, verification, report);
  assert.equal(result.verifier.status, "VERIFIED");
  assert.equal(result.evidence.status, "VERIFIED");
  assert.equal(result.report.status, "VERIFIED");
});

test("detects tampered evidence and report content", async () => {
  const report = { reportFormatVersion: "1.0", verifierVersion: "1.1.0", evidenceHash: { serialization: "RFC8785-JCS", digest: "sha256:bad" }, reportHash: "sha256:bad" };
  const result = await validateAuditEvidence(events, { valid: true, complete: true, eventEvidenceDigest: "sha256:bad" }, report);
  assert.equal(result.evidence.status, "FAILED");
  assert.equal(result.report.status, "FAILED");
});
