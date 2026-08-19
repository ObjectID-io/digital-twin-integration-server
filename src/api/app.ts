import express from "express";
import { randomBytes } from "node:crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import type { AppConfig } from "../config/types.js";
import { errorBody, AppError } from "../common/errors.js";
import { logger, redactSecrets } from "../common/logger.js";
import { ProviderObjectIdAdapter } from "../objectid/adapter.js";
import type { ObjectIdAdapter } from "../objectid/types.js";
import { EnvironmentCredentialProvider, FileCredentialProvider, requiredCredential, resolveCredentialReferences } from "../security/credentials.js";
import { authMiddleware, createAuthProvider } from "../security/auth.js";
import { TenantRegistry } from "../security/tenants.js";
import type { AccountingContext } from "../objectid/types.js";
import { idempotencyMiddleware, type IdempotencyStore } from "../security/idempotency.js";
import { createIdempotencyStore } from "../security/idempotencyFactory.js";
import { ProfileRegistry } from "../schemas/registry.js";
import { DatasetWindowAggregator } from "../twin/datasetAggregator.js";
import { TwinService } from "../twin/service.js";
import { DigitalThreadService } from "../thread/service.js";
import { IdentifierResolver } from "../resolver/service.js";
import { MaturityEngine } from "../maturity/engine.js";
import { MemoryQueue } from "../queue/memoryQueue.js";
import { IngestionWorker, type IngestionJob } from "../queue/ingestionWorker.js";
import { ConnectorRegistry } from "../connectors/registry.js";
import { ConnectorFactory } from "../connectors/factory.js";
import type { Subscription } from "../connectors/types.js";
import { openApiDocument } from "./openapi.js";
import { mqttMessageToDataset, mqttMessageToState, type MappedMqttMessage } from "../twin/mqttMapping.js";
import { TwinAction, TwinPolicyAuthorizer } from "../policy/engine.js";
import { StorageProviderFactory } from "../storage/storage-provider-factory.js";
import type { StorageRouter } from "../storage/storage-router.js";
import { ObjectIdTwinIndexer } from "../indexer/objectid.js";
import type { PaginationOptions } from "../indexer/types.js";
import { validateCompositionInput, validateIdentifierMappingInput, validateInterfaceInput } from "../twin/standardsValidation.js";
import { TwinRealtimeHub } from "../realtime/hub.js";
import { CommandService } from "../commands/service.js";
import { StorageRetentionService } from "../storage/retention.js";
import {
  policyDenied, queueDepth, registry as metricsRegistry, requestsTotal, requestDuration, threadFailures,
} from "../health/metrics.js";

export interface AppRuntime {
  app: express.Express;
  connectors: ConnectorRegistry;
  objectid: ObjectIdAdapter;
  idempotency: IdempotencyStore;
  queue: MemoryQueue<IngestionJob>;
  worker: IngestionWorker;
  aggregator: DatasetWindowAggregator;
  storage: StorageRouter;
  realtime: TwinRealtimeHub;
  startConnectors(): Promise<void>;
  startConnectorIngestion(): Promise<void>;
  ingestMqttMessage(message: MappedMqttMessage): Promise<void>;
  ingestConnectorMessage(message: MappedMqttMessage): Promise<void>;
  flushDatasets(): Promise<void>;
  stop(): Promise<void>;
}

