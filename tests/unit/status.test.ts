import { describe, expect, it } from "vitest";
import { buildSystemStatus, parsePrometheusMetrics } from "../../src/health/status.js";
import { testConfig } from "../fixtures/config.js";

describe("public system status", () => {
  it("aggregates selected Prometheus counters without exposing labels", () => {
    const metrics = parsePrometheusMetrics([
      'dtis_requests_total{method="GET",route="/secret/tenant",status="200"} 4',
      'dtis_requests_total{method="POST",route="/api",status="503"} 2',
      'dtis_request_duration_seconds_sum{method="GET"} 0.9',
      'dtis_request_duration_seconds_count{method="GET"} 3',
      'unrelated_metric{credential="do-not-expose"} 99',
    ].join("\n"));

    expect(metrics).toMatchObject({ requests: 6, serverErrors: 2, averageResponseMs: 300 });
    expect(JSON.stringify(metrics)).not.toContain("tenant");
    expect(JSON.stringify(metrics)).not.toContain("credential");
  });

  it("does not report disabled optional connectors as an outage", () => {
    const status = buildSystemStatus({
      config: testConfig(),
      readiness: {
        ready: true,
        dependencies: { objectid: true, profiles: true, requiredConnectors: true, storage: true },
        connectors: { rest: { healthy: true, checkedAt: new Date().toISOString() } },
        storage: { requiredReady: true, providers: { local: { healthy: true, checkedAt: new Date().toISOString() } } },
      },
      metricsText: "",
      queueDepth: 0,
      retention: { enabled: false, defaultDays: 5, running: false, lastRun: null },
    });

    expect(status.overall).toBe("operational");
    expect(status.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "connector-mqtt", status: "disabled" }),
    ]));
  });
});
