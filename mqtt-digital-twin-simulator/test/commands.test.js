import { createHmac } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import canonicalize from "canonicalize";
import { executeSimulatorCommand, verifySimulatorCommand } from "../src/commands.js";

const assetId = `0x${"89".repeat(32)}`;
const interfaceId = "urn:objectid:interface:simulator-control:v1";
const signingKeyId = "dtis-command-v1";
const signingKey = Buffer.alloc(32, 7);
const now = Date.parse("2026-08-16T17:00:00.000Z");

test("verifies and executes an authenticated operational command", () => {
  const request = signedRequest();
  assert.equal(verifySimulatorCommand(request, { assetId, interfaceId, signingKey, signingKeyId, now }), request);
  const control = { scenario: "normal", paused: false };
  assert.deepEqual(executeSimulatorCommand(control, request), { scenario: "normal", paused: true });
  assert.deepEqual(executeSimulatorCommand(control, signedRequest({ command: { name: "setSimulationScenario", version: "1.0", parameters: { scenario: "overheat" } } })), { scenario: "overheat", paused: true });
});

test("rejects tampered, expired and safety commands", () => {
  const tampered = signedRequest();
  tampered.command.name = "resumeSimulation";
  assert.throws(() => verifySimulatorCommand(tampered, { assetId, interfaceId, signingKey, signingKeyId, now }), /authorization verification failed/);
  assert.throws(() => verifySimulatorCommand(signedRequest({ expiresAt: "2026-08-16T16:59:00.000Z" }), { assetId, interfaceId, signingKey, signingKeyId, now }), /expired/);
  assert.throws(() => executeSimulatorCommand({ scenario: "normal", paused: false }, { command: { name: "setSimulationScenario", version: "1.0", parameters: { scenario: "emergency-stop" } } }), /not allowed/);
});

function signedRequest(override = {}) {
  const unsigned = {
    specVersion: "objectid.command.v1",
    commandId: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
    twinId: assetId,
    interfaceId,
    command: { name: "pauseSimulation", version: "1.0", parameters: {} },
    requestedBy: { did: `did:iota:testnet:0x${"67".repeat(32)}` },
    requestedAt: "2026-08-16T17:00:00.000Z",
    expiresAt: "2026-08-16T17:00:30.000Z",
    proof: { type: "IotaPersonalMessage", signature: "AAECAwQ", canonicalization: "RFC8785" },
    idempotencyKey: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
    status: "authorized",
    statusUpdatedAt: "2026-08-16T17:00:00.000Z",
    transport: { type: "mqtt", requestTopic: `objectid/twins/${assetId}/commands/request`, resultTopic: `objectid/twins/${assetId}/commands/123e4567-e89b-42d3-a456-426614174000/result`, qos: 1 },
    ...override,
  };
  const signature = createHmac("sha256", signingKey).update(canonicalize(unsigned)).digest("base64url");
  return { ...unsigned, authorization: { type: "ObjectIDIntegrationServerHmac", algorithm: "HS256", keyId: signingKeyId, canonicalization: "RFC8785", signature } };
}