export function createApp(config: AppConfig, adapter?: ObjectIdAdapter, sharedIdempotency?: IdempotencyStore): AppRuntime {
  const app = express();
  if (config.server.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: config.server.bodyLimitBytes }));
  app.use(rateLimit({ windowMs: 60_000, limit: config.security.rateLimitPerMinute, standardHeaders: true, legacyHeaders: false }));
  app.use((request, response, next) => {
    const end = requestDuration.startTimer({ method: request.method, route: request.path });
    response.on("finish", () => {
      end();
      requestsTotal.inc({ method: request.method, route: request.route?.path ?? request.path, status: response.statusCode });
      logger.info({ method: request.method, path: request.path, status: response.statusCode, subject: request.auth?.subject }, "http_request");
    });
    next();
  });

  const credentials = config.security.credentialProvider === "file"
    ? new FileCredentialProvider(config.security.credentialFile ?? "./secrets/credentials.json")
    : new EnvironmentCredentialProvider();
  const tenants = new TenantRegistry(config.security, credentials);
  const objectid = adapter ?? new ProviderObjectIdAdapter(config, undefined, credentials);
  const profiles = new ProfileRegistry(config.profiles.directory);
  const storage = new StorageProviderFactory(credentials).createRouter(config.storage);
  const twins = new TwinService(objectid, profiles, storage);
  const indexer = new ObjectIdTwinIndexer(objectid, config);
  const threads = new DigitalThreadService(indexer, config);
  const resolver = new IdentifierResolver(objectid, indexer);
  const maturity = new MaturityEngine(profiles, storage);
  const policy = new TwinPolicyAuthorizer(objectid, undefined, config.policy.cacheTtlMs);
  const queue = new MemoryQueue<IngestionJob>();
  const worker = new IngestionWorker(queue, objectid, config.queue);
  const connectors = new ConnectorRegistry();
  const connectorFactory = new ConnectorFactory();
  for (const connector of connectorFactory.createConfigured(config.connectors)) connectors.register(connector);
  const idempotency = sharedIdempotency ?? createIdempotencyStore(config);
  const subscriptions: Subscription[] = [];
  const aggregator = new DatasetWindowAggregator(
    config.dataset.aggregation.defaultWindowSeconds * 1_000,
    storage,
    async (_key, dataset) => {
      const twinId = String(dataset.twinId);
      const idempotencyKey = `dataset:${twinId}:${String(dataset.payloadHash)}`;
      const accounting = await connectorAccounting(String(dataset.tenantId ?? ""));
      await worker.enqueue(worker.createJob("ADD_DATASET", twinId, dataset, idempotencyKey, accounting));
    },
  );
  const auth = createAuthProvider(config, credentials, tenants);
  const realtime = new TwinRealtimeHub();
  const commands = new CommandService(config.commands, connectors.get("mqtt"));
  const retention = new StorageRetentionService(config.retention, storage, objectid);
  const renewalChecks = new Map<string, number>();

  app.get("/health", (_request, response) => response.json({ status: "ok", stateless: true, timestamp: new Date().toISOString() }));
  app.get("/ready", async (_request, response, next) => {
    try {
      const [objectIdReady, profilesReady, connectorHealth, storageHealth] = await Promise.all([
        objectid.isReady(), profiles.isReady(), connectors.health(), storage.health(),
      ]);
      const requiredConnectorsReady = Object.entries(config.connectors).every(([type, connectorConfig]) =>
        !connectorConfig.enabled || connectorConfig.required !== true || connectorHealth[type]?.healthy === true);
      const ready = objectIdReady && profilesReady && requiredConnectorsReady && storageHealth.requiredReady;
      response.status(ready ? 200 : 503).json({
        ready,
        dependencies: { objectid: objectIdReady, profiles: profilesReady, requiredConnectors: requiredConnectorsReady, storage: storageHealth.requiredReady },
        connectors: connectorHealth,
        storage: storageHealth.providers,
      });
    } catch (error) { next(error); }
  });
  app.get("/metrics", async (_request, response) => {
    queueDepth.set(queue.size());
    response.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
  });
  app.get("/openapi.json", (_request, response) => response.json(openApiDocument));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.post("/internal/testnet/free-subscriptions", async (request, response, next) => {
    try {
      const free = config.security.testnetFreeSubscriptions;
      if (config.objectid.network !== "testnet" || !free?.enabled) throw new AppError("OBJECTID_FREE_SUBSCRIPTION_DISABLED", "Free subscription onboarding is disabled", 404, "AUTHORIZATION");
      const expected = await requiredCredential(credentials, free.provisioningKeyCredential);
      if (request.header("x-provisioning-key") !== expected) throw new AppError("AUTH_INVALID_PROVISIONING_KEY", "Invalid provisioning key", 401, "AUTHORIZATION");
      const ownerDid = String(request.body?.ownerDid ?? "").toLowerCase();
      if (!/^did:iota:testnet:0x[0-9a-f]{64}$/.test(ownerDid)) throw new AppError("OBJECTID_OWNER_DID_INVALID", "A valid testnet owner DID is required", 422, "VALIDATION");
      const tenantId = `free-${ownerDid.slice(-16)}`;
      const customerId = tenantId;
      let accounting = await tenants.findByOwnerDid(ownerDid);
      let digest: string | undefined;
      if (!accounting) {
        if (!objectid.provisionFreeTestnetSubscription) throw new AppError("OBJECTID_SUBSCRIPTION_UNAVAILABLE", "Subscription provisioning is unavailable", 503, "OBJECTID");
        const created = await objectid.provisionFreeTestnetSubscription(ownerDid, customerId, free.periodDays);
        digest = created.digest;
        accounting = { tenantId, customerId, ownerDid, subscriptionId: created.subscriptionId };
      } else if (await tenants.isDynamic(ownerDid) && objectid.getSubscription && objectid.renewFreeTestnetSubscription) {
        const status = await objectid.getSubscription(accounting);
        if (!status.current && BigInt(status.periodEnd) <= BigInt(Date.now())) digest = (await objectid.renewFreeTestnetSubscription(accounting.subscriptionId, free.periodDays)).digest;
      }
      const apiKey = randomBytes(32).toString("hex");
      await tenants.saveDynamic(accounting, apiKey);
      response.status(digest ? 201 : 200).set("Cache-Control", "no-store").json({ ...accounting, apiKey, digest, plan: "base", free: true });
    } catch (error) { next(error); }
  });

  const api = express.Router();
  api.use(authMiddleware(auth));
  api.use(async (request, _response, next) => {
    try {
      const accounting = request.auth?.accounting; const free = config.security.testnetFreeSubscriptions;
      const now = Date.now(); const lastCheck = accounting ? renewalChecks.get(accounting.tenantId) ?? 0 : 0;
      if (accounting && free?.enabled && now - lastCheck >= 300_000 && await tenants.isDynamic(accounting.ownerDid) && objectid.getSubscription && objectid.renewFreeTestnetSubscription) {
        renewalChecks.set(accounting.tenantId, now);
        const status = await objectid.getSubscription(accounting);
        if (!status.current && BigInt(status.periodEnd) <= BigInt(Date.now())) await objectid.renewFreeTestnetSubscription(accounting.subscriptionId, free.periodDays);
      }
      next();
    } catch (error) { next(error); }
  });
  api.use(idempotencyMiddleware(idempotency, config.idempotency.ttlMs));
  api.get("/capabilities", (_request, response) => response.json({
    apiVersion: "v1",
    realtime: { supported: true, transport: "sse", encryptedPayloadPassthrough: true },
    commands: commands.capabilities(),
    retention: { enabled: config.retention.enabled, defaultDays: config.retention.defaultDays, ownerPolicySource: "configuration", slaReady: true },
  }));
  api.get("/subscription", async (request, response, next) => {
    try {
      if (!objectid.getSubscription) throw new AppError("OBJECTID_SUBSCRIPTION_UNAVAILABLE", "Subscription accounting is unavailable", 503, "OBJECTID");
      response.set("Cache-Control", "no-store").json(await objectid.getSubscription(request.auth?.accounting));
    } catch (error) { next(error); }
  });
  api.use("/twins/:id", async (request, _response, next) => {
    try { await assertTenantTwin(request, String(request.params.id)); next(); }
    catch (error) { next(error); }
  });
  api.get("/storage/retention/status", (_request, response) => response.set("Cache-Control", "no-store").json(retention.status()));
  api.get("/twins/:id/realtime/status", async (request, response, next) => {
    try {
      const latest = realtime.latest(request.params.id!);
      const health = await connectors.health();
      const sourceType = latest?.source.type;
      const connected = sourceType
        ? health[sourceType]?.healthy === true
        : ["mqtt", "opcua"].some((type) => health[type]?.healthy === true);
      response.json({
        available: connected,
        connected,
        hasData: Boolean(latest),
        lastMessageAt: latest ? new Date(latest.receivedAt).toISOString() : null,
        encrypted: latest?.encryption.encrypted ?? false,
        keyId: latest?.encryption.keyId ?? null,
      });
    } catch (error) { next(error); }
  });
  api.get("/twins/:id/realtime/latest", (request, response) => {
    const latest = realtime.latest(request.params.id!);
    if (!latest) return response.status(404).json({ error: { code: "REALTIME_DATA_UNAVAILABLE", message: "No realtime data is available for this Twin", category: "CONNECTOR" } });
    return response.set("Cache-Control", "no-store").json(latest);
  });
  api.get("/twins/:id/realtime/stream", (request, response) => {
    const twinId = request.params.id!;
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const latest = realtime.latest(twinId);
    if (latest) send("snapshot", latest);
    const unsubscribe = realtime.subscribe(twinId, (event) => send("telemetry", event));
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
    request.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });
  api.get("/twins/:id/command-catalog", async (request, response, next) => {
    try {
      await authorize(request, request.params.id!, TwinAction.ExecuteCommand);
      response.set("Cache-Control", "no-store").json(commands.catalog(request.params.id!));
    } catch (error) { next(error); }
  });
  api.get("/twins/:id/commands", async (request, response, next) => {
    try {
      await authorize(request, request.params.id!, TwinAction.ExecuteCommand);
      response.set("Cache-Control", "no-store").json(await commands.list(request.params.id!, Number(request.query.limit ?? 50)));
    } catch (error) { next(error); }
  });
  api.post("/twins/:id/commands", async (request, response, next) => {
    try {
      const twinId = request.params.id!;
      await authorize(request, twinId, TwinAction.ExecuteCommand);
      response.status(202).set("Cache-Control", "no-store").json(await commands.create(twinId, callerDid(request, config), request.body));
    } catch (error) { next(error); }
  });
  api.get("/twins/:id/commands/:commandId", async (request, response, next) => {
    try {
      await authorize(request, request.params.id!, TwinAction.ExecuteCommand);
      response.set("Cache-Control", "no-store").json(await commands.get(request.params.id!, request.params.commandId!));
    } catch (error) { next(error); }
  });
  api.get("/dids/:did/twins", async (request, response, next) => {
    try {
      if (request.auth?.accounting && request.params.did!.toLowerCase() !== request.auth.accounting.ownerDid.toLowerCase()) {
        throw new AppError("OBJECTID_TENANT_DID_MISMATCH", "The authenticated tenant may only enumerate its owner DID", 403, "AUTHORIZATION");
      }
      response.json(await twins.findTwinsByDid(request.params.did!));
    } catch (error) { next(error); }
  });
  api.get("/twins/:id", async (request, response, next) => { try { response.json(await twins.getTwin(request.params.id!)); } catch (error) { next(error); } });
  api.post("/twins", async (request, response, next) => { try { response.status(201).json(await twins.createProfiledTwin(request.body, request.auth?.accounting)); } catch (error) { next(error); } });
  api.get("/profiles", async (_request, response, next) => { try { response.json(await profiles.listProfiles()); } catch (error) { next(error); } });
  api.post("/profiles/:profileId/validate", async (request, response, next) => {
    try { response.json(await profiles.validateAgainstProfile(request.params.profileId!, request.body)); } catch (error) { next(error); }
  });
  api.post("/twins/:id/validate-profile", async (request, response, next) => {
    try { response.json(await twins.validateBoundProfile(request.params.id!, String(request.body.profile), request.body.payload)); } catch (error) { next(error); }
  });
  api.post("/twins/:id/states", mutation(TwinAction.PublishState, (id, body, accounting) => twins.publishState(id, body, accounting)));
  api.post("/twins/:id/datasets", mutation(TwinAction.AddDataset, (id, body, accounting) => twins.registerDataset(id, body, accounting)));
  api.post("/twins/:id/models", mutation(TwinAction.AddModel, (id, body, accounting) => twins.registerModel(id, body, accounting)));
  api.post("/twins/:id/interfaces", mutation(TwinAction.AddInterface, (id, body, accounting) => objectid.addInterface(id, validateInterfaceInput(body), accounting)));
  api.post("/twins/:id/compositions", mutation(TwinAction.ModifyComposition, (id, body, accounting) => objectid.createComposition(id, validateCompositionInput(body), accounting)));
  api.post("/twins/:id/identifier-mappings", mutation(TwinAction.ModifyIdentifierMapping, (id, body, accounting) => objectid.addIdentifierMapping(id, validateIdentifierMappingInput(body), accounting)));
  api.post("/twins/:id/maturity/assessments", mutation(TwinAction.CreateMaturityAssessment, async (id, body, accounting) => {
    const evidence = await maturity.prepareEvidence(id, body.evidence ?? []);
    return objectid.createMaturityAssessment(id, { ...body, evidence }, accounting);
  }));
  api.post("/twins/:id/events", async (request, response, next) => {
    const action = isMaintenanceEvent(request.body) ? TwinAction.EmitMaintenanceEvent : TwinAction.EmitBusinessEvent;
    try {
      await authorize(request, request.params.id!, action);
      response.status(202).json(await twins.registerBusinessEvent(request.params.id!, request.body, request.auth?.accounting));
    } catch (error) { next(error); }
  });
  api.get("/twins/:id/thread", async (request, response, next) => { try { response.json(await threads.getDigitalThread(request.params.id!, threadOptions(request.query))); } catch (error) { next(error); } });
  api.get("/twins/:id/thread/verify", async (request, response, next) => {
    try { const result = await threads.verifyDigitalThread(request.params.id!, threadOptions(request.query)); if (!result.valid) threadFailures.inc(); response.json(result); } catch (error) { next(error); }
  });
  api.get("/twins/:id/thread/verify/report", async (request, response, next) => {
    try { response.json(await threads.createEvidenceReport(request.params.id!, threadOptions(request.query))); } catch (error) { next(error); }
  });
  api.get("/indexer/checkpoint", async (_request, response, next) => { try { response.json(await indexer.getCheckpoint?.() ?? null); } catch (error) { next(error); } });
  api.get("/twins/:id/identifiers", async (request, response, next) => { try { response.json(await resolver.getTwinIdentifiers(request.params.id!)); } catch (error) { next(error); } });
  api.get("/resolve/:scheme/:value", async (request, response, next) => {
    try {
      const twinId = optionalTwinId(request.query.twinId);
      response.json(twinId ? await resolver.resolve(twinId, request.params.scheme!, request.params.value!) : await resolver.resolveGlobal(request.params.scheme!, request.params.value!));
    } catch (error) { next(error); }
  });
  api.get("/resolve/:sourceScheme/:value/to/:targetScheme", async (request, response, next) => {
    try {
      const twinId = optionalTwinId(request.query.twinId);
      response.json(twinId
        ? await resolver.resolveTo(twinId, request.params.sourceScheme!, request.params.value!, request.params.targetScheme!)
        : await resolver.resolveToGlobal(request.params.sourceScheme!, request.params.value!, request.params.targetScheme!));
    } catch (error) { next(error); }
  });
  api.post("/twins/:id/maturity/evaluate", async (request, response, next) => {
    try {
      const result = await maturity.evaluate(String(request.body.profile), request.body.evidence ?? [], String(request.params.id));
      if (String(request.query.commit) === "true") {
        const twinId = String(request.params.id);
        await authorize(request, twinId, TwinAction.CreateMaturityAssessment);
        const committed = await objectid.createMaturityAssessment(twinId, {
          assessmentModel: `${result.profileId}@${result.profileVersion}`, maturityLevel: result.level,
          immutableMetadata: JSON.stringify({
            score: result.score, profileId: result.profileId, profileVersion: result.profileVersion,
            engineVersion: result.engineVersion, inputIndicators: result.inputIndicators,
            evidenceHashes: result.evidenceHashes, evaluationHash: result.evaluationHash,
          }),
          indicators: result.indicators,
        });
        response.json({ ...result, committed });
      } else response.json(result);
    } catch (error) { next(error); }
  });
  api.post("/connectors/rest/fetch", async (request, response, next) => {
    try { response.json(await connectors.get("rest")!.read(request.body)); } catch (error) { next(error); }
  });
  app.use("/api/v1", api);

  app.use((_request, _response, next) => next(new AppError("NOT_FOUND", "Route not found", 404, "VALIDATION")));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const normalized = (error as any)?.type === "entity.too.large"
      ? new AppError("PAYLOAD_TOO_LARGE", "Request payload exceeds the configured limit", 413, "VALIDATION")
      : error;
    const mapped = errorBody(normalized);
    logger.error({ error: redactSecrets(error instanceof Error ? { message: error.message, stack: error.stack } : error) }, "request_failed");
    response.status(mapped.status).json(mapped.body);
  });

  function mutation(action: TwinAction, execute: (id: string, body: any, accounting?: AccountingContext) => Promise<unknown>) {
    return async (request: express.Request, response: express.Response, next: express.NextFunction) => {
      try {
        const twinId = String(request.params.id);
        await authorize(request, twinId, action);
        response.status(202).json(await execute(twinId, request.body, request.auth?.accounting));
      }
      catch (error) { next(error); }
    };
  }

  async function authorize(request: express.Request, twinId: string, action: TwinAction) {
    try { await policy.assertAllowed(twinId, callerDid(request, config), action); }
    catch (error) { if (error instanceof AppError && error.code === "TWIN_POLICY_DENIED") policyDenied.inc({ action }); throw error; }
  }

  async function assertTenantTwin(request: express.Request, twinId: string) {
    const accounting = request.auth?.accounting;
    if (!accounting) return;
    const twin = await objectid.getTwin(twinId) as any;
    const fields = twin?.data?.content?.fields ?? twin?.content?.fields ?? twin?.fields ?? twin ?? {};
    const rawSubscription = fields.subscription_id ?? fields.subscriptionId;
    const subscriptionId = typeof rawSubscription === "string"
      ? rawSubscription
      : String(rawSubscription?.id ?? rawSubscription?.bytes ?? rawSubscription?.value ?? "");
    if (subscriptionId.toLowerCase() !== accounting.subscriptionId.toLowerCase()) {
      throw new AppError("OBJECTID_TENANT_TWIN_MISMATCH", "The authenticated tenant cannot access this Twin", 403, "AUTHORIZATION", { tenantId: accounting.tenantId, twinId });
    }
  }

  async function ingestMqttMessage(message: MappedMqttMessage) {
    realtime.publish(message);
    if (message.mapping.mode === "dataset") {
      if (!config.dataset.aggregation.enabled) throw new AppError("DATASET_AGGREGATION_DISABLED", "Dataset aggregation is disabled", 422, "CONNECTOR");
      const mapped = mqttMessageToDataset(message);
      aggregator.ingest(mapped.key, mapped.value, mapped.metadata, mapped.observedAt, mapped.windowMs);
      return;
    }
    const mapped = mqttMessageToState(message);
    const source = message.topic ?? message.nodeId ?? "unknown";
    const key = `connector-state:${mapped.twinId}:${source}:${message.observedAt}`;
    const accounting = await connectorAccounting(String(message.mapping.tenantId ?? ""));
    await worker.enqueue(worker.createJob("PUBLISH_STATE", mapped.twinId, mapped.state, key, accounting));
  }

  async function connectorAccounting(tenantId: string) {
    if (tenantId) return tenants.get(tenantId);
    const fallback = await tenants.default();
    if (config.objectid.signer?.delegatedAccounts && !fallback) {
      throw new AppError("CONNECTOR_TENANT_REQUIRED", "Connector mappings require tenantId when delegated accounting is enabled", 500, "VALIDATION");
    }
    return fallback;
  }

  return {
    app, connectors, objectid, idempotency, queue, worker, aggregator, storage, realtime,
    async startConnectors() {
      await objectid.initialize?.();
      const resolved = await resolveCredentialReferences(config.connectors, credentials);
      await connectors.start(resolved as AppConfig["connectors"]);
      await commands.start();
      retention.start();
    },
    async startConnectorIngestion() {
      worker.start();
      for (const type of ["mqtt", "opcua"]) {
        if (!config.connectors[type]?.enabled) continue;
        const connector = connectors.get(type);
        if (connector?.subscribe) subscriptions.push(await connector.subscribe(async (data) => ingestMqttMessage(data as MappedMqttMessage)));
      }
    },
    ingestMqttMessage, ingestConnectorMessage: ingestMqttMessage,
    async flushDatasets() { await aggregator.close(); await worker.drain(config.dataset.aggregation.shutdownFlushTimeoutMs); },
    async stop() {
      await Promise.allSettled(subscriptions.splice(0).map((subscription) => subscription.close()));
      await withTimeout(aggregator.close(), config.dataset.aggregation.shutdownFlushTimeoutMs);
      await worker.stop();
      await retention.stop();
      await commands.stop();
      await connectors.stop();
      await indexer.close();
      await idempotency.close();
    },
  };
}

