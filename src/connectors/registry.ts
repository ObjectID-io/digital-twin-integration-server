import { logger } from "../common/logger.js";
import type { TwinConnector } from "./types.js";

export class ConnectorRegistry {
  private readonly connectors = new Map<string, TwinConnector>();
  private readonly startFailures = new Map<string, string>();
  register(connector: TwinConnector) { this.connectors.set(connector.type, connector); }
  get(type: string) { return this.connectors.get(type); }
  async start(configs: Record<string, { enabled: boolean; [key: string]: unknown }>) {
    await Promise.allSettled([...this.connectors].map(async ([type, connector]) => {
      const config = configs[type];
      if (!config?.enabled) return;
      try { await connector.connect(config); }
      catch (error) {
        this.startFailures.set(type, error instanceof Error ? error.message : String(error));
        logger.error({ connector: type, err: error }, "connector_start_failed");
      }
    }));
  }
  async health() {
    return Object.fromEntries(await Promise.all([...this.connectors].map(async ([type, connector]) => {
      const status = await connector.healthCheck();
      const failure = this.startFailures.get(type);
      return [type, failure ? { ...status, healthy: false, message: failure } : status];
    })));
  }
  async stop() { await Promise.allSettled([...this.connectors.values()].map((connector) => connector.disconnect())); }
}
