import { createDecipheriv, createCipheriv, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { AppError } from "../common/errors.js";
import { positionFromPayload } from "../realtime/position.js";
import { simulationContext, energyKeys } from './simulation.js';
const derive = promisify(scrypt);
export const deviceError = (code: string, status = 422): never => { throw new AppError(code, code, status, "VALIDATION"); };
export interface Signal { key: string; source: string; name: string; unit: string; type: string }
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
export function discoverSignals(payload: unknown): Array<Signal & { value: unknown }> {
  const rows: Array<Signal & { value: unknown }> = [];
  function visit(value: any, path: string[], depth: number) {
    if (depth > 8 || rows.length >= 100) return;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (Object.hasOwn(value, "value") && ["number", "string", "boolean"].includes(typeof value.value)) {
        add(value.value, [...path, "value"], typeof value.unit === "string" ? value.unit : "", path.at(-1)); return;
      }
      for (const [key, child] of Object.entries(value)) if (!forbidden.has(key)) visit(child, [...path,key], depth + 1);
    } else if (["number","boolean","string"].includes(typeof value)) add(value, path, "");
  }
  function add(value: any, path: string[], unit: string, label = path.at(-1)) {
    if (typeof value === "number" && !Number.isFinite(value)) return;
    rows.push({ key: path.filter(p => p !== "value").join("_").replace(/[^a-zA-Z0-9_]/g,"_"),
      source: "/" + path.map(p => p.replace(/~/g,"~0").replace(/\//g,"~1")).join("/"),
      name: String(label || "value").slice(0,128), unit: unit.slice(0,32), type: typeof value, value });
  }
  visit(payload, [], 0);
  return rows;
}
export function classifySignals(input: unknown, payload: unknown): Signal[] {
  if (!Array.isArray(input) || !input.length || input.length > 100) return deviceError("SIGNALS_REQUIRED");
  const candidates = new Map(discoverSignals(payload).map(row => [row.source,row]));
  const keys = new Set();
  return input.map(raw => {
    if (!raw || typeof raw !== "object") return deviceError("SIGNAL_INVALID");
    const found = candidates.get(raw.source);
    if (!found || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(raw.key) || forbidden.has(raw.key) || keys.has(raw.key) ||
        typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 128 ||
        typeof raw.unit !== "string" || raw.unit.length > 32) return deviceError("SIGNAL_INVALID");
    keys.add(raw.key);
    return { key: raw.key, source: found.source, name: raw.name.trim(), unit: raw.unit, type: found.type };
  });
}
export function classifyPayload(payload: unknown, signals: Signal[]) {
  const values = new Map(discoverSignals(payload).map(row => [row.source,row]));
  // Position is structured telemetry, not a scalar signal. Validate it separately
  // and retain only the supported fields in the payload format used by realtime.
  const position = positionFromPayload(payload, Date.now());
  return { ...simulationContext(payload), ...(position ? { position: {
    type: position.type, coordinates: position.coordinates, crs: position.crs, observedAt: position.observedAt,
    ...(position.accuracyMeters === undefined ? {} : { accuracy: { value: position.accuracyMeters, unit: "m" } }),
    ...(position.speedKph === undefined ? {} : { speed: { value: position.speedKph, unit: "km/h" } }),
    ...(position.headingDegrees === undefined ? {} : { heading: { value: position.headingDegrees, unit: "deg" } }),
  } } : {}), measurements: Object.fromEntries(signals.flatMap(signal => {
    const current = values.get(signal.source);
    const sourceKey = /^\/measurements\/([a-zA-Z]+)\/value$/.exec(signal.source)?.[1];
    return current && current.type === signal.type ? [[signal.key, { value: current.value, unit: signal.unit, label: signal.name,
      ...(sourceKey && energyKeys.has(sourceKey) ? { semanticKey: sourceKey } : {}) }]] : [];
  })) };
}
export async function decodeDevicePayload(payload: any, password?: string): Promise<unknown> {
  if (!payload?.encrypted) return payload;
  if (!password || password.length > 1024) return deviceError("DEVICE_DECRYPTION_PASSWORD_REQUIRED", 403);
  if (payload.algorithm !== "AES-256-GCM") return deviceError("DEVICE_ENCRYPTION_UNSUPPORTED");
  try {
    const salt = Buffer.from(String(payload.salt || ""),"base64"), nonce = Buffer.from(String(payload.nonce || ""),"base64"), tag = Buffer.from(String(payload.authTag || ""),"base64");
    if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16 || typeof payload.ciphertext !== "string") throw Error();
    const key = await derive(password, salt, 32) as Buffer;
    const decipher = createDecipheriv("aes-256-gcm",key,nonce); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.ciphertext,"base64")),decipher.final()]).toString("utf8"));
  } catch { return deviceError("DEVICE_DECRYPTION_FAILED",403); }
}
export async function encodeDevicePayload(payload: unknown, password: string) {
  const salt = randomBytes(16), nonce = randomBytes(12), key = await derive(password,salt,32) as Buffer;
  const cipher = createCipheriv("aes-256-gcm",key,nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload),"utf8"),cipher.final()]);
  return { encrypted:true, algorithm:"AES-256-GCM", salt:salt.toString("base64"), nonce:nonce.toString("base64"),
    authTag:cipher.getAuthTag().toString("base64"), ciphertext:ciphertext.toString("base64") };
}
