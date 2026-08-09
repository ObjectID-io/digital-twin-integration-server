import type { AppConfig } from "../config/types.js";
import type { PaginationOptions, TwinIndexer } from "../indexer/types.js";
import { AUDIT_REPORT_FORMAT_VERSION, DIGITAL_THREAD_VERIFIER_VERSION, IncrementalThreadVerifier, canonicalHash } from "./verifier.js";

export class DigitalThreadService {
  constructor(private readonly indexer: TwinIndexer, private readonly config?: AppConfig) {}
  getDigitalThread(twinId: string, options?: PaginationOptions) { return this.indexer.findTwinEvents(twinId, options); }

  async verifyDigitalThread(twinId: string, options: PaginationOptions = {}) {
    const verifier = new IncrementalThreadVerifier(twinId, options);
    let cursor = options.cursor;
    const seenCursors = new Set<string>();
    while (true) {
      const page = await this.indexer.findTwinEvents(twinId, { ...options, cursor, limit: options.limit ?? 100 });
      await verifier.appendPage(page.items, this.indexer.transactionExists?.bind(this.indexer));
      if (page.complete === false) return verifier.finish(false, page.reason);
      if (!page.hasMore) return verifier.finish(true);
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) return verifier.finish(false, "Indexer returned hasMore without a new cursor");
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async createEvidenceReport(twinId: string, options?: PaginationOptions) {
    const verification = await this.verifyDigitalThread(twinId, options);
    const report = {
      reportFormatVersion: AUDIT_REPORT_FORMAT_VERSION, verifierVersion: DIGITAL_THREAD_VERIFIER_VERSION,
      generatedAt: new Date().toISOString(), network: this.config?.objectid.network ?? "unknown",
      packageId: this.config?.objectid.packageId ?? "unknown", twinId,
      revisionRange: { first: verification.firstRevision, last: verification.lastRevision }, verification,
      evidenceHash: { algorithm: "SHA-256", serialization: "RFC8785-JCS", representation: "ObjectID canonical on-chain event fields", digest: verification.eventEvidenceDigest },
      signature: null,
      disclaimer: "Canonical technical evidence hash, not a digital signature or ISO certification statement.",
    };
    return { ...report, reportHash: canonicalHash(report) };
  }
}
