import { createHmac, timingSafeEqual } from "node:crypto";
import canonicalize from "canonicalize";
import { SCENARIOS } from "./telemetry.js";

const UUID_URN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SimulatorCommandError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function verifySimulatorCommand(request, { assetId, interfaceId, signingKey, signingKeyId, now = Date.now(), clockSkewMs = 30_000 }) {
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("COMMAND_ENVELOPE_INVALID", "Command envelope must be a JSON object");
  const { authorization, ...unsigned } = request;
  if (request.specVersion !== "objectid.command.v1") fail("COMMAND_VERSION_UNSUPPORTED", "Unsupported command specification version");
  if (!UUID_URN.test(String(request.commandId ?? ""))) fail("COMMAND_ID_INVALID", "commandId must be a UUID URN");
  if (request.twinId !== assetId) fail("COMMAND_TWIN_MISMATCH", "Command targets a different Digital Twin");
  if (request.interfaceId !== interfaceId) fail("COMMAND_INTERFACE_MISMATCH", "Command targets an unsupported interface");
  if (!/^did:iota:[^:]+:0x[0-9a-f]+$/i.test(String(request.requestedBy?.did ?? ""))) fail("COMMAND_REQUESTER_INVALID", "Command requester must be an IOTA DID");
  if (request.proof?.type !== "IotaPersonalMessage" || request.proof?.canonicalization !== "RFC8785" || !request.proof?.signature) fail("COMMAND_PROOF_INVALID", "Verified caller proof is missing");
  const requestedAt = Date.parse(request.requestedAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(expiresAt)) fail("COMMAND_TIME_INVALID", "Command timestamps are invalid");
  if (requestedAt > now + clockSkewMs) fail("COMMAND_NOT_YET_VALID", "Command request time is in the future");
  if (expiresAt <= now - clockSkewMs) fail("COMMAND_EXPIRED", "Command has expired");
  if (expiresAt <= requestedAt || expiresAt - requestedAt > 300_000) fail("COMMAND_LIFETIME_INVALID", "Command lifetime is invalid");
  if (String(request.idempotencyKey ?? "") !== request.commandId) fail("COMMAND_IDEMPOTENCY_INVALID", "Command idempotency key must match commandId");
  verifyAuthorization(unsigned, authorization, signingKey, signingKeyId);
  validateCatalogCommand(request.command);
  return request;
}

export function executeSimulatorCommand(control, request) {
  validateCatalogCommand(request?.command);
  const name = request.command.name;
  const parameters = request.command.parameters;
  if (name === "pauseSimulation") control.paused = true;
  else if (name === "resumeSimulation") control.paused = false;
  else control.scenario = parameters.scenario;
  control.changedAt = new Date().toISOString();
  return { scenario: control.scenario, paused: control.paused };
}

function validateCatalogCommand(command) {
  if (!command || typeof command !== "object" || command.version !== "1.0") fail("COMMAND_NOT_SUPPORTED", "Unsupported simulator command version");
  const parameters = command.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) fail("COMMAND_PARAMETERS_INVALID", "Command parameters must be an object");
  if (command.name === "pauseSimulation" || command.name === "resumeSimulation") {
    if (Object.keys(parameters).length !== 0) fail("COMMAND_PARAMETERS_INVALID", `${command.name} does not accept parameters`);
    return;
  }
  if (command.name !== "setSimulationScenario") fail("COMMAND_NOT_SUPPORTED", "Unsupported simulator command");
  if (Object.keys(parameters).length !== 1 || typeof parameters.scenario !== "string") fail("COMMAND_PARAMETERS_INVALID", "setSimulationScenario requires only the scenario parameter");
  if (!SCENARIOS.includes(parameters.scenario) || parameters.scenario === "emergency-stop") fail("COMMAND_SAFETY_REJECTED", "Scenario is not allowed through the operational command channel");
}

function verifyAuthorization(unsigned, authorization, signingKey, signingKeyId) {
  if (!Buffer.isBuffer(signingKey) || signingKey.length < 32) fail("COMMAND_TRUST_NOT_CONFIGURED", "Simulator command verification key is unavailable");
  if (authorization?.type !== "ObjectIDIntegrationServerHmac" || authorization?.algorithm !== "HS256" || authorization?.canonicalization !== "RFC8785" || authorization?.keyId !== signingKeyId) fail("COMMAND_AUTHORIZATION_INVALID", "Integration Server authorization is missing or unsupported");
  const expected = createHmac("sha256", signingKey).update(canonicalize(unsigned)).digest();
  let received;
  try { received = Buffer.from(String(authorization.signature ?? ""), "base64url"); } catch { fail("COMMAND_AUTHORIZATION_INVALID", "Integration Server authorization is malformed"); }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) fail("COMMAND_AUTHORIZATION_INVALID", "Integration Server authorization verification failed");
}

function fail(code, message) { throw new SimulatorCommandError(code, message); }
