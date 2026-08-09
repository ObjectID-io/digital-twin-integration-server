# ISO Conformance Matrix

This is a technical traceability matrix for an **ISO-aligned** design. It is not a certification or a declaration of full ISO compliance. The full normative texts were not available for clause-by-clause verification, so clause references are deliberately recorded as `NOT_VERIFIED`.

| Standard | Clause / requirement | Summary | Responsibility | Components | Status | Evidence | Test ID | Notes |
|---|---|---|---|---|---|---|---|---|
| ISO/IEC 30173 | NOT_VERIFIED / ARCH-30173-READ-MODEL | Authority/read-model separation | Shared | OIDTwin, TwinIndexer | PARTIAL | `src/indexer/`, architecture | DT-30173-001 | Full normative review required |
| ISO/IEC 30181 | NOT_VERIFIED / ID-30181-RESOLUTION | Identifier and mapping resolution | Move + Server | OIDTwinIdentifier, IdentifierResolver | PARTIAL | resolver/indexer | DT-30181-001, 002 | External indexer required in production |
| ISO/IEC 30186 | NOT_VERIFIED / MAT-30186-PROFILE | Versioned maturity evaluation | Move + Server | assessment objects, MaturityEngine | NOT_VERIFIED | example profile/engine | DT-30186-001, 002 | Values are non-normative |
| ISO/IEC 30188 | NOT_VERIFIED / ARCH-30188-REFERENCE | Reference architecture tracking | Shared | Move + Server architecture | NOT_VERIFIED | `ISO_ALIGNMENT.md` | none | Publication/edition status tracked separately; no speculative component added |
| ISO 23247-1 | NOT_VERIFIED / DT-23247-1-SCOPE | Manufacturing Twin boundary | Shared | OIDTwin, OIDTwinInterface | PARTIAL | architecture | none | Terminology mapping only |
| ISO 23247-2 | NOT_VERIFIED / DT-23247-2-MODEL | Core entities and lifecycle | Move | current Move objects | PARTIAL | data model | none | Complete mapping pending |
| ISO 23247-3 | NOT_VERIFIED / DT-23247-3-OME | OME payload validation | Server | profile registry | PARTIAL | OME profile | DT-23247-3-001, 002 | Experimental profile |
| ISO 23247-4 | NOT_VERIFIED / DT-23247-4-NETWORK | Network/transport independence | Move + Server | interfaces, MQTT, OPC-UA | PARTIAL | connector code/profiles | DT-23247-4-001, 002 | Live certification external |
| ISO 23247-5 | NOT_VERIFIED / DT-23247-5-THREAD | Thread reconstruction and verification | Move + Server | OIDTwinEvent, verifier/indexer | PARTIAL | verifier and audit report | DT-23247-5-001..003 | Provider-dependent transaction checks |
| ISO 23247-6 | NOT_VERIFIED / DT-23247-6-COMPOSITION | Composition lifecycle | Move + Server | composition objects/events | PARTIAL | Move + validation | DT-23247-6-001, 002 | Chain remains authoritative |
| ISO/TS 25271 | NOT_VERIFIED / PT-25271-BOUNDARY | Physical/interface/digital path | Shared | asset, connectors, interface, Twin | PARTIAL | architecture | DT-23247-4-002 | Asset quality is external |

The machine-readable source used by automated reporting is [`iso-conformance-matrix.json`](./iso-conformance-matrix.json).
