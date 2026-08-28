import type { AppConfig } from "../config/types.js";
import type { HealthStatus } from "../connectors/types.js";

const MAX_METRIC_VALUE = 1_000_000_000_000;

export interface ReadinessSnapshot {
  ready: boolean;
  dependencies: { objectid: boolean; profiles: boolean; requiredConnectors: boolean; storage: boolean };
  connectors: Record<string, HealthStatus>;
  storage: { requiredReady: boolean; providers: Record<string, HealthStatus> };
}

export function buildSystemStatus(input: {
  config: AppConfig;
  readiness: ReadinessSnapshot;
  metricsText: string;
  queueDepth: number;
  retention: { enabled: boolean; defaultDays: number; running: boolean; lastRun: unknown };
}) {
  const { config, readiness } = input;
  const services: Array<{ id: string; label: string; status: string; detail: string; checkedAt: string | null; required: boolean }> = [
    item("api", "DTIS API", "operational", "HTTP service responding", true),
    item("objectid", "IOTA / ObjectID", readiness.dependencies.objectid ? "operational" : "unavailable", `Network ${config.objectid.network}`, true),
    item("profiles", "Twin profiles", readiness.dependencies.profiles ? "operational" : "unavailable", "Schema registry", true),
  ];

  for (const [name, connectorConfig] of Object.entries(config.connectors)) {
    const health = readiness.connectors[name];
    const enabled = connectorConfig.enabled === true;
    const required = enabled && connectorConfig.required === true;
    services.push({
      id: `connector-${name}`, label: connectorLabel(name),
      status: !enabled ? "disabled" : health?.healthy ? "operational" : required ? "unavailable" : "degraded",
      detail: !enabled ? "Not enabled in this execution plane" : health?.healthy ? "Health check passed" : "Health check failed",
      checkedAt: health?.checkedAt ?? null, required,
    });
  }

  const requiredStorage = new Set([config.storage.defaultProvider, ...Object.values(config.storage.routes)]);
  for (const [name, providerConfig] of Object.entries(config.storage.providers)) if (providerConfig.required === true) requiredStorage.add(name);
  for (const [name, providerConfig] of Object.entries(config.storage.providers)) {
    const health = readiness.storage.providers[name];
    const required = requiredStorage.has(name);
    const planned = providerConfig.type === "azure-blob" || providerConfig.type === "ipfs";
    services.push({
      id: `storage-${name}`, label: `Storage / ${name}`,
      status: health?.healthy ? "operational" : required ? "unavailable" : planned ? "disabled" : "degraded",
      detail: health?.healthy ? `${String(providerConfig.type).toUpperCase()} provider reachable` : `${String(providerConfig.type).toUpperCase()} provider unavailable`,
      checkedAt: health?.checkedAt ?? null, required,
    });
  }

  services.push({
    id: "ingestion", label: "Ingestion worker", status: input.queueDepth > 100 ? "degraded" : "operational",
    detail: input.queueDepth > 100 ? "Queue backlog requires attention" : `${input.queueDepth} queued jobs`, checkedAt: new Date().toISOString(), required: true,
  });
  services.push({
    id: "retention", label: "Storage retention", status: input.retention.enabled ? "operational" : "disabled",
    detail: input.retention.enabled ? `${input.retention.defaultDays} day default policy` : "Automatic retention disabled",
    checkedAt: retentionCheckedAt(input.retention.lastRun), required: false,
  });

  const requiredFailure = services.some((service) => service.required && service.status === "unavailable");
  const degraded = services.some((service) => service.status === "degraded");
  return {
    generatedAt: new Date().toISOString(), network: config.objectid.network, apiVersion: "v1",
    overall: requiredFailure ? "unavailable" : !readiness.ready || degraded ? "degraded" : "operational",
    ready: readiness.ready, uptimeSeconds: Math.floor(process.uptime()), services,
    metrics: parsePrometheusMetrics(input.metricsText),
  };
}

export function parsePrometheusMetrics(text: string) {
  const samples = String(text).split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map(parseSample).filter((sample): sample is NonNullable<typeof sample> => Boolean(sample));
  const sum = (name: string, predicate: (labels: Record<string, string>) => boolean = () => true) => samples
    .filter((sample) => sample.name === name && predicate(sample.labels)).reduce((total, sample) => total + sample.value, 0);
  const value = (name: string) => samples.find((sample) => sample.name === name)?.value ?? null;
  const durationCount = sum("dtis_request_duration_seconds_count");
  const durationSum = sum("dtis_request_duration_seconds_sum");
  return {
    requests: sum("dtis_requests_total"), serverErrors: sum("dtis_requests_total", (labels) => Number(labels.status) >= 500),
    averageResponseMs: durationCount > 0 ? Math.round(durationSum / durationCount * 1_000) : null,
    queueDepth: value("dtis_queue_depth"), queueJobs: sum("dtis_queue_jobs_total"), queueFailures: sum("dtis_queue_jobs_failed_total"), queueRetries: sum("dtis_queue_retries_total"),
    connectorErrors: sum("dtis_connector_errors_total"), objectIdTransactions: sum("dtis_objectid_transactions_total"), objectIdFailures: sum("dtis_objectid_failures_total"),
    datasetSamples: sum("dtis_dataset_samples_total"), datasetsCreated: sum("dtis_datasets_created_total"), activeDatasetWindows: value("dtis_dataset_windows_active"),
    digitalThreadFailures: sum("dtis_digital_thread_verification_failures_total"), policyDenials: sum("dtis_policy_denied_total"), idempotencyHits: sum("dtis_idempotency_hits_total"),
  };
}

function parseSample(line: string) {
  const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+\d+)?$/);
  if (!match) return null;
  const numeric = Number(match[3]);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > MAX_METRIC_VALUE) return null;
  const labels: Record<string, string> = {};
  for (const item of match[2]?.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g) ?? []) labels[item[1]!] = item[2]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return { name: match[1]!, labels, value: numeric };
}

function item(id: string, label: string, status: string, detail: string, required: boolean) {
  return { id, label, status, detail, checkedAt: new Date().toISOString(), required };
}
function connectorLabel(name: string) {
  return ({ mqtt: "MQTT broker", opcua: "OPC-UA connector", rest: "REST connector", modbus: "Modbus connector", websocket: "WebSocket connector" } as Record<string, string>)[name.toLowerCase()] ?? `${name.toUpperCase()} connector`;
}
function retentionCheckedAt(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const completedAt = (value as Record<string, unknown>).completedAt;
  return typeof completedAt === "string" ? completedAt : null;
}
