export function isPublicObjectIdTwin(value: unknown, packageId: string) {
  return objectIdTwinPublicAccess(value, packageId).twinPublic;
}

export function objectIdTwinPublicAccess(value: unknown, packageId: string) {
  const object = asRecord(value);
  const data = asRecord(object.data);
  const type = stringValue(data.type ?? object.type);
  const expectedType = `${packageId}::oid_twin::OIDTwin`.toLowerCase();
  if (!type || type.toLowerCase() !== expectedType) return { twinPublic: false, dataPublic: false, liveLocationPublic: false };

  const content = asRecord(data.content ?? object.content);
  const fields = asRecord(content.fields ?? object.fields);
  const metadata = parseMetadata(fields.mutable_metadata ?? fields.mutableMetadata);
  const objectIdMetadata = asRecord(metadata.objectid);
  const twinPublic = objectIdMetadata.visibility === "public" || metadata.visibility === "public";
  const dataPublic = twinPublic && (objectIdMetadata.dataVisibility === "public" || metadata.dataVisibility === "public");
  const liveLocationPolicy = objectIdMetadata.liveLocationVisibility ?? metadata.liveLocationVisibility;
  // Legacy public-data Twins already expose position inside realtime/latest.
  // Preserve that access until the owner writes an explicit location policy.
  const liveLocationPublic = twinPublic && (liveLocationPolicy === "public" || (liveLocationPolicy == null && dataPublic));
  return { twinPublic, dataPublic, liveLocationPublic };
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