function optionalTwinId(value: unknown) { return typeof value === "string" && value ? value : undefined; }

function threadOptions(query: Record<string, unknown>): PaginationOptions {
  const number = (value: unknown) => value === undefined ? undefined : Number(value);
  return {
    cursor: optionalTwinId(query.cursor), limit: number(query.limit),
    fromRevision: number(query.fromRevision), toRevision: number(query.toRevision),
    eventTypes: typeof query.eventType === "string" ? query.eventType.split(",").map(Number).filter(Number.isFinite) : undefined,
    fromTimestamp: number(query.fromTimestamp ?? query.fromTime), toTimestamp: number(query.toTimestamp ?? query.toTime),
  };
}

function callerDid(request: express.Request, config: AppConfig) {
  if (request.auth?.accounting) return request.auth.accounting.ownerDid;
  const claims = request.auth?.claims;
  const delegated = request.header("x-objectid-caller-did");
  return String(claims?.did ?? (config.security.authMode !== "disabled" ? delegated : undefined) ?? claims?.sub ?? config.security.serviceDid ?? request.auth?.subject ?? "");
}

function isMaintenanceEvent(body: any) {
  const eventType = Number(body?.eventType ?? body?.event_type ?? 0);
  return body?.category === "maintenance" || [120, 121, 130].includes(eventType);
}

async function withTimeout(promise: Promise<unknown>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
