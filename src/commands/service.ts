import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { AppError } from "../common/errors.js";
import type { TwinConnector, Subscription } from "../connectors/types.js";
import { CommandStore } from "./store.js";
import { CommandTransportSigner } from "./signing.js";
import type { CommandCatalog, CommandConfig, CommandRecord, CommandStatus } from "./types.js";

const finalStatuses = new Set<CommandStatus>(["succeeded", "failed", "rejected", "expired", "cancelled"]);
const require = createRequire(import.meta.url);
const Ajv = require("ajv") as any;

export class CommandService {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly store: CommandStore;
  private readonly signer: CommandTransportSigner;
  private resultSubscription?: Subscription;

  constructor(private readonly config: CommandConfig, private readonly mqtt?: TwinConnector) {
    this.store = new CommandStore(config.storeFile);
    this.signer = new CommandTransportSigner(config.signingKeyFile, config.signingKeyId);
  }

  capabilities() { return { enabled: this.config.enabled, transport: "mqtt", authenticatedEnvelope: this.signer.enabled, profile: "objectid.command.v1", resultProfile: "objectid.command-result.v1" }; }

  catalog(twinId: string): CommandCatalog {
    if (!this.config.enabled) throw new AppError("COMMANDS_DISABLED", "Command execution is disabled", 404, "CONNECTOR");
    const exact = this.config.catalogs.find((item) => item.twinId.toLowerCase() === twinId.toLowerCase());
    const fallback = this.config.catalogs.find((item) => item.twinId === "*");
    return structuredClone(exact ?? fallback ?? { twinId, interfaceId: "urn:objectid:interface:commands:v1", commands: [] });
  }

  async start() {
    await this.store.initialize();
    if (!this.config.enabled) return;
    await this.signer.initialize();
    if (!this.mqtt?.subscribeTo) return;
    this.resultSubscription = await this.mqtt.subscribeTo(this.config.resultTopic, (value) => this.acceptResult(value), 1);
  }

  async stop() { await this.resultSubscription?.close(); }

  async create(twinId: string, callerDid: string, input: any) {
    if (!callerDid) throw new AppError("COMMAND_CALLER_REQUIRED", "The authenticated caller DID is required", 401, "AUTHORIZATION");
    const catalog = this.catalog(twinId);
    const name = String(input?.command?.name ?? "");
    const version = String(input?.command?.version ?? "1.0");
    const definition = catalog.commands.find((item) => item.name === name && item.version === version);
    if (!definition) throw new AppError("COMMAND_NOT_ALLOWED", "The command is not present in this Twin command catalog", 422, "VALIDATION", { name, version });
    if (definition.riskClass === "safety-relevant") throw new AppError("SAFETY_COMMAND_REJECTED", "Safety functions cannot be executed through the general Digital Twin command channel", 403, "AUTHORIZATION");
    const parameters = input?.command?.parameters ?? {};
    const validate = this.ajv.compile(definition.parametersSchema);
    if (!validate(parameters)) throw new AppError("COMMAND_PARAMETERS_INVALID", "Command parameters do not match the catalog schema", 422, "SCHEMA", { errors: validate.errors ?? [] });
    if (!this.mqtt?.write) throw new AppError("COMMAND_TRANSPORT_UNAVAILABLE", "MQTT command transport is unavailable", 503, "CONNECTOR");

    const now = new Date();
    const expiresAt = input?.expiresAt ? new Date(input.expiresAt) : new Date(now.getTime() + definition.timeoutSeconds * 1_000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) throw new AppError("COMMAND_EXPIRED", "Command expiry must be in the future", 422, "VALIDATION");
    const commandId = String(input?.commandId ?? `urn:uuid:${randomUUID()}`);
    if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(commandId)) throw new AppError("COMMAND_ID_INVALID", "commandId must be a UUID URN", 422, "VALIDATION");
    if (expiresAt.getTime() > now.getTime() + definition.timeoutSeconds * 1_000) throw new AppError("COMMAND_EXPIRY_TOO_LONG", "Command expiry exceeds the catalog timeout", 422, "VALIDATION");
    if (await this.store.has(commandId)) throw new AppError("COMMAND_ID_REUSED", "commandId has already been used", 409, "VALIDATION");
    const requestTopic = topicFromTemplate(this.config.requestTopicTemplate, twinId, commandId);
    const resultTopic = concreteResultTopic(this.config.resultTopic, twinId, commandId);
    let record: CommandRecord = {
      specVersion: "objectid.command.v1", commandId, twinId, interfaceId: catalog.interfaceId,
      command: { name, version, parameters }, requestedBy: { did: callerDid }, requestedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      proof: input?.proof,
      idempotencyKey: String(input?.idempotencyKey ?? commandId), correlationId: input?.correlationId ? String(input.correlationId) : undefined,
      status: "authorized", statusUpdatedAt: now.toISOString(), transport: { type: "mqtt", requestTopic, resultTopic, qos: 1 },
    };
    await this.store.put(record);
    await this.mqtt.write({ topic: requestTopic, payload: await this.signer.sign(record), qos: 1, retain: false });
    record = { ...record, status: "dispatched", statusUpdatedAt: new Date().toISOString() };
    return this.store.put(record);
  }

  async get(twinId: string, commandId: string) {
    const record = await this.store.get(twinId, commandId);
    if (!record) throw new AppError("COMMAND_NOT_FOUND", "Command was not found", 404, "VALIDATION");
    if (!finalStatuses.has(record.status) && new Date(record.expiresAt).getTime() <= Date.now()) return this.store.put({ ...record, status: "expired", statusUpdatedAt: new Date().toISOString() });
    return record;
  }

  list(twinId: string, limit?: number) { return this.store.list(twinId, limit); }

  private async acceptResult(message: any) {
    const value = message?.value ?? message;
    const commandId = String(value?.commandId ?? "");
    const twinId = String(value?.twinId ?? "");
    const status = String(value?.status ?? "") as CommandStatus;
    if (!commandId || !twinId || !["accepted", "executing", "succeeded", "failed", "rejected", "cancelled"].includes(status)) return;
    const record = await this.store.get(twinId, commandId);
    if (!record || finalStatuses.has(record.status)) return;
    await this.store.put({ ...record, status, statusUpdatedAt: new Date().toISOString(), result: value.result, error: value.error });
  }
}

function topicFromTemplate(template: string, twinId: string, commandId: string) {
  return template.replaceAll("{twinId}", twinId).replaceAll("{commandId}", commandId.replace(/^urn:uuid:/, ""));
}

function concreteResultTopic(filter: string, twinId: string, commandId: string) {
  const values = [twinId, commandId.replace(/^urn:uuid:/, "")];
  let index = 0;
  return filter.replace(/\+/g, () => values[index++] ?? "+");
}
