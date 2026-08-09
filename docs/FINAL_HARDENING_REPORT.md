# Final Hardening Report

## Executive Summary

The V1 server now has a scalable indexed read boundary, complete paginated Digital Thread verification, coherent native owner/steward authorization, typed profiles, explicit OME Aspect binding, observable OPC-UA behavior, and canonical audit evidence. No Move source, struct, or package manifest was changed in this hardening phase.

## Implementation Status

| Feature | Status | Evidence | Limitation |
|---|---|---|---|
| Indexer abstraction | IMPLEMENTED | `src/indexer/types.ts` | Storage-neutral only |
| ObjectID indexed provider | PARTIAL | `ObjectIdIndexerAdapter` delegation | Provider method availability is external |
| Persistent read model | NOT_IMPLEMENTED | Explicit external boundary | No bundled PostgreSQL/SQLite/OpenSearch |
| Provider-side pagination | IMPLEMENTED | 1,500-event acceptance test | Provider must honor cursor/filter contract |
| Full Thread verification | IMPLEMENTED | >500 and cross-page tests | RPC transaction checks remain provider-dependent |
| Transaction verification | IMPLEMENTED | VERIFIED/PARTIAL/FAILED/NOT_VERIFIED tests | Digest/RPC availability varies |
| Native owner/steward policy | IMPLEMENTED | Policy and API tests | Move remains final authority |
| RoleGrant policy | IMPLEMENTED | Validity-window/action tests | Grant is a V1 stakeholder declaration on-chain |
| Typed Profile Registry | IMPLEMENTED | Profile type tests | Profiles remain experimental |
| OME Aspect binding | IMPLEMENTED | End-to-end API test | Normative completeness NOT_VERIFIED |
| OPC-UA | IMPLEMENTED | connect/read/write/health/subscription tests | Live vendor and session-recreation testing external |
| Modbus | PLUGIN_READY | Connector factory | NOT_IMPLEMENTED |
| WebSocket | PLUGIN_READY | Connector factory | NOT_IMPLEMENTED |
| Canonical JCS evidence | IMPLEMENTED | canonical hash tests | Original BCS unavailable consistently |
| ISO/IEC 30188 mapping | NOT_VERIFIED | Conformance matrix | Edition/publication status tracked separately |

## Authorization Decision

Move source inspection shows `owner_did` and `steward_did` are native `OIDTwin` fields, initialized at creation and checked by `assert_actor_authorized`. `OIDTwinRoleGrant` objects are separate stakeholder declarations and are not automatically created for owner/steward. Server authorization therefore accepts native owner, native steward, or a valid action-specific RoleGrant. Expired, absent, unrelated, and AUDITOR mutation grants are denied. This mirrors server policy without weakening the final Move transaction checks.

## Digital Thread and Evidence

`GET /api/v1/twins/{id}/thread` delegates cursor, revision, event-type, and timestamp filters to the indexer. Verification iterates every page, carries continuity state across boundaries, and returns `valid: null` whenever enumeration is incomplete. Explicit revision ranges are reported as their own complete scope. Reports use versioned JCS/SHA-256 evidence and tri-state transaction accounting.

## OPC-UA Hardening

Health performs a timeout-bounded read of the Server CurrentTime node. Connection, read, write, subscription event, and callback-error metrics are exported. Callback failures are classified and logged rather than swallowed. `node-opcua` connection strategy provides transport reconnection; full session recreation/subscription recovery is `PARTIAL` until validated against live servers. Credentials continue to resolve through CredentialProvider/environment/mounted secrets and are redacted from logs.

## Source Hygiene and Artifacts

Dependencies, builds, coverage, temporary reports, data, secrets, and logs are excluded from source packaging. Generated conformance/alignment reports are CI artifacts; only selected human-readable evidence may be versioned. No customer data is included.

## Remaining Limitations

The persistent indexer implementation, checkpoint durability, live IOTA RPC verification, OPC-UA vendor interoperability, session recreation, and formal standards review remain external or provider-dependent. The project provides an ISO alignment evidence framework, not certification or a complete clause-by-clause conformity claim.
