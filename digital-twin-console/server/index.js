import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import mqtt from "mqtt";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = {
  port: numberEnv("PORT", 8080),
  apiBaseUrl: (process.env.DTIS_API_BASE_URL ?? "http://digital-twin-integration-server:8080").replace(/\/$/, ""),
  credentialsFile: process.env.DTIS_CREDENTIAL_FILE ?? "/run/secrets/dtis_credentials",
  twinId: process.env.TWIN_ID ?? "",
  network: process.env.IOTA_NETWORK ?? "testnet",
  packageId: process.env.IOTA_PACKAGE_ID ?? "",
  mqttUrl: process.env.MQTT_URL ?? "mqtt://mosquitto:1883",
  mqttTopic: process.env.MQTT_TOPIC ?? "objectid/twins/telemetry/dataset",
  mqttUsername: process.env.MQTT_USERNAME ?? "objectid",
  mqttPasswordFile: process.env.MQTT_PASSWORD_FILE ?? "/run/secrets/mqtt_password"
};

if (!config.twinId) throw new Error("TWIN_ID is required");

const credentials = JSON.parse(await readFile(config.credentialsFile, "utf8"));
const apiKey = String(credentials.DTIS_API_KEY ?? "");
if (!apiKey) throw new Error("DTIS_API_KEY is missing from the credentials file");

const mqttPassword = (await readFile(config.mqttPasswordFile, "utf8")).trimEnd();
if (!mqttPassword) throw new Error("MQTT password is empty");

const app = express();
app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  });
  next();
});

const live = { connected: false, latest: null, samples: [], received: 0, lastError: null };
const streams = new Set();
const mqttClient = mqtt.connect(config.mqttUrl, {
  username: config.mqttUsername,
  password: mqttPassword,
  clientId: `oid-console-${config.twinId.slice(2, 14)}`,
  clean: true,
  connectTimeout: 10_000,
  reconnectPeriod: 5_000
});

mqttClient.on("connect", async () => {
  live.connected = true;
  live.lastError = null;
  await mqttClient.subscribeAsync(config.mqttTopic, { qos: 1 });
  log("mqtt_subscribed", { topic: config.mqttTopic });
});
mqttClient.on("offline", () => { live.connected = false; broadcast("status", publicLive()); });
mqttClient.on("close", () => { live.connected = false; });
mqttClient.on("error", (error) => { live.lastError = error.message; log("mqtt_error", { error: error.message }); });
mqttClient.on("message", (_topic, payload) => {
  try {
    const sample = JSON.parse(payload.toString());
    if (sample.assetId && sample.assetId !== config.twinId) return;
    live.latest = sample;
    live.received += 1;
    live.samples.push(sample);
    if (live.samples.length > 60) live.samples.shift();
    broadcast("telemetry", { sample, received: live.received });
  } catch (error) {
    live.lastError = `Invalid telemetry JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
});

app.get("/healthz", (_request, response) => response.json({ status: "ok", mqtt: live.connected }));
app.get("/api/meta", (_request, response) => response.json({
  twinId: config.twinId, network: config.network, packageId: config.packageId, mqttTopic: config.mqttTopic
}));
app.get("/api/telemetry", (_request, response) => response.json(publicLive()));
app.get("/api/live", (request, response) => {
  response.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.flushHeaders();
  response.write(`event: snapshot\ndata: ${JSON.stringify(publicLive())}\n\n`);
  streams.add(response);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
  request.on("close", () => { clearInterval(heartbeat); streams.delete(response); });
});

app.get("/api/dashboard", async (_request, response) => {
  const twinPath = `/api/v1/twins/${encodeURIComponent(config.twinId)}`;
  const [health, readiness, twin, thread, verification, report, identifiers] = await Promise.all([
    fetchJson("/health", false),
    fetchJson("/ready", false),
    fetchJson(twinPath),
    fetchJson(`${twinPath}/thread?limit=100`),
    fetchJson(`${twinPath}/thread/verify?limit=100`),
    fetchJson(`${twinPath}/thread/verify/report?limit=100`),
    fetchJson(`${twinPath}/identifiers`)
  ]);
  response.set("Cache-Control", "no-store").json({
    generatedAt: new Date().toISOString(),
    meta: { twinId: config.twinId, network: config.network, packageId: config.packageId },
    health, readiness, twin, thread, verification, report, identifiers,
    telemetry: publicLive()
  });
});

const staticRoot = resolve(__dirname, "../dist");
app.use(express.static(staticRoot, { immutable: true, maxAge: "1y", index: false }));
app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
  response.set("Cache-Control", "no-cache").sendFile(resolve(staticRoot, "index.html"));
});
app.use((_request, response) => response.status(404).json({ error: "Not found" }));

const server = app.listen(config.port, "0.0.0.0", () => log("console_started", { port: config.port, twinId: config.twinId }));

async function fetchJson(path, authenticated = true) {
  try {
    const headers = authenticated ? { "x-api-key": apiKey } : {};
    const upstream = await fetch(`${config.apiBaseUrl}${path}`, { headers, signal: AbortSignal.timeout(12_000) });
    const contentType = upstream.headers.get("content-type") ?? "";
    const data = contentType.includes("json") ? await upstream.json() : await upstream.text();
    return upstream.ok ? { ok: true, status: upstream.status, data } : { ok: false, status: upstream.status, error: errorMessage(data) };
  } catch (error) {
    return { ok: false, status: 503, error: error instanceof Error ? error.message : String(error) };
  }
}

function publicLive() {
  return { connected: live.connected, latest: live.latest, samples: live.samples, received: live.received, lastError: live.lastError };
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const stream of streams) stream.write(message);
}

function errorMessage(value) {
  if (value && typeof value === "object") return String(value.message ?? value.error?.message ?? value.code ?? "Upstream request failed");
  return String(value || "Upstream request failed");
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} is invalid`);
  return value;
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

async function shutdown(signal) {
  log("shutdown", { signal });
  for (const stream of streams) stream.end();
  await mqttClient.endAsync().catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
