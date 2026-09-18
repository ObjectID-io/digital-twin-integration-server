import { twinManagementAuth } from '../sharing/management-auth.js';
import { policyRights } from '../sharing/policy.js';
import { TwinSharing } from '../sharing/service.js';
import { sharingRoutes } from '../sharing/routes.js';
import { SharedDatasets, DATASET_LIMITS } from '../sharing/datasets.js';
import { DatasetSigner } from '../sharing/dataset-signing.js';
import express from "express";
import {myTwinRoutes} from "../devices/my-twins.js";
import { DeviceWorkbench } from "../devices/service.js";
import { deviceRoutes, workbenchSession } from "../devices/routes.js";
import {DeviceDidAuth,deviceDidRoutes} from "../devices/did-auth.js";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import type { AppConfig } from "../config/types.js";
import { errorBody, AppError } from "../common/errors.js";
import { logger, redactSecrets } from "../common/logger.js";
import { ProviderObjectIdAdapter } from "../objectid/adapter.js";
import type { ObjectIdAdapter } from "../objectid/types.js";
import { EnvironmentCredentialProvider, FileCredentialProvider, requiredCredential, resolveCredentialReferences } from "../security/credentials.js";
import { createAuthProvider } from "../security/auth.js";
import { TenantRegistry, type TenantCredentialStatus } from "../security/tenants.js";
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
import { TwinRealtimeHub, type TwinRealtimeEvent } from "../realtime/hub.js";
import { AiAnalysisConnector } from "../connectors/ai-analysis.js";
import { TenantModules, moduleRoutes } from "../security/modules.js";
import { objectIdTwinPublicAccess } from "../twin/publicVisibility.js";
import { CommandService } from "../commands/service.js";
import { StorageRetentionService } from "../storage/retention.js";
import { TwinEvidenceService } from "../evidence/service.js";
import { PlantService, plantCatalogDirectory } from "../plants/service.js";
import { plantRoutes } from "../plants/routes.js";
import { PlantTwinCreation, verifyCreationAssertion } from "../plants/twin-creation.js";
import { locateTwinPlant } from "../plants/twin-membership.js";
import { validatePlantBindings } from "../plants/association.js";
import { connectionRoutes } from "../plants/connections.js";
import { FileService, MAX_FILE_BYTES, fileCatalogDirectory } from "../files/service.js";
import { fileRoutes } from "../files/routes.js";
import {
  policyDenied, queueDepth, registry as metricsRegistry, requestsTotal, requestDuration, threadFailures,
} from "../health/metrics.js";
import { buildSystemStatus, type ReadinessSnapshot } from "../health/status.js";

