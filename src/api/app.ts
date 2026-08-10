import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import type { AppConfig } from "../config/types.js";
import { errorBody, AppError } from "../common/errors.js";
import { logger, redactSecrets } from "../common/logger.js";
import { ProviderObjectIdAdapter } from "../objectid/adapter.js";
import type { ObjectIdAdapter } from "../objectid/types.js";
import { EnvironmentCredentialProvider, FileCredentialProvider, resolveCredentialReferences } from "../security/credentials.js";
import { authMiddleware, createAuthProvider } from "../security/auth.js";
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
  const objectid = adapter ?? new ProviderObjectIdAdapter(config);
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
      await worker.enqueue(worker.createJob("ADD_DATASET", twinId, dataset, idempotencyKey));
    },
  );
  const auth = createAuthProvider(config, credentials);

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

  const api = express.Router();
  api.use(authMiddleware(auth));
  api.use(idempotencyMiddleware(idempotency, config.idempotency.ttlMs));
  api.get("/twins/:id", async (request, response, next) => { try { response.json(await twins.getTwin(request.params.id!)); } catch (error) { next(error); } });
  api.post("/twins", async (request, response, next) => { try { response.status(201).json(await twins.createProfiledTwin(request.body)); } catch (error) { next(error); } });
  api.get("/profiles", async (_request, response, next) => { try { response.json(await profiles.listProfiles()); } catch (error) { next(error); } });
  api.post("/profiles/:profileId/validate", async (request, response, next) => {
    try { response.json(await profiles.validateAgainstProfile(request.params.profileId!, request.body)); } catch (error) { next(error); }
  });
  api.post("/twins/:id/validate-profile", async (request, response, next) => {
    try { response.json(await twins.validateBoundProfile(request.params.id!, String(request.body.profile), request.body.payload)); } catch (error) { next(error); }
  });
  api.post("/twins/:id/states", mutation(TwinAction.PublishState, (id, body) => twins.publishState(id, body)));
  api.post("/twins/:id/datasets", mutation(TwinAction.AddDataset, (id, body) => twins.registerDataset(id, body)));
  api.post("/twins/:id/models", mutation(TwinAction.AddModel, (id, body) => twins.registerModel(id, body)));
  api.post("/twins/:id/interfaces", mutation(TwinAction.AddInterface, (id, body) => objectid.addInterface(id, validateInterfaceInput(body))));
  api.post("/twins/:id/compositions", mutation(TwinAction.ModifyComposition, (id, body) => objectid.createComposition(id, validateCompositionInput(body))));
  api.post("/twins/:id/identifier-mappings", mutation(TwinAction.ModifyIdentifierMapping, (id, body) => objectid.addIdentifierMapping(id, validateIdentifierMappingInput(body))));
  api.post("/twins/:id/maturity/assessments", mutation(TwinAction.CreateMaturityAssessment, async (id, body) => {
    const evidence = await maturity.prepareEvidence(id, body.evidence ?? []);
    return objectid.createMaturityAssessment(id, { ...body, evidence });
  }));
  api.post("/twins/:id/events", async (request, response, next) => {
    const action = isMaintenanceEvent(request.body) ? TwinAction.EmitMaintenanceEvent : TwinAction.EmitBusinessEvent;
    try {
      await authorize(request, request.params.id!, action);
      response.status(202).json(await twins.registerBusinessEvent(request.params.id!, request.body));
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

  function mutation(action: TwinAction, execute: (id: string, body: any) => Promise<unknown>) {
    return async (request: express.Request, response: express.Response, next: express.NextFunction) => {
      try {
        const twinId = String(request.params.id);
        await authorize(request, twinId, action);
        response.status(202).json(await execute(twinId, request.body));
      }
      catch (error) { next(error); }
    };
  }

  async function authorize(request: express.Request, twinId: string, action: TwinAction) {
    try { await policy.assertAllowed(twinId, callerDid(request, config), action); }
    catch (error) { if (error instanceof AppError && error.code === "TWIN_POLICY_DENIED") policyDenied.inc({ action }); throw error; }
  }

  async function ingestMqttMessage(message: MappedMqttMessage) {
    if (message.mapping.mode === "dataset") {
      if (!config.dataset.aggregation.enabled) throw new AppError("DATASET_AGGREGATION_DISABLED", "Dataset aggregation is disabled", 422, "CONNECTOR");
      const mapped = mqttMessageToDataset(message);
      aggregator.ingest(mapped.key, mapped.value, mapped.metadata, mapped.observedAt, mapped.windowMs);
      return;
    }
    const mapped = mqttMessageToState(message);
    const source = message.topic ?? message.nodeId ?? "unknown";
    const key = `connector-state:${mapped.twinId}:${source}:${message.observedAt}`;
    await worker.enqueue(worker.createJob("PUBLISH_STATE", mapped.twinId, mapped.state, key));
  }

  return {
    app, connectors, objectid, idempotency, queue, worker, aggregator, storage,
    async startConnectors() {
      const resolved = await resolveCredentialReferences(config.connectors, credentials);
      await connectors.start(resolved as AppConfig["connectors"]);
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
  const claims = request.auth?.claims;
  return String(claims?.did ?? claims?.sub ?? config.security.serviceDid ?? request.auth?.subject ?? "");
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
