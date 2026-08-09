import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.x-api-key",
      "password",
      "privateKey",
      "private_key",
      "accessToken",
      "access_token",
      "apiSecret",
      "api_secret",
      "secretAccessKey",
      "connectionString",
      "connection_string",
      "sasToken",
      "sas_token",
      "seed",
    ],
    censor: "[REDACTED]",
  },
});

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /password|secret|token|private.?key|authorization|seed|connection.?string|sas/i.test(key) ? "[REDACTED]" : redactSecrets(item),
  ]));
}
