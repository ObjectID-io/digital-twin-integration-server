import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { AppError } from "../common/errors.js";
import type { HealthStatus, Subscription, TwinConnector } from "./types.js";

export interface MqttMapping {
  topic: string;
  twinId: string;
  mode?: "state" | "dataset";
  aspect?: string;
  sampleType?: string;
  datasetType?: string;
  windowSeconds?: number;
  schemaUri?: string;
  profile?: string;
  qos?: 0 | 1 | 2;
  tenantId?: string;
  dynamicTenantTopic?: boolean;
}

export class MqttConnector implements TwinConnector {
  readonly type = "mqtt";
  private client?: MqttClient;
  private mappings: MqttMapping[] = [];
  async connect(config: Record<string, unknown>) {
    const url = String(config.url ?? "");
    if (!url) throw new AppError("MQTT_URL_MISSING", "MQTT connector requires a URL", 500, "CONNECTOR");
    this.mappings = Array.isArray(config.mappings) ? config.mappings as MqttMapping[] : [];
    const options: IClientOptions = {
      username: config.username ? String(config.username) : undefined,
      password: config.password ? String(config.password) : undefined,
      rejectUnauthorized: config.rejectUnauthorized !== false,
      connectTimeout: Number(config.connectTimeoutMs ?? 10_000),
      reconnectPeriod: Number(config.reconnectPeriodMs ?? 5_000),
    };
    this.client = mqtt.connect(url, options);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new AppError("MQTT_CONNECT_TIMEOUT", "MQTT connection timed out", 503, "CONNECTOR")), options.connectTimeout);
      this.client!.once("connect", () => { clearTimeout(timeout); resolve(); });
      this.client!.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
  }
  async read() { throw new AppError("MQTT_READ_UNSUPPORTED", "Use subscribe for MQTT reads", 405, "CONNECTOR"); }
  async write(input: any) {
    if (!this.client?.connected) throw new AppError("MQTT_NOT_CONNECTED", "MQTT connector is unavailable", 503, "CONNECTOR");
    await this.client.publishAsync(String(input.topic), typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload), { qos: input.qos ?? 0, retain: input.retain === true });
  }
  async subscribeTo(topicFilter: string, handler: (data: unknown) => Promise<void> | void, qos: 0 | 1 | 2 = 1): Promise<Subscription> {
    if (!this.client) throw new AppError("MQTT_NOT_CONNECTED", "MQTT connector is unavailable", 503, "CONNECTOR");
    await this.client.subscribeAsync(topicFilter, { qos });
    const listener = (topic: string, payload: Buffer) => {
      if (!mqttMatch(topicFilter, topic)) return;
      let value: unknown = payload.toString();
      try { value = JSON.parse(payload.toString()); } catch { /* raw response is ignored by the command service */ }
      Promise.resolve(handler({ topic, value, observedAt: Date.now() })).catch(() => undefined);
    };
    this.client.on("message", listener);
    return { close: async () => { this.client?.off("message", listener); await this.client?.unsubscribeAsync(topicFilter); } };
  }
  async subscribe(handler: (data: unknown) => Promise<void> | void): Promise<Subscription> {
    if (!this.client) throw new AppError("MQTT_NOT_CONNECTED", "MQTT connector is unavailable", 503, "CONNECTOR");
    for (const mapping of this.mappings) await this.client.subscribeAsync(mapping.topic, { qos: mapping.qos ?? 0 });
    const listener = (topic: string, payload: Buffer) => {
      const configured = this.mappings.find((item) => mqttMatch(item.topic, topic));
      if (!configured) return;
      const mapping = configured.dynamicTenantTopic ? dynamicTenantMapping(configured, topic) : configured;
      if (!mapping) return;
      let value: unknown = payload.toString();
      try { value = JSON.parse(payload.toString()); } catch { /* raw text is valid */ }
      Promise.resolve(handler({ mapping, topic, value, observedAt: Date.now() })).catch(() => undefined);
    };
    this.client.on("message", listener);
    return { close: async () => { this.client?.off("message", listener); } };
  }
  async healthCheck(): Promise<HealthStatus> { return { healthy: Boolean(this.client?.connected), checkedAt: new Date().toISOString() }; }
  async disconnect() { if (this.client) await this.client.endAsync(); }
}

export function mqttMatch(pattern: string, topic: string) {
  const p = pattern.split("/"); const t = topic.split("/");
  for (let index = 0; index < p.length; index += 1) {
    if (p[index] === "#") return true;
    if (p[index] !== "+" && p[index] !== t[index]) return false;
  }
  return p.length === t.length;
}

export function dynamicTenantMapping(mapping: MqttMapping, topic: string): MqttMapping | undefined {
  const parts = topic.split("/");
  const tenantIndex = parts.indexOf("tenants");
  if (parts[0] !== "objectid" || tenantIndex < 1 || parts.length !== tenantIndex + 6 || parts[tenantIndex + 2] !== "twins" || parts[tenantIndex + 4] !== "telemetry") return undefined;
  const tenantId = parts[tenantIndex + 1] ?? ""; const twinId = parts[tenantIndex + 3] ?? ""; const mode = parts[tenantIndex + 5] ?? "";
  if (!/^[a-z0-9_-]{1,96}$/i.test(tenantId) || !/^0x[0-9a-f]{64}$/i.test(twinId) || !["state", "dataset"].includes(mode)) return undefined;
  return { ...mapping, tenantId, twinId: twinId.toLowerCase(), mode: mode as "state" | "dataset" };
}
