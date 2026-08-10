import canonicalize from "canonicalize";

export function canonicalEvent(event) {
  return {
    eventId: event.eventId,
    twinId: event.twinId,
    eventType: event.eventType,
    revisionBefore: event.revisionBefore,
    revisionAfter: event.revisionAfter,
    actorDid: event.actorDid,
    payloadRef: event.payloadRef,
    payloadHash: event.payloadHash,
    createdAt: event.createdAt,
  };
}

export async function canonicalHash(value) {
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new TypeError("Value cannot be represented by RFC 8785 JCS");
  return sha256(serialized);
}

export async function validateAuditEvidence(events, verification, report) {
  const eventHashes = await Promise.all(events.map(async (event) => ({
    eventId: event.eventId,
    revision: event.revisionAfter,
    digest: await canonicalHash(canonicalEvent(event)),
  })));
  const calculatedEvidenceDigest = await sha256(eventHashes.map((item) => item.digest).join(""));
  const expectedEvidenceDigest = verification?.eventEvidenceDigest ?? report?.evidenceHash?.digest;
  const { reportHash: expectedReportHash, ...unsignedReport } = report ?? {};
  const calculatedReportHash = report ? await canonicalHash(unsignedReport) : null;
  const metadataValid = report?.verifierVersion === "1.1.0"
    && report?.reportFormatVersion === "1.0"
    && report?.evidenceHash?.serialization === "RFC8785-JCS";

  return {
    verifier: {
      status: metadataValid && verification?.valid === true && verification?.complete === true ? "VERIFIED" : "PARTIAL",
      metadataValid,
    },
    evidence: {
      status: expectedEvidenceDigest
        ? calculatedEvidenceDigest === expectedEvidenceDigest ? "VERIFIED" : "FAILED"
        : "UNAVAILABLE",
      expected: expectedEvidenceDigest,
      calculated: calculatedEvidenceDigest,
      eventHashes,
    },
    report: {
      status: expectedReportHash
        ? calculatedReportHash === expectedReportHash ? "VERIFIED" : "FAILED"
        : "UNAVAILABLE",
      expected: expectedReportHash,
      calculated: calculatedReportHash,
    },
  };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