const REALTIME_STALE_AFTER_MS = 60_000;
const CONNECTOR_TWIN_AUTH_CACHE_MS = 60_000;

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
  app.use("/api/plants", express.json({ limit: "32mb" }));
  app.use("/api/v1/twins/:id/evidence-bundles/validate", express.json({ limit: "4mb" }));
  const jsonBody = express.json({ limit: config.server.bodyLimitBytes });
  // File bodies are binary, including JSON files, and parsed only after authentication.
  app.use((request, response, next) => /^\/api\/v1\/files(?:\/|$)/i.test(request.path) ? next() : jsonBody(request, response, next));
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
  const plantService = new PlantService(storage, credentials, plantCatalogDirectory(config));
  app.use("/api/plants", plantRoutes(plantService, credentials, (tenantId,ownerDid,plantId,document)=>validatePlantBindings(plantService,credentials,id=>objectid.getTwin(id),tenantId,ownerDid,plantId,document)));
  app.use("/api/plant-connections", connectionRoutes(new PlantService(storage, credentials, resolve(plantCatalogDirectory(config), "connections")), credentials));
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
  const plantTwins = new PlantTwinCreation(plantService, twins, objectid, tenants);
  const deviceApiUrl = String(config.security.tenantProvisioning?.publicApiUrl || "").replace(/\/api\/v1\/?$/, "").replace(/\/$/,"");
  const deviceTopicPrefix = String(config.security.tenantProvisioning?.topicPrefix || "objectid/tenants").replace(/\/$/,"");
  const deviceWorkbench = new DeviceWorkbench(new PlantService(storage, credentials, resolve(plantCatalogDirectory(config),"devices")), tenants,
    async (body, context, prepareOnly) => {
      const pattern = config.objectid.network === "mainnet" ? /^did:iota:0x[0-9a-f]{64}$/i : new RegExp(`^did:iota:${escapeRegExp(config.objectid.network)}:0x[0-9a-f]{64}$`,"i");
      if (!pattern.test(context.ownerDid) || !pattern.test(context.requesterDid)) throw new AppError("DID_NETWORK_MISMATCH","Device owner and requester must belong to this network",403,"AUTHORIZATION");
      if (!config.objectid.signer?.enabled || !config.objectid.signer.delegatedAccounts) throw new AppError("DELEGATED_SIGNER_REQUIRED","Subscription-owner signing mode required",503,"AUTHORIZATION");
      if (context.source === "twinscope") return plantTwins.delegated(body, context as Parameters<PlantTwinCreation["delegated"]>[1],undefined,prepareOnly);
      const accounting = await tenants.findByOwnerDid(context.ownerDid);
      return plantTwins.personal(body,context.requesterDid,accounting,prepareOnly);
    }, ingestMqttMessage, { network:config.objectid.network, apiUrl:deviceApiUrl,
      mqttUrl:config.security.tenantProvisioning?.mqtt?.publicUrl || "",topicPrefix:deviceTopicPrefix,
      mqttEnabled:Boolean(config.connectors.mqtt?.enabled && config.security.tenantProvisioning?.mqtt),
      verifyStorageTwin:async(id,storageOwner)=>{
        const accounting = await tenants.findByOwnerDid(storageOwner);
        if (!accounting) return false;
        try { await assertAccountingTwin(accounting,id); return true; } catch { return false; }
      },
      verifyTwin:async(id,ownerDid)=>{try{const raw:any=await objectid.getTwin(id);const fields=raw?.data?.content?.fields ?? raw?.content?.fields ?? raw?.fields;return fields?.owner_did===ownerDid;}catch(error){if(error instanceof AppError && error.code==="OBJECTID_TWIN_PACKAGE_MISMATCH")return false;throw error;}},
      membership:async(id,ownerDid)=>{const accounting=await tenants.findByOwnerDid(ownerDid);if(!accounting)throw new AppError('SUBSCRIPTION_REQUIRED','Owner account required',403,'AUTHORIZATION');return locateTwinPlant(plantService,credentials,id,await objectid.getTwin(id),accounting);}
    });
  const deviceDidAuth=new DeviceDidAuth(config.objectid.network,deviceApiUrl,credentials,config.objectid.rpcUrl);
  const moduleSettings = new TenantModules(resolve(plantCatalogDirectory(config), "tenant-modules.json"));
  app.use("/api/modules", moduleRoutes(deviceDidAuth, tenants, moduleSettings, (tenant, module) => {
    if (module === "commands") return config.commands.enabled;
    if (module === "ai") return Boolean(config.connectors.ai?.enabled && (config.connectors.ai.scopes as {tenantId: string}[] | undefined)?.some(s => s.tenantId === tenant));
    return Boolean(config.connectors.rest?.enabled);
  }, (tenant, module, enabled) => {
    const ai = connectors.get("ai");
    if (module === "ai" && ai instanceof AiAnalysisConnector) ai.setTenantEnabled(tenant, enabled);
  }));
  app.use("/api/device-auth",deviceDidRoutes(deviceDidAuth,tenants));
  app.use("/api/tenant-access",tenantAccessRoutes(deviceDidAuth,tenants,async did=>{
    const accounting=await tenants.findByOwnerDid(did);
    return Boolean(accounting && objectid.getSubscription && (await objectid.getSubscription(accounting)).current);
  },{network:config.objectid.network,apiUrl:deviceApiUrl,mqttUrl:config.security.tenantProvisioning?.mqtt?.publicUrl}));
  const twinManagementBusy=new Set<string>();
  async function managePersonalTwin(did:string,id:string,action:TwinAction,execute:(accounting:AccountingContext,fields:any)=>Promise<unknown>) {
    if(twinManagementBusy.has(id))throw new AppError("TWIN_BUSY","Another operation is in progress",409,"VALIDATION");
    twinManagementBusy.add(id);
    try {
      const accounting=await tenants.findByOwnerDid(did);
      if(!accounting)throw new AppError("SUBSCRIPTION_REQUIRED","Subscription account required",402,"AUTHORIZATION");
      const raw:any=await objectid.getTwin(id),fields=raw?.data?.content?.fields ?? raw?.content?.fields ?? raw?.fields ?? raw;
      if(fields?.owner_did!==did)throw new AppError("TWIN_NOT_OWNED","Only the current owner may manage this Twin",403,"AUTHORIZATION");
      await assertAccountingTwin(accounting,id);await policy.assertAllowed(id,did,action);
      return await execute(accounting,fields);
    } finally {twinManagementBusy.delete(id);}
  }
  app.use("/api/my-twins",myTwinRoutes(deviceDidAuth,{
    credentials:(did,id,action)=>managePersonalTwin(did,id,TwinAction.ModifyMetadata,async accounting=>{
      if(action==="rotate"&&(!objectid.getSubscription||!(await objectid.getSubscription(accounting)).current))throw new AppError("OBJECTID_SUBSCRIPTION_INACTIVE","Active subscription required",402,"AUTHORIZATION");
      return deviceWorkbench.deviceCredentials({ownerDid:did,requesterDid:did,source:"dt",tenantId:null},id,action);
    }),
    list:async did=>{
      const devices=await deviceWorkbench.list({ownerDid:did,requesterDid:did,source:"dt",tenantId:null});
      return (await twins.findTwinsByDid(did)).filter(t=>t.roles.includes("owner")).map(t=>({...t,canExport:devices.some(d=>d.twinId===t.twinId&&d.state==="created")}));
    },
    exportConfig:async(did,id)=>{
      const context={ownerDid:did,requesterDid:did,source:"dt" as const,tenantId:null};
      const device=(await deviceWorkbench.list(context)).find(d=>d.twinId===id&&d.state==="created");
      if(!device)throw new AppError("TWIN_EXPORT_UNAVAILABLE","No classified device configuration exists for this Twin",404,"VALIDATION");
      return deviceWorkbench.export(context,device.id);
    },
    edit:(did,id,input)=>managePersonalTwin(did,id,TwinAction.ModifyMetadata,(accounting,fields)=>twins.updateTwin(id,{...input,mutableMetadata:fields.mutable_metadata ?? fields.mutableMetadata ?? ""},accounting)),
    remove:(did,id)=>managePersonalTwin(did,id,TwinAction.DeleteTwin,async accounting=>{
      if(!objectid.deleteTwin)throw new AppError("OBJECTID_DELETE_UNAVAILABLE","Deletion unavailable",503,"OBJECTID");
      const receipt=await objectid.deleteTwin(id,accounting);
      let cleanupPending=false;
      try {
        if(await tenants.isDynamic(did))await tenants.revokeTwinCredentials(did,id);
        const context={ownerDid:did,requesterDid:did,source:"dt" as const,tenantId:null};
        for(const device of await deviceWorkbench.list(context))if(device.twinId===id)await deviceWorkbench.revoke(context,device.id);
      } catch {cleanupPending=true;}
      return {receipt,cleanupPending};
    })
  }));
  app.use("/api/device-workbench", deviceRoutes(deviceWorkbench,credentials,deviceDidAuth));
  app.post("/internal/device-workbench/session",async(request,response,next)=>{
    try {
      const { ownerDid }=await assertTenantProvisioningRequest(request,request.body?.ownerDid);
      if(!await tenants.findByOwnerDid(ownerDid)) throw new AppError("SUBSCRIPTION_REQUIRED","Subscription account required",402,"AUTHORIZATION");
      response.set("Cache-Control","no-store").json({...await workbenchSession({ownerDid,requesterDid:ownerDid,source:"dt",tenantId:null},credentials),url:deviceApiUrl+"/devices"});
    }catch(error){next(error);}
  });
  app.post("/api/plants/device-workbench/session",async(request,response,next)=>{
    try {
      const context=await verifyCreationAssertion(request.header("x-twinscope-creation"),request.body,request.header("idempotency-key"),credentials);
      const suppliedKey=request.header("x-api-key");
      const account=suppliedKey ? await tenants.authenticateApiKey(suppliedKey) : undefined;
      if(suppliedKey && account?.ownerDid!==context.ownerDid) throw new AppError("PLANT_CONNECTION_OWNER_MISMATCH","Connection must belong to the plant owner",403,"AUTHORIZATION");
      response.set("Cache-Control","no-store").json({...await workbenchSession(context,credentials),url:deviceApiUrl+"/devices"});
    }catch(error){next(error);}
  });
  app.post("/device-input/:tenantId/:deviceId",async(request,response,next)=>{
    try {
      await deviceWorkbench.ingest(String(request.params.tenantId),String(request.params.deviceId),request.body,
        /^Bearer (\S+)$/.exec(request.header("authorization")||"")?.[1]);
      response.status(202).json({accepted:true});
    }catch(error){next(error);}
  });
  app.post("/api/plants/twins", async (request, response, next) => {
    try {
      const context = await verifyCreationAssertion(request.header("x-twinscope-creation"), request.body, request.header("idempotency-key"), credentials);
      const didPattern = config.objectid.network === "mainnet" ? /^did:iota:0x[0-9a-f]{64}$/i : new RegExp(`^did:iota:${escapeRegExp(config.objectid.network)}:0x[0-9a-f]{64}$`, "i");
      if (!didPattern.test(context.ownerDid) || !didPattern.test(context.requesterDid)) throw new AppError("DID_NETWORK_MISMATCH", "The requester and plant owner must belong to this IS network", 403, "AUTHORIZATION");
      if (!config.objectid.signer?.enabled || !config.objectid.signer.delegatedAccounts) throw new AppError("DELEGATED_SIGNER_REQUIRED", "Plant creation requires the subscription-owner signing mode", 503, "AUTHORIZATION");
      const suppliedKey = request.header("x-api-key");
      const accounting = suppliedKey ? await tenants.authenticateApiKey(suppliedKey) : undefined;
      if (suppliedKey && !accounting) throw new AppError("AUTH_INVALID_API_KEY", "Invalid tenant connection key", 401, "AUTHORIZATION");
      response.locals.creationContext = context;
      response.locals.creationAccounting = accounting;
      request.headers["idempotency-key"] = `plant-create:${context.tenantId}:${context.requesterDid}:${request.header("idempotency-key")}`;
      next();
    } catch (error) { next(error); }
  }, idempotencyMiddleware(idempotency), async (request, response, next) => {
    try { response.status(201).set("Cache-Control", "no-store").json(await plantTwins.delegated(request.body, response.locals.creationContext, response.locals.creationAccounting)); }
    catch (error) { next(error); }
  });
  const subscriptions: Subscription[] = [];
  const aggregator = new DatasetWindowAggregator(
    config.dataset.aggregation.defaultWindowSeconds * 1_000,
    storage,
    async () => { /* Operational windows remain off-chain until an authenticated export creates one Dataset snapshot. */ },
  );
  const auth = createAuthProvider(config, credentials, tenants);
  const realtime = new TwinRealtimeHub();
  const commands = new CommandService(config.commands, connectors.get("mqtt"));
  const retention = new StorageRetentionService(config.retention, storage, objectid);
  const evidence = new TwinEvidenceService(objectid, storage, config);
  const sharing = new TwinSharing({ network: config.objectid.network, packageId: config.objectid.packageId, accessPackageId: config.objectid.accessPackageId, rpcUrl: config.objectid.rpcUrl,
    decodePayload: async (_owner, id, payload) => {
      const raw:any = await objectid.getTwin(id), f = raw?.data?.content?.fields ?? raw?.content?.fields ?? raw?.fields ?? raw;
      const accounting = await tenants.findBySubscriptionId(String(f.subscription_id));
      if (!accounting) throw new AppError('SHARED_SOURCE_UNAVAILABLE','Storage account unavailable',409,'AUTHORIZATION');
      return deviceWorkbench.decodeSharedPayload(accounting.ownerDid, id, payload);
    },
    publicUrl: deviceApiUrl, directory: process.env.DTIS_SHARING_DIRECTORY || '/data/twin-sharing', credentials, objectid });
  const datasetSigner = new DatasetSigner({ issuer: deviceApiUrl, network: config.objectid.network,
    keyFile: process.env.DTIS_DATASET_SIGNING_KEY_FILE || resolve(sharing.options.directory, 'dataset-signing-key.json') });
  const sharedDatasets = new SharedDatasets(sharing, storage, () => Date.now(), datasetSigner);
  app.get('/.well-known/objectid-dataset-keys.json', async (_q, r) => {
    r.set('Cache-Control', 'no-store').json({ format: 'objectid.dataset-signers.v1', keys: [await datasetSigner.publicIdentity()] });
  });
  app.use('/api/v1/shared/twins', sharingRoutes(sharing, realtime, sharedDatasets));
  const publicAccessCache = new Map<string, { checkedAt: number; twinPublic: boolean; dataPublic: boolean; liveLocationPublic: boolean }>();
  const connectorTwinAuthCache = new Map<string, { subscriptionId: string; expiresAt: number }>();
  const connectorTwinAuthInflight = new Map<string, Promise<void>>();
  const consoleDirectory = resolve(process.cwd(), "console");

  async function inspectReadiness(): Promise<ReadinessSnapshot> {
    const [objectIdReady, profilesReady, connectorHealth, storageHealth] = await Promise.all([
      objectid.isReady(), profiles.isReady(), connectors.health(), storage.health(),
    ]);
    const requiredConnectorsReady = Object.entries(config.connectors).every(([type, connectorConfig]) =>
      !connectorConfig.enabled || connectorConfig.required !== true || connectorHealth[type]?.healthy === true);
    const ready = objectIdReady && profilesReady && requiredConnectorsReady && storageHealth.requiredReady;
    return {
      ready,
      dependencies: { objectid: objectIdReady, profiles: profilesReady, requiredConnectors: requiredConnectorsReady, storage: storageHealth.requiredReady },
      connectors: connectorHealth,
      storage: storageHealth,
    };
  }

  app.use("/console-assets", express.static(consoleDirectory, { index: false, maxAge: 0 }));
  // Explicit empty fragment prevents an old workbench token being forwarded.
  app.get(["/devices","/my-twins"],(_request,response)=>response.redirect(303,(config.objectid.network==="mainnet"?"https://dt.objectid.io/":"https://dt-demo.objectid.io/")+"#"));
  app.get("/tenant",(_request,response)=>response.sendFile(resolve(consoleDirectory,"tenant.html")));
  app.get(["/", "/status"], (_request, response, next) => {
    response.sendFile(resolve(consoleDirectory, "index.html"), (error) => { if (error) next(error); });
  });

  app.get("/health", (_request, response) => response.json({ status: "ok", stateless: true, timestamp: new Date().toISOString() }));
  app.get("/ready", async (_request, response, next) => {
    try {
      const snapshot = await inspectReadiness();
      response.status(snapshot.ready ? 200 : 503).json({
        ready: snapshot.ready,
        dependencies: snapshot.dependencies,
        connectors: snapshot.connectors,
        storage: snapshot.storage.providers,
      });
    } catch (error) { next(error); }
  });
  app.get("/status.json", async (_request, response, next) => {
    try {
      queueDepth.set(queue.size());
      response.set("Cache-Control", "no-store").json(buildSystemStatus({
        config,
        readiness: await inspectReadiness(),
        metricsText: await metricsRegistry.metrics(),
        queueDepth: queue.size(),
        retention: retention.status(),
      }));
    } catch (error) { next(error); }
  });
  app.get("/metrics", async (_request, response) => {
    queueDepth.set(queue.size());
    response.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
  });
  app.get("/openapi.json", (_request, response) => response.json(openApiDocument));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.get("/api/v1/public/twins/:id/realtime/status", async (request, response, next) => {
    try {
      const twinId = await assertPublicTwinAccess(request.params.id, true);

      const health = await connectors.health();
      response.set("Cache-Control", "no-store").json(realtime.status(twinId, health, REALTIME_STALE_AFTER_MS));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/public/twins/:id/realtime/latest", async (request, response, next) => {
    try {
      const twinId = await assertPublicTwinAccess(request.params.id, true);
      const latest = realtime.latest(twinId);
      if (!latest) throw new AppError("REALTIME_DATA_UNAVAILABLE", "No public realtime data is available for this Twin", 404, "CONNECTOR");
      response.set("Cache-Control", "no-store").json(await sharing.filteredPublicRealtime(twinId, publicRealtimeEvent(latest)));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/public/twins/:id/location/latest", async (request, response, next) => {
    try {
      const twinId = await assertPublicTwinAccess(request.params.id, "location");
      const latest = realtime.latest(twinId);
      if (!latest?.position) throw new AppError("REALTIME_POSITION_UNAVAILABLE", "No public live position is available for this Twin", 404, "CONNECTOR");
      response.set("Cache-Control", "no-store").json(publicPositionEvent(latest));
    } catch (error) { next(error); }
  });

  app.get("/api/v1/public/twins/:id/realtime/stream", async (request, response, next) => {
    try {
      const twinId = await assertPublicTwinAccess(request.params.id, true);
      response.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      let open = true;
      const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const latest = realtime.latest(twinId);
      if (latest) send("snapshot", await sharing.filteredPublicRealtime(twinId, publicRealtimeEvent(latest)));
      const ensureAccess = async () => {
        try { await assertPublicTwinAccess(twinId, true); return true; }
        catch { if (open) response.end(); return false; }
      };
      const unsubscribe = realtime.subscribe(twinId, (event) => {
        void ensureAccess().then(async (allowed) => { if (!allowed || !open) return; const filtered = await sharing.filteredPublicRealtime(twinId, publicRealtimeEvent(event)); if (open) send("telemetry", filtered); }).catch(() => response.end());
      });
      const heartbeat = setInterval(() => {
        void ensureAccess().then((allowed) => { if (allowed && open) response.write(": heartbeat\n\n"); });
      }, 10_000);
      request.on("close", () => { open = false; clearInterval(heartbeat); unsubscribe(); });
    } catch (error) { next(error); }
  });

  app.post("/internal/integration-accounts", async (request, response, next) => {
    try {
      const { provisioning, ownerDid } = await assertTenantProvisioningRequest(request, request.body?.ownerDid);
      const subscriptionId = String(request.body?.subscriptionId ?? "").toLowerCase();
      const customerId = String(request.body?.customerId ?? "").trim();
      if (!/^0x[0-9a-f]{64}$/.test(subscriptionId) || !/^[a-z0-9._-]{1,128}$/i.test(customerId)) {
        throw new AppError("OBJECTID_SUBSCRIPTION_REGISTRATION_INVALID", "A valid subscription ID and customer ID are required", 422, "VALIDATION");
      }
      const tenantId = `${config.objectid.network}-${ownerDid.slice(-16)}`;
      const accounting = { tenantId, customerId, ownerDid, subscriptionId };
      if (!objectid.getSubscription) throw new AppError("OBJECTID_SUBSCRIPTION_UNAVAILABLE", "Subscription accounting is unavailable", 503, "OBJECTID");
      const subscription = await objectid.getSubscription(accounting);
      if (!subscription.current) throw new AppError("OBJECTID_SUBSCRIPTION_INACTIVE", "The on-chain subscription is not active", 402, "AUTHORIZATION");
      const apiKey = randomBytes(32).toString("hex");
      await tenants.saveDynamic(accounting, apiKey);
      response.status(201).set("Cache-Control", "no-store").json({
        ...accounting, apiKey, network: config.objectid.network, plan: subscription.plan.name,
        provisioning: { publicApiUrl: provisioning.publicApiUrl, mqttUrl: provisioning.mqtt?.publicUrl },
      });
    } catch (error) { next(error); }
  });

  app.get("/internal/integration-credentials", async (request, response, next) => {
    try {
      const { provisioning, ownerDid } = await assertTenantProvisioningRequest(request, request.query.ownerDid);
      response.set("Cache-Control", "no-store").json(credentialStatusResponse(await tenants.credentialStatus(ownerDid), provisioning, config.objectid.network));
    } catch (error) { next(error); }
  });

  app.post("/internal/integration-credentials/rotate", async (request, response, next) => {
    try {
      const { provisioning, ownerDid } = await assertTenantProvisioningRequest(request, request.body?.ownerDid);
      const accounting = await tenants.findByOwnerDid(ownerDid);
      if (!accounting || !await tenants.isDynamic(ownerDid)) throw new AppError("AUTH_TENANT_UNKNOWN", "A registered on-chain subscription is required", 404, "AUTHORIZATION");
      if (!objectid.getSubscription || !(await objectid.getSubscription(accounting)).current) throw new AppError("OBJECTID_SUBSCRIPTION_INACTIVE", "The on-chain subscription is not active", 402, "AUTHORIZATION");
      const summaries = await objectid.findTwinsByDid(ownerDid);
      const twinIds: string[] = [];
      for (const summary of summaries) {
        try { await assertAccountingTwin(accounting, summary.twinId); twinIds.push(summary.twinId.toLowerCase()); }
        catch (error) { if (!(error instanceof AppError) || error.code !== "OBJECTID_TENANT_TWIN_MISMATCH") throw error; }
      }
      const apiKey = randomBytes(32).toString("hex");
      const mqttPassword = randomBytes(32).toString("base64url");
      const mqttUsername = `oid_${config.objectid.network}_${accounting.tenantId.replace(/[^a-z0-9_-]/gi, "_")}`;
      const status = await tenants.rotateExternalCredentials(ownerDid, apiKey, mqttUsername, mqttPassword, twinIds);
      response.set("Cache-Control", "no-store").json({
        ...credentialStatusResponse(status, provisioning, config.objectid.network), oneTime: true, apiKey, mqttPassword,
      });
    } catch (error) { next(error); }
  });

  app.delete("/internal/integration-credentials", async (request, response, next) => {
    try {
      const { provisioning, ownerDid } = await assertTenantProvisioningRequest(request, request.body?.ownerDid);
      response.set("Cache-Control", "no-store").json(credentialStatusResponse(await tenants.revokeExternalCredentials(ownerDid), provisioning, config.objectid.network));
    } catch (error) { next(error); }
  });

  app.get("/internal/twin-credentials", async (request, response, next) => {
    try {
      const { provisioning, ownerDid } = await assertTenantProvisioningRequest(request, request.query.ownerDid);
      const twinId = requiredProvisioningTwinId(request.query.twinId);
      const accounting = await tenants.findByOwnerDid(ownerDid);
      if (!accounting || !await tenants.isDynamic(ownerDid)) throw new AppError("AUTH_TENANT_UNKNOWN", "A registered on-chain subscription is required", 404, "AUTHORIZATION");
      await assertAccountingTwin(accounting, twinId);
      response.set("Cache-Control", "no-store").json(deviceCredentialResponse(await tenants.twinCredentialStatus(ownerDid, twinId), provisioning, config.objectid.network));
    } catch (error) { next(error); }
  });

  app.post("/internal/twin-credentials/rotate", async (request, response, next) => {
    try {
      const { provisioning, ownerDid } = await assertTenantProvisioningRequest(request, request.body?.ownerDid);
      const twinId = requiredProvisioningTwinId(request.body?.twinId);
      const accounting = await tenants.findByOwnerDid(ownerDid);
      if (!accounting || !await tenants.isDynamic(ownerDid)) throw new AppError("AUTH_TENANT_UNKNOWN", "A registered on-chain subscription is required", 404, "AUTHORIZATION");
      if (!objectid.getSubscription || !(await objectid.getSubscription(accounting)).current) throw new AppError("OBJECTID_SUBSCRIPTION_INACTIVE", "The on-chain subscription is not active", 402, "AUTHORIZATION");
      await assertAccountingTwin(accounting, twinId);
      const mqttPassword = randomBytes(32).toString("base64url");
      const mqttUsername = `oid_device_${config.objectid.network}_${accounting.tenantId.replace(/[^a-z0-9_-]/gi, "_")}_${twinId.slice(2, 10)}`;
      const status = await tenants.rotateTwinCredentials(ownerDid, twinId, mqttUsername, mqttPassword);
      response.set("Cache-Control", "no-store").json({
        ...deviceCredentialResponse(status, provisioning, config.objectid.network), oneTime: true, mqttPassword,
      });
    } catch (error) { next(error); }
  });

  app.delete("/internal/twin-credentials", async (request, response, next) => {
    try {
      const { provisioning, ownerDid } = await assertTenantProvisioningRequest(request, request.body?.ownerDid);
      const twinId = requiredProvisioningTwinId(request.body?.twinId);
      const accounting = await tenants.findByOwnerDid(ownerDid);
      if (!accounting || !await tenants.isDynamic(ownerDid)) throw new AppError("AUTH_TENANT_UNKNOWN", "A registered on-chain subscription is required", 404, "AUTHORIZATION");
      await assertAccountingTwin(accounting, twinId);
      response.set("Cache-Control", "no-store").json(deviceCredentialResponse(await tenants.revokeTwinCredentials(ownerDid, twinId), provisioning, config.objectid.network));
    } catch (error) { next(error); }
  });

  const api = express.Router();
  api.use(twinManagementAuth(auth, sharing, tenants));
  api.get('/twins/:id/data-access', async (request, response) => {
    const id = sharing.id(request.params.id); await assertTenantTwin(request, id);
    response.set('Cache-Control', 'no-store').json(await sharing.policy(id, callerDid(request, config)));
  });
  api.put('/twins/:id/data-access', async (request, response) => {
    const id = sharing.id(request.params.id); await assertTenantTwin(request, id);
    response.set('Cache-Control', 'no-store').json(await sharing.update(id, callerDid(request, config), request.body, request.auth?.accounting));
  });
  api.post("/device-workbench/session",async(request,response,next)=>{
    try {
      const ownerDid=request.auth?.accounting?.ownerDid;
      if(!ownerDid||request.auth?.subject!==ownerDid) throw new AppError("DID_OWNER_REQUIRED","Tenant owner required",403,"AUTHORIZATION");
      response.set("Cache-Control","no-store").json({...await workbenchSession({ownerDid,requesterDid:ownerDid,source:"dt",tenantId:null},credentials),url:deviceApiUrl+"/devices"});
    }catch(error){next(error);}
  });
  api.use("/files", fileRoutes(new FileService(storage, credentials, fileCatalogDirectory(config)), config.security.authMode));
  api.get("/capabilities", (_request, response) => response.json({
    apiVersion: "v1",
    files: { supported: true, maxFileBytes: MAX_FILE_BYTES, encryption: "AES-256-GCM", access: "tenant-owner", immutable: true },
    realtime: { supported: true, transport: "sse", encryptedPayloadPassthrough: true },
    sharedDatasets: { supported: true, access: 'did-session-and-explicit-storage-permission', formats: ['csv', 'json'], archive: 'zip', ...DATASET_LIMITS },
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
    try {
      const id = String(request.params.id);
      await assertTenantTwin(request, id);
      await assertManagementRead(request,id);
      next();
    }
    catch (error) { next(error); }
  });
  api.get("/storage/retention/status", (_request, response) => response.set("Cache-Control", "no-store").json(retention.status()));
  api.use(idempotencyMiddleware(idempotency, config.idempotency.ttlMs));
  api.post('/twins/:id/device-credentials/rotate', async (request, response) => {
    const id = String(request.params.id);
    await authorize(request, id, TwinAction.ModifyMetadata);
    const accounting = request.auth?.accounting;
    if (!accounting || !objectid.getSubscription || !(await objectid.getSubscription(accounting)).current) throw new AppError('SUBSCRIPTION_REQUIRED','Active Twin subscription required',402,'AUTHORIZATION');
    const result = await deviceWorkbench.deviceCredentials({ ownerDid: accounting.ownerDid, requesterDid: accounting.ownerDid, source: 'dt', tenantId: null }, id, 'rotate', true);
    response.set('Cache-Control','no-store').json(result);
  });
  api.get("/twins/:id/realtime/status", async (request, response, next) => {
    try {
      const health = await connectors.health();
      const latest = realtime.latest(request.params.id!);
      const status = realtime.status(request.params.id!, health, REALTIME_STALE_AFTER_MS);
      response.json({
        ...status,
        lastMessageAt: latest ? new Date(latest.receivedAt).toISOString() : null,
        encrypted: latest?.encryption.encrypted ?? false,
        keyId: latest?.encryption.keyId ?? null,
      });
    } catch (error) { next(error); }
  });
  api.get("/twins/:id/realtime/latest", (request, response) => {
    const latest = realtime.latest(request.params.id!);
    if (!latest) return response.status(404).json({ error: { code: "REALTIME_DATA_UNAVAILABLE", message: "No realtime data is available for this Twin", category: "CONNECTOR" } });
    const ai = connectors.get("ai");
    return response.set("Cache-Control", "no-store").json({ ...latest,
      ...(ai instanceof AiAnalysisConnector ? { analysis: ai.latest(request.params.id!) } : {}) });
  });
  api.get("/twins/:id/location/latest", (request, response) => {
    const latest = realtime.latest(request.params.id!);
    if (!latest?.position) return response.status(404).json({ error: { code: "REALTIME_POSITION_UNAVAILABLE", message: "No live position is available for this Twin", category: "CONNECTOR" } });
    return response.set("Cache-Control", "no-store").json(publicPositionEvent(latest));
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
    let closed = false, sending = false;
    let pending: { event: string; data: unknown } | null = null;
    const send = async (event: string, data: unknown) => {
      pending = { event, data };
      if (sending || closed) return;
      sending = true;
      try {
        while (pending && !closed) {
          const item = pending; pending = null;
          await assertManagementRead(request,twinId);
          if (!closed) response.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
        }
      } catch { closed = true; response.end(); }
      finally { sending = false; }
    };
    const latest = realtime.latest(twinId);
    if (latest) void send("snapshot", latest);
    const unsubscribe = realtime.subscribe(twinId, event => { void send("telemetry", event); });
    const heartbeat = setInterval(() => { void send("heartbeat", {}); }, 10_000);
    response.on("close", () => { closed = true; clearInterval(heartbeat); unsubscribe(); });
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
      moduleSettings.assertEnabled(request.auth?.accounting?.tenantId, "commands");
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
  api.get("/twins/:id/plant", async (request, response, next) => {
    try {
      const accounting = request.auth?.accounting;
      if (!accounting || request.auth?.subject !== accounting.ownerDid) throw new AppError("PLANT_ACCESS_DENIED", "Owner authentication required", 403, "AUTHORIZATION");
      const membership = await locateTwinPlant(plantService, credentials, request.params.id!, await objectid.getTwin(request.params.id!), accounting);
      if (!membership) throw new AppError("PLANT_MEMBERSHIP_NOT_FOUND", "No verified plant membership exists", 404, "VALIDATION");
      response.set("Cache-Control", "no-store").json(membership);
    } catch (error) { next(error); }
  });
  api.post("/twins", async (request, response, next) => {
    try {
      if (!config.objectid.signer?.enabled || !config.objectid.signer.delegatedAccounts) throw new AppError("DELEGATED_SIGNER_REQUIRED", "Personal creation requires the subscription-owner signing mode", 503, "AUTHORIZATION");
      response.status(201).json(await plantTwins.personal(request.body, request.auth?.subject, request.auth?.accounting));
    } catch (error) { next(error); }
  });
  api.patch("/twins/:id", mutation(TwinAction.ModifyMetadata, (id, body, accounting) => twins.updateTwin(id, body, accounting), 200));
  api.delete("/twins/:id", async (request, response, next) => {
    try {
      const twinId = String(request.params.id).toLowerCase();
      if (request.header("x-objectid-confirm-delete")?.toLowerCase() !== twinId) throw new AppError("OBJECTID_DELETE_CONFIRMATION_REQUIRED", "Confirm deletion with the exact Twin ID", 422, "VALIDATION");
      if (!objectid.deleteTwin) throw new AppError("OBJECTID_DELETE_UNAVAILABLE", "Twin deletion is unavailable", 503, "OBJECTID");
      await authorize(request, twinId, TwinAction.DeleteTwin);
      const result = await objectid.deleteTwin(twinId, request.auth?.accounting);
      const accounting = request.auth?.accounting;
      if (accounting && await tenants.isDynamic(accounting.ownerDid)) await tenants.revokeTwinCredentials(accounting.ownerDid, twinId);
      response.set("Cache-Control", "no-store").json(result);
    } catch (error) { next(error); }
  });
  // Deliberately no per-event DELETE endpoint. Same authorization as root deletion.
  api.delete("/twins/:id/events", async (request, response, next) => {
    try {
      const twinId = String(request.params.id).toLowerCase();
      if (request.header("x-objectid-confirm-delete-events")?.toLowerCase() !== twinId) throw new AppError("OBJECTID_DELETE_CONFIRMATION_REQUIRED", "Confirm bulk event destruction with the exact Twin ID", 422, "VALIDATION");
      await authorize(request, twinId, TwinAction.DeleteTwin);
      if (!objectid.deleteTwinEvents) throw new AppError("OBJECTID_CLEANUP_UNSUPPORTED", "Bulk cleanup unavailable", 503, "OBJECTID");
      response.set("Cache-Control", "no-store").json(await objectid.deleteTwinEvents(twinId, request.auth?.accounting));
    } catch (error) { next(error); }
  });
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
  api.post("/twins/:id/evidence-bundles", async (request, response, next) => {
    try {
      const twinId = request.params.id!;
      await authorize(request, twinId, TwinAction.AddDataset);
      response.status(201).set("Cache-Control", "no-store").json(await evidence.createSnapshot(
        twinId, evidenceSelection(request.body ?? {}), request.auth?.accounting,
      ));
    } catch (error) { next(error); }
  });
  api.get("/twins/:id/evidence-bundles/:datasetId", async (request, response, next) => {
    try {
      const twinId = request.params.id!;
      const bundle = await evidence.createBundle(twinId, requiredProvisioningTwinId(request.params.datasetId));
      response.set({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="objectid-dataset-${request.params.datasetId!.slice(0, 10)}.zip"`,
        "Content-Length": String(bundle.bytes.length),
        "Cache-Control": "no-store",
      }).send(bundle.bytes);
    } catch (error) { next(error); }
  });
  api.post("/twins/:id/evidence-bundles/validate", async (request, response, next) => {
    try { response.set("Cache-Control", "no-store").json(await evidence.validateBundle(request.params.id!, request.body)); }
    catch (error) { next(error); }
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
    try { moduleSettings.assertEnabled(request.auth?.accounting?.tenantId, "rest"); response.json(await connectors.get("rest")!.read(request.body)); } catch (error) { next(error); }
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

  function mutation(action: TwinAction, execute: (id: string, body: any, accounting?: AccountingContext) => Promise<unknown>, status = 202) {
    return async (request: express.Request, response: express.Response, next: express.NextFunction) => {
      try {
        const twinId = String(request.params.id);
        await authorize(request, twinId, action);
        response.status(status).json(await execute(twinId, request.body, request.auth?.accounting));
      }
      catch (error) { next(error); }
    };
  }

  async function authorize(request: express.Request, twinId: string, action: TwinAction) {
    try {
      const chainPolicy = await sharing.chainPolicy(twinId);
      if (chainPolicy) {
        const rights = policyRights(chainPolicy, callerDid(request, config));
        if (rights.owner || rights.admin) return;
      }
      await policy.assertAllowed(twinId, callerDid(request, config), action);
    }
    catch (error) { if (error instanceof AppError && error.code === "TWIN_POLICY_DENIED") policyDenied.inc({ action }); throw error; }
  }

  async function assertManagementRead(request: express.Request, id: string) {
    const token = request.header('x-objectid-twin-session');
    if (token) {
      const access = await sharing.read(id,token);
      if (!(access.rights.owner || access.rights.admin)) throw new AppError('TWIN_ADMIN_REQUIRED','Current owner or Admin required',403,'AUTHORIZATION');
      return;
    }
    const canonical = await sharing.chainPolicy(id);
    if (canonical) {
      const rights = policyRights(canonical, callerDid(request, config));
      const fields = await sharing.twin(id);
      if (!(rights.owner || rights.admin) && callerDid(request, config) !== fields.steward_did) throw new AppError('TWIN_ADMIN_REQUIRED', 'Use the DID-authenticated shared API for read-only access', 403, 'AUTHORIZATION');
    }
  }

  async function assertTenantTwin(request: express.Request, twinId: string) {
    const accounting = request.auth?.accounting;
    if (!accounting) return;
    await assertAccountingTwin(accounting, twinId);
  }

  async function assertAccountingTwin(accounting: AccountingContext, twinId: string) {
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

  function publicTwinNotFound() {
    return new AppError("PUBLIC_TWIN_NOT_FOUND", "Public Twin not found", 404, "VALIDATION");
  }

  async function assertPublicTwinAccess(rawTwinId: unknown, accessKind: boolean | "location") {
    const twinId = String(rawTwinId ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/i.test(twinId)) throw publicTwinNotFound();
    const onChain = await sharing.publicAccess(twinId);
    if (onChain) {
      if (!onChain.twinPublic || (accessKind === true && !onChain.dataPublic) || (accessKind === 'location' && !onChain.liveLocationPublic)) throw publicTwinNotFound();
      return twinId;
    }
    if (await sharing.blocksPublic(twinId, accessKind)) throw publicTwinNotFound();
    const cached = publicAccessCache.get(twinId);
    let access = cached;
    if (!access || Date.now() - access.checkedAt >= 5_000) {
      const twin = await objectid.getTwin(twinId);
      access = { checkedAt: Date.now(), ...objectIdTwinPublicAccess(twin, config.objectid.packageId) };
      publicAccessCache.set(twinId, access);
    }
    if (!access.twinPublic || (accessKind === true && !access.dataPublic) || (accessKind === "location" && !access.liveLocationPublic)) throw publicTwinNotFound();
    return twinId;
  }

  async function ingestMqttMessage(message: MappedMqttMessage) {
    const accounting = await connectorAccounting(String(message.mapping.tenantId ?? ""));
    if (accounting) await assertConnectorAccountingTwin(accounting, message.mapping.twinId);
    const event = realtime.publish(message);
    const ai = connectors.get("ai");
    const aiTenant = accounting?.tenantId ?? String(message.mapping.tenantId ?? "");
    if (ai instanceof AiAnalysisConnector && moduleSettings.enabled(aiTenant, "ai")) ai.observe(aiTenant, event);
    if (message.mapping.mode === "dataset") {
      if (!config.dataset.aggregation.enabled) throw new AppError("DATASET_AGGREGATION_DISABLED", "Dataset aggregation is disabled", 422, "CONNECTOR");
      const mapped = mqttMessageToDataset(message);
      aggregator.ingest(mapped.key, mapped.value, mapped.metadata, mapped.observedAt, mapped.windowMs);
      return;
    }
    const mapped = mqttMessageToState(message);
    const source = message.topic ?? message.nodeId ?? "unknown";
    const key = `connector-state:${mapped.twinId}:${source}:${message.observedAt}`;
    await worker.enqueue(worker.createJob("PUBLISH_STATE", mapped.twinId, mapped.state, key, accounting));
  }

  async function assertConnectorAccountingTwin(accounting: AccountingContext, twinId: string) {
    const normalizedTwinId = twinId.toLowerCase();
    const subscriptionId = accounting.subscriptionId.toLowerCase();
    const key = `${accounting.tenantId}:${normalizedTwinId}`;
    const cached = connectorTwinAuthCache.get(key);
    if (cached?.subscriptionId === subscriptionId && cached.expiresAt > Date.now()) return;
    const existing = connectorTwinAuthInflight.get(key);
    if (existing) return existing;
    const verification = assertAccountingTwin(accounting, normalizedTwinId)
      .then(() => { connectorTwinAuthCache.set(key, { subscriptionId, expiresAt: Date.now() + CONNECTOR_TWIN_AUTH_CACHE_MS }); })
      .finally(() => { connectorTwinAuthInflight.delete(key); });
    connectorTwinAuthInflight.set(key, verification);
    return verification;
  }

  async function assertTenantProvisioningRequest(request: express.Request, rawOwnerDid: unknown) {
    const provisioning = config.security.tenantProvisioning;
    if (!provisioning?.enabled) throw new AppError("OBJECTID_TENANT_PROVISIONING_DISABLED", "Tenant provisioning is disabled", 404, "AUTHORIZATION");
    const expected = await requiredCredential(credentials, provisioning.provisioningKeyCredential);
    if (request.header("x-provisioning-key") !== expected) throw new AppError("AUTH_INVALID_PROVISIONING_KEY", "Invalid provisioning key", 401, "AUTHORIZATION");
    const ownerDid = String(rawOwnerDid ?? "").toLowerCase();
    const networkPattern = config.objectid.network === "mainnet"
      ? /^did:iota:0x[0-9a-f]{64}$/
      : new RegExp(`^did:iota:${escapeRegExp(config.objectid.network)}:0x[0-9a-f]{64}$`);
    if (!networkPattern.test(ownerDid)) throw new AppError("OBJECTID_OWNER_DID_INVALID", `A valid ${config.objectid.network} owner DID is required`, 422, "VALIDATION");
    return { provisioning, ownerDid };
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
      const deviceConnector=connectors.get("mqtt");
      if(config.connectors.mqtt?.enabled && deviceConnector?.subscribeTo) subscriptions.push(await deviceConnector.subscribeTo(deviceTopicPrefix+"/+/devices/+/telemetry",async(data:any)=>{
        const parts=String(data.topic).slice(deviceTopicPrefix.length+1).split("/");
        if(parts.length===4 && parts[1]==="devices" && parts[3]==="telemetry")
          await deviceWorkbench.ingest(parts[0]!,parts[2]!,data.value,undefined,true);
      }));
      for (const type of ["mqtt", "opcua"]) {
        if (!config.connectors[type]?.enabled) continue;
        const connector = connectors.get(type);
        if (connector?.subscribe) subscriptions.push(await connector.subscribe(async (data) => ingestMqttMessage(data as MappedMqttMessage)));
      }
    },
    ingestMqttMessage, ingestConnectorMessage: ingestMqttMessage,
    async flushDatasets() { await aggregator.close(); await worker.drain(config.dataset.aggregation.shutdownFlushTimeoutMs); },
    async stop() {
      sharedDatasets.close();
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

function credentialStatusResponse(status: TenantCredentialStatus, provisioning: NonNullable<AppConfig["security"]["tenantProvisioning"]>, network = "testnet") {
  const apiUrl = String(provisioning.publicApiUrl ?? "https://dtis.objectid.io/api/v1").replace(/\/$/, "");
  const mqttUrl = provisioning.mqtt?.publicUrl ?? "wss://dtis.objectid.io/mqtt";
  const topicPrefix = String(provisioning.topicPrefix ?? "objectid/tenants").replace(/^\/+|\/+$/g, "");
  const commandPrefix = topicPrefix.endsWith("/tenants") ? topicPrefix.slice(0, -8) : topicPrefix;
  return {
    ...status, network,
    endpoint: apiUrl,
    mqtt: {
      endpoint: mqttUrl,
      username: status.mqttUsername,
      twinIds: status.twinIds,
      topics: status.twinIds.map((twinId) => ({
        twinId,
        state: `${topicPrefix}/${status.tenantId}/twins/${twinId}/telemetry/state`,
        dataset: `${topicPrefix}/${status.tenantId}/twins/${twinId}/telemetry/dataset`,
        commandRequests: `${commandPrefix}/twins/${twinId}/commands/request`,
        commandResults: `${commandPrefix}/twins/${twinId}/commands/+/result`,
      })),
    },
  };
}

function deviceCredentialResponse(status: Awaited<ReturnType<TenantRegistry["twinCredentialStatus"]>>, provisioning: NonNullable<AppConfig["security"]["tenantProvisioning"]>, network = "testnet") {
  const mqttUrl = provisioning.mqtt?.publicUrl ?? "wss://dtis.objectid.io/mqtt";
  const topicPrefix = String(provisioning.topicPrefix ?? "objectid/tenants").replace(/^\/+|\/+$/g, "");
  const commandPrefix = topicPrefix.endsWith("/tenants") ? topicPrefix.slice(0, -8) : topicPrefix;
  const root = `${topicPrefix}/${status.tenantId}/twins/${status.twinId}`;
  return {
    specVersion: "objectid.device-provisioning.v1",
    network,
    tenantId: status.tenantId,
    subscriptionId: status.subscriptionId,
    twinId: status.twinId,
    active: status.active,
    version: status.version,
    rotatedAt: status.rotatedAt,
    revokedAt: status.revokedAt,
    mqtt: {
      endpoint: mqttUrl,
      username: status.mqttUsername,
      topics: {
        state: `${root}/telemetry/state`,
        dataset: `${root}/telemetry/dataset`,
        commandRequests: `${commandPrefix}/twins/${status.twinId}/commands/request`,
        commandResults: `${commandPrefix}/twins/${status.twinId}/commands/+/result`,
      },
    },
  };
}

function requiredProvisioningTwinId(value: unknown) {
  const twinId = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(twinId)) throw new AppError("OBJECTID_TWIN_ID_INVALID", "A valid 32-byte Twin object ID is required", 422, "VALIDATION");
  return twinId;
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function threadOptions(query: Record<string, unknown>): PaginationOptions {
  const number = (value: unknown) => value === undefined ? undefined : Number(value);
  return {
    cursor: optionalTwinId(query.cursor), limit: number(query.limit),
    fromRevision: number(query.fromRevision), toRevision: number(query.toRevision),
    eventTypes: typeof query.eventType === "string" ? query.eventType.split(",").map(Number).filter(Number.isFinite) : undefined,
    fromTimestamp: number(query.fromTimestamp ?? query.fromTime), toTimestamp: number(query.toTimestamp ?? query.toTime),
  };
}

function evidenceSelection(query: Record<string, unknown>) {
  const timestamp = (value: unknown, name: string) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new AppError("EVIDENCE_TIME_INVALID", `${name} must be a Unix timestamp in milliseconds`, 422, "VALIDATION");
    return parsed;
  };
  const fromTimestamp = timestamp(query.fromTimestamp ?? query.fromTime, "fromTimestamp");
  const toTimestamp = timestamp(query.toTimestamp ?? query.toTime, "toTimestamp");
  if (fromTimestamp !== undefined && toTimestamp !== undefined && fromTimestamp > toTimestamp) {
    throw new AppError("EVIDENCE_RANGE_INVALID", "fromTimestamp must not be later than toTimestamp", 422, "VALIDATION");
  }
  return { fromTimestamp, toTimestamp };
}

function callerDid(request: express.Request, config: AppConfig) {
  if (request.auth?.claims?.twinSession === true) return String(request.auth.claims.did);
  if (request.auth?.accounting) return request.auth.accounting.ownerDid;
  const claims = request.auth?.claims;
  const delegated = request.header("x-objectid-caller-did");
  return String(claims?.did ?? (config.security.authMode !== "disabled" ? delegated : undefined) ?? claims?.sub ?? config.security.serviceDid ?? request.auth?.subject ?? "");
}

function publicRealtimeEvent(event: TwinRealtimeEvent) {
  return {
    twinId: event.twinId,
    observedAt: event.observedAt,
    receivedAt: event.receivedAt,
    payload: event.payload,
    encryption: event.encryption,
  };
}

function publicPositionEvent(event: TwinRealtimeEvent) {
  return { twinId: event.twinId, observedAt: event.position?.observedAt ?? event.observedAt, receivedAt: event.receivedAt, position: event.position };
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
import {tenantAccessRoutes} from "../security/tenant-access.js";
