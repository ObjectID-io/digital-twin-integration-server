import { AppError } from "../common/errors.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import type { HealthStatus, TwinConnector } from "./types.js";

export class RestConnector implements TwinConnector {
  readonly type = "rest";
  private baseUrl = "";
  private timeoutMs = 10_000;
  private readonly breaker = new CircuitBreaker();
  async connect(config: Record<string, unknown>) {
    this.baseUrl = String(config.baseUrl ?? "").replace(/\/$/, "");
    this.timeoutMs = Number(config.timeoutMs ?? 10_000);
  }
  async read(input: any) { return this.request({ ...input, method: input?.method ?? "GET" }); }
  async write(input: any) { await this.request({ ...input, method: input?.method ?? "POST" }); }
  private async request(input: any) {
    return this.breaker.execute(async () => {
      const url = new URL(String(input.path ?? input.url ?? ""), this.baseUrl || undefined);
      const response = await fetch(url, {
        method: String(input.method ?? "GET"),
        headers: { "content-type": "application/json", ...(input.headers ?? {}) },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new AppError("REST_CONNECTOR_FAILED", `REST endpoint returned ${response.status}`, 502, "CONNECTOR");
      const contentType = response.headers.get("content-type") ?? "";
      return contentType.includes("json") ? response.json() : response.text();
    });
  }
  async healthCheck(): Promise<HealthStatus> { return { healthy: true, checkedAt: new Date().toISOString() }; }
  async disconnect() {}
}
