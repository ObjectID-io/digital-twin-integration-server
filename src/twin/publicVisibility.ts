export function isPublicObjectIdTwin(value: unknown, packageId: string) {
  const object = asRecord(value);
  const data = asRecord(object.data);
  const type = stringValue(data.type ?? object.type);
  const expectedType = `${packageId}::oid_twin::OIDTwin`.toLowerCase();
  if (!type || type.toLowerCase() !== expectedType) return false;

  const content = asRecord(data.content ?? object.content);
  const fields = asRecord(content.fields ?? object.fields);
  const metadata = parseMetadata(fields.mutable_metadata ?? fields.mutableMetadata);
  const objectIdMetadata = asRecord(metadata.objectid);
  return objectIdMetadata.visibility === "public" || metadata.visibility === "public";
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try { return asRecord(JSON.parse(value)); }
  catch { return {}; }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
