# ISO Alignment Responsibilities

This architecture is designed for alignment with the listed concepts. It is
not a certification or clause-by-clause conformity assessment.

| Standard | On-chain ObjectID responsibility | Integration Server responsibility | External system responsibility |
|---|---|---|---|
| ISO/IEC 30173 | Twin identity, lifecycle, roles and provenance | Functional integration and stakeholder workflow | Physical/business lifecycle source |
| ISO/IEC 30181 | Identifier and mapping evidence | Resolver, conversion orchestration and cache | ERP/MES/GS1 identifier authority |
| ISO/IEC 30186 | Assessment objects, indicators and evidence hashes | Profile-driven scoring and validation | Assessment documents and evidence |
| ISO/IEC 30188 | Root/child architecture and immutable history | Connector and architecture-view orchestration | Operational systems and data |
| ISO 23247-1 | Autonomous Twin identity and lifecycle | Manufacturing profile validation | Manufacturing process authority |
| ISO 23247-2 | Twin entities, aspects, interfaces, models | Functional entity integration | Device/user/service implementations |
| ISO 23247-3 | OME aspect/schema references | OME profile registry and validation | OME attribute sources |
| ISO 23247-4 | Interface protocol/network semantics | REST/MQTT adaptation and security policy | Network and device communication |
| ISO 23247-5 | Revisioned `OIDTwinEvent[]` evidence | Digital Thread retrieval and verification | Business event sources |
| ISO 23247-6 | Composition and member evidence | Composition orchestration | Component Twin owners/systems |

Telemetry streams, protocol traffic, CAD, simulation and large datasets stay
off-chain. The server is an interoperability layer, not a Twin platform.

Implementation status must not be inferred from conceptual alignment. REST and
MQTT are implemented; global resolution depends on an ObjectID indexer; OPC-UA
and Modbus are plugin-ready but not implemented. This document is not an ISO
certification or conformity statement.
# Evidence Status

The detailed status is maintained in `ISO_CONFORMANCE_MATRIX.md` and `iso-conformance-matrix.json`. Clause mappings remain `NOT_VERIFIED` where full normative text has not been reviewed. OME and maturity manifests remain `experimental`; passing technical tests does not promote their normative status.
