import { Readable } from "node:stream";

export async function toBuffer(data: Buffer | Readable) {
  if (Buffer.isBuffer(data)) return data;
  const chunks: Buffer[] = [];
  for await (const chunk of data) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function safeSegment(value: string | undefined, fallback: string) {
  const cleaned = String(value ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

export function categoryDirectory(category = "artifact") {
  const normalized = safeSegment(category, "artifact");
  const known: Record<string, string> = {
    dataset: "datasets", model: "models", evidence: "evidence", artifact: "artifacts", "event-payload": "event-payloads",
  };
  return known[normalized] ?? normalized;
}
