import { AppError } from "../common/errors.js";
import { MqttConnector } from "./mqtt.js";
import { RestConnector } from "./rest.js";
import { OpcUaConnector } from "./opcua.js";
import type { HealthStatus, TwinConnector } from "./types.js";

type ConnectorBuilder = () => TwinConnector;

export class ConnectorFactory {
  private readonly builders = new Map<string, ConnectorBuilder>();
  constructor() {
    this.register("rest", () => new RestConnector());
    this.register("mqtt", () => new MqttConnector());
    this.register("opcua", () => new OpcUaConnector());
    for (const type of ["modbus", "websocket"]) {
      this.register(type, () => new PluginReadyConnector(type));
    }
  }
  register(type: string, builder: ConnectorBuilder) { this.builders.set(type, builder); }
  create(type: string) {
    const builder = this.builders.get(type);
    if (!builder) throw new AppError("CONNECTOR_TYPE_UNKNOWN", `Connector '${type}' is not registered`, 500, "CONNECTOR");
    return builder();
  }
  createConfigured(configs: Record<string, { enabled: boolean; [key: string]: unknown }>) {
    return Object.keys(configs).filter((type) => this.builders.has(type)).map((type) => this.create(type));
  }
}

class PluginReadyConnector implements TwinConnector {
  constructor(readonly type: string) {}
  async connect() { throw new AppError("CONNECTOR_NOT_IMPLEMENTED", `Connector '${this.type}' is plugin-ready but not implemented`, 501, "CONNECTOR"); }
  async read(): Promise<unknown> { throw new AppError("CONNECTOR_NOT_IMPLEMENTED", `Connector '${this.type}' is not implemented`, 501, "CONNECTOR"); }
  async healthCheck(): Promise<HealthStatus> { return { healthy: false, message: "not implemented", checkedAt: new Date().toISOString() }; }
  async disconnect() {}
}
