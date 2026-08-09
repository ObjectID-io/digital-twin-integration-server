import {
  AttributeIds, ClientMonitoredItem, ClientSubscription, DataType, MessageSecurityMode,
  OPCUAClient, SecurityPolicy, TimestampsToReturn, Variant,
} from "node-opcua";
import { AppError } from "../common/errors.js";
import { logger } from "../common/logger.js";
import { opcuaConnectionErrors, opcuaConnections, opcuaReads, opcuaSubscriptionErrors, opcuaSubscriptionEvents, opcuaWrites } from "../health/metrics.js";
import type { HealthStatus, Subscription, TwinConnector } from "./types.js";

export interface OpcUaMapping {
  nodeId: string;
  twinId: string;
  mode?: "state" | "dataset";
  aspect?: string;
  sampleType?: string;
  datasetType?: string;
  windowSeconds?: number;
  schemaUri?: string;
  profile?: string;
  samplingIntervalMs?: number;
}

type ClientFactory = (options: Record<string, unknown>) => any;
export interface OpcUaRuntime {
  createSubscription(session: any, options: any): any;
  createMonitoredItem(subscription: any, item: any, parameters: any, timestamps: any): any;
}
const defaultRuntime: OpcUaRuntime = {
  createSubscription: (session, options) => ClientSubscription.create(session, options),
  createMonitoredItem: (subscription, item, parameters, timestamps) => ClientMonitoredItem.create(subscription, item, parameters, timestamps),
};

export class OpcUaConnector implements TwinConnector {
  readonly type = "opcua";
  private client?: any;
  private session?: any;
  private endpoint = "";
  private mappings: OpcUaMapping[] = [];
  private healthCheckTimeoutMs = 2_000;

  constructor(
    private readonly clientFactory: ClientFactory = (options) => OPCUAClient.create(options as any),
    private readonly runtime: OpcUaRuntime = defaultRuntime,
  ) {}

  async connect(config: Record<string, unknown>) {
    this.endpoint = String(config.endpoint ?? "");
    if (!this.endpoint.startsWith("opc.tcp://")) throw new AppError("OPCUA_ENDPOINT_INVALID", "OPC-UA requires an opc.tcp:// endpoint", 500, "CONNECTOR");
    this.mappings = Array.isArray(config.mappings) ? config.mappings as OpcUaMapping[] : [];
    this.healthCheckTimeoutMs = Math.max(100, Number(config.healthCheckTimeoutMs ?? 2_000));
    const securityMode = enumValue(MessageSecurityMode, String(config.securityMode ?? "None"), MessageSecurityMode.None);
    const securityPolicy = enumValue(SecurityPolicy, String(config.securityPolicy ?? "None"), SecurityPolicy.None);
    this.client = this.clientFactory({
      applicationName: String(config.applicationName ?? "ObjectID-DTIS"), securityMode, securityPolicy,
      certificateFile: optionalString(config.clientCertificate), privateKeyFile: optionalString(config.privateKey),
      endpointMustExist: config.endpointMustExist !== false,
      connectionStrategy: { initialDelay: 1_000, maxDelay: 10_000, maxRetry: Number(config.maxRetry ?? 10) },
    });
    try {
      await this.client.connect(this.endpoint);
      const username = optionalString(config.username);
      this.session = await this.client.createSession(username
        ? { type: 1, userName: username, password: String(config.password ?? "") }
        : undefined);
      opcuaConnections.inc();
    } catch (error) { opcuaConnectionErrors.inc(); throw error; }
  }

  async browse(input: any) {
    this.assertConnected();
    return this.session.browse(String(input?.nodeId ?? input));
  }

  async read(input: any) {
    this.assertConnected();
    const dataValue = await this.session.read({ nodeId: String(input?.nodeId ?? input), attributeId: AttributeIds.Value });
    opcuaReads.inc();
    return dataValue?.value?.value;
  }

  async write(input: any) {
    this.assertConnected();
    const status = await this.session.write({
      nodeId: String(input.nodeId), attributeId: AttributeIds.Value,
      value: { value: new Variant({ dataType: dataTypeFor(input.dataType, input.value), value: input.value }) },
    });
    if (status?.isNotGood?.()) throw new AppError("OPCUA_WRITE_FAILED", String(status), 502, "CONNECTOR");
    opcuaWrites.inc();
  }

  async subscribe(handler: (data: unknown) => Promise<void> | void): Promise<Subscription> {
    this.assertConnected();
    const subscription = this.runtime.createSubscription(this.session, {
      requestedPublishingInterval: 1_000, requestedLifetimeCount: 100, requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100, publishingEnabled: true, priority: 1,
    });
    for (const mapping of this.mappings) {
      const monitored = this.runtime.createMonitoredItem(subscription,
        { nodeId: mapping.nodeId, attributeId: AttributeIds.Value },
        { samplingInterval: mapping.samplingIntervalMs ?? 1_000, discardOldest: true, queueSize: 100 },
        TimestampsToReturn.Both);
      monitored.on("changed", (dataValue: any) => {
        opcuaSubscriptionEvents.inc();
        Promise.resolve(handler({ mapping, nodeId: mapping.nodeId, value: dataValue?.value?.value, observedAt: dataValue?.sourceTimestamp?.getTime?.() ?? Date.now() }))
          .catch((error) => {
            const classification = error instanceof AppError ? error.code : "HANDLER_ERROR";
            opcuaSubscriptionErrors.inc({ classification });
            logger.error({ connector: "opcua", nodeId: mapping.nodeId, classification, err: error }, "opcua_subscription_handler_failed");
          });
      });
    }
    return { close: async () => { await subscription.terminate(); } };
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    if (!this.session) return { healthy: false, message: "session unavailable", checkedAt };
    try {
      const value = await withTimeout(
        this.session.read({ nodeId: "i=2258", attributeId: AttributeIds.Value }),
        this.healthCheckTimeoutMs,
        "OPC-UA health read timed out",
      );
      const good = (value as any)?.statusCode?.isNotGood?.() !== true;
      return { healthy: good, message: good ? "server current-time read succeeded" : "server returned a bad status", checkedAt };
    } catch (error) {
      return { healthy: false, message: error instanceof Error ? error.message : "health read failed", checkedAt };
    }
  }

  async disconnect() {
    if (this.session) await this.session.close();
    if (this.client) await this.client.disconnect();
    this.session = undefined;
    this.client = undefined;
  }

  private assertConnected() {
    if (!this.session) throw new AppError("OPCUA_NOT_CONNECTED", "OPC-UA connector is unavailable", 503, "CONNECTOR");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

function optionalString(value: unknown) { return value === undefined || value === null || value === "" ? undefined : String(value); }
function enumValue(values: any, name: string, fallback: any) { return values[name] ?? fallback; }
function dataTypeFor(configured: unknown, value: unknown) {
  if (configured && (DataType as any)[String(configured)]) return (DataType as any)[String(configured)];
  if (typeof value === "boolean") return DataType.Boolean;
  if (typeof value === "number") return DataType.Double;
  return DataType.String;
}
