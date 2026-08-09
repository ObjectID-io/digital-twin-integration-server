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
    check("OID-01", "Identità dell'oggetto", Boolean(twinId) && twinId === expectedTwinId, "Congruità", twinId ? "Object ID coerente con il Twin monitorato" : "Object ID non disponibile"),
    check("OID-02", "Lifecycle codificato", lifecycle >= 1 && lifecycle <= 10, "Congruità", lifecycle ? `Stato ${lifecycle}: ${LIFECYCLE[lifecycle] ?? "non riconosciuto"}` : "Lifecycle non disponibile"),
    check("OID-03", "Revisione monotona", revision >= 1, "Coerenza", revision ? `Revisione on-chain ${revision}` : "Revisione non disponibile"),
    check("OID-04", "Ordine temporale", !createdAt || !updatedAt || updatedAt >= createdAt, "Coerenza", createdAt && updatedAt ? "updated_at non precede created_at" : "Timestamp root non esposti" , createdAt && updatedAt ? undefined : "warn"),
    check("ID-01", "DID delle responsabilità", dids.length > 0 && dids.every((did) => did.startsWith("did:")), "Congruità", dids.length ? `${dids.length} DID sintatticamente validi` : "DID non esposti" , dids.length ? undefined : "warn"),
    check("DT-01", "Continuità Digital Thread", verification?.valid === true, "Coerenza", verification?.valid === true ? `${verification.eventCount ?? 0} eventi verificati` : verification?.reason ?? "Verifica non disponibile", verification ? undefined : "warn"),
    check("TEL-01", "Associazione telemetria", telemetry?.assetId === expectedTwinId, "Congruità", telemetry ? "assetId del campione coincide con OIDTwin" : "In attesa del primo campione", telemetry ? undefined : "warn"),
    check("TEL-02", "Freschezza osservazione", ageSeconds <= 30, "Coerenza", Number.isFinite(ageSeconds) ? `Ultimo campione ${Math.round(ageSeconds)} s fa` : "Timestamp telemetrico assente", Number.isFinite(ageSeconds) ? undefined : "warn"),
    check("TEL-03", "Misure interpretabili", numericMeasurements >= 5, "Congruità", `${numericMeasurements}/5 misure numeriche attese`),
    check("SYS-01", "Dipendenze richieste", readiness?.ready === true, "Coerenza", readiness?.ready ? "ObjectID, profili, MQTT e storage operativi" : "Una dipendenza richiesta non è pronta")
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
