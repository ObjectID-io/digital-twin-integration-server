# Canonical Audit Evidence

Digital Thread evidence uses SHA-256 over RFC 8785 JSON Canonicalization Scheme (JCS). The canonical event representation contains the semantic on-chain fields `eventId`, `twinId`, `eventType`, `revisionBefore`, `revisionAfter`, `actorDid`, `payloadRef`, `payloadHash`, and `createdAt`.

`transactionDigest` is excluded from the event hash because it is indexer/RPC metadata rather than an `OIDTwinEvent` field. UI metadata, fetch timestamps, cache fields, and local enrichments are also excluded. BCS would provide stronger byte-level chain evidence, but the current ObjectID provider does not expose original event BCS consistently; JCS is therefore the documented V1 representation.

The report declares `reportFormatVersion`, `verifierVersion`, serialization metadata, an incremental event digest, and `reportHash = SHA-256(JCS(report without reportHash))`. `signature: null` is an extension point for a future DID/VC signature. Neither hash is a digital signature.
