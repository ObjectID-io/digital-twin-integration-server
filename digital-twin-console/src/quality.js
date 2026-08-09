export const LIFECYCLE = {
  1: "Design", 2: "Manufacturing", 3: "Assembly", 4: "Testing", 5: "Commissioning",
  6: "Operation", 7: "Maintenance", 8: "Repair", 9: "Decommissioned", 10: "Archived"
};

export function fieldsOf(value) {
  return value?.data?.content?.fields ?? value?.content?.fields ?? value?.fields ?? value ?? {};
}

export function textOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  const bytes = Array.isArray(value) ? value : Array.isArray(value.bytes) ? value.bytes : null;
  if (bytes?.every((item) => Number.isInteger(item))) {
    try { return new TextDecoder().decode(new Uint8Array(bytes)); } catch { return String(value); }
  }
  if (Array.isArray(value.vec)) return value.vec.length ? textOf(value.vec[0]) : "";
  return JSON.stringify(value);
}

export function runQualityChecks({ twin, telemetry, verification, readiness, expectedTwinId }) {
  const fields = fieldsOf(twin);
  const twinId = textOf(twin?.data?.objectId ?? twin?.objectId ?? fields.id ?? expectedTwinId);
  const lifecycle = Number(fields.lifecycle_state ?? fields.lifecycleState ?? 0);
  const revision = Number(fields.revision ?? 0);
  const createdAt = Number(fields.created_at ?? fields.createdAt ?? 0);
  const updatedAt = Number(fields.updated_at ?? fields.updatedAt ?? 0);
  const dids = [fields.creator_did, fields.owner_did, fields.steward_did, fields.twin_did].map(textOf).filter(Boolean);
  const observedAt = telemetry?.observedAt ? Date.parse(telemetry.observedAt) : NaN;
  const ageSeconds = Number.isFinite(observedAt) ? Math.max(0, (Date.now() - observedAt) / 1000) : Infinity;
  const measurements = telemetry?.measurements ?? {};
  const numericMeasurements = Object.values(measurements).filter((item) => Number.isFinite(Number(item?.value))).length;

  return [
    check("OID-01", "Object identity", Boolean(twinId) && twinId === expectedTwinId, "Congruity", twinId ? "Object ID matches the monitored Twin" : "Object ID unavailable"),
    check("OID-02", "Encoded lifecycle", lifecycle >= 1 && lifecycle <= 10, "Congruity", lifecycle ? `State ${lifecycle}: ${LIFECYCLE[lifecycle] ?? "unrecognized"}` : "Lifecycle unavailable"),
    check("OID-03", "Monotonic revision", revision >= 1, "Consistency", revision ? `On-chain revision ${revision}` : "Revision unavailable"),
    check("OID-04", "Temporal order", !createdAt || !updatedAt || updatedAt >= createdAt, "Consistency", createdAt && updatedAt ? "updated_at does not precede created_at" : "Root timestamps not exposed", createdAt && updatedAt ? undefined : "warn"),
    check("ID-01", "Responsibility DIDs", dids.length > 0 && dids.every((did) => did.startsWith("did:")), "Congruity", dids.length ? `${dids.length} syntactically valid DIDs` : "DIDs not exposed", dids.length ? undefined : "warn"),
    check("DT-01", "Digital Thread continuity", verification?.valid === true, "Consistency", verification?.valid === true ? `${verification.eventCount ?? 0} verified events` : verification?.reason ?? "Verification unavailable", verification ? undefined : "warn"),
    check("TEL-01", "Telemetry association", telemetry?.assetId === expectedTwinId, "Congruity", telemetry ? "Sample assetId matches the OIDTwin" : "Waiting for the first sample", telemetry ? undefined : "warn"),
    check("TEL-02", "Observation freshness", ageSeconds <= 30, "Consistency", Number.isFinite(ageSeconds) ? `Latest sample received ${Math.round(ageSeconds)} s ago` : "Telemetry timestamp missing", Number.isFinite(ageSeconds) ? undefined : "warn"),
    check("TEL-03", "Interpretable measurements", numericMeasurements >= 5, "Congruity", `${numericMeasurements}/5 expected numeric measurements`),
    check("SYS-01", "Required dependencies", readiness?.ready === true, "Consistency", readiness?.ready ? "ObjectID, profiles, MQTT and storage operational" : "A required dependency is not ready")
  ];
}

function check(id, label, passed, group, evidence, override) {
  return { id, label, group, evidence, status: override ?? (passed ? "pass" : "fail") };
}

export function qualityScore(checks) {
  const considered = checks.filter((item) => item.status !== "warn");
  if (!considered.length) return 0;
  return Math.round(considered.filter((item) => item.status === "pass").length / considered.length * 100);
}
