# Digital Twin Responsibility Matrix

| Concern | Move / IOTA | Integration Server | External System |
|---|---|---|---|
| Identity and authority | Identity package, ControllerCap | Authenticates caller and reads grants | Identity governance |
| Credit payment | Credit package and operation policy | Submits paid mutations | Credit provisioning |
| Twin state/provenance | OIDTwin objects and events | Validation, transport, orchestration | Source data quality |
| Digital Thread | OIDTwinEvent is authoritative | Index, filter, verify, export evidence | Audit acceptance/signing |
| Identifier mappings | Authoritative mapping objects | Indexed global/cross-scheme resolution | Identifier registries |
| OPC-UA/MQTT/REST | Interface metadata | Secure connectors and queue mapping | Physical endpoint |
| Raw telemetry | Hash/reference only | Routes and aggregates | Authoritative payload storage |
| CAD/simulation/model data | Hash/reference only | Registers model references | Authoritative model repository |
| Maturity | Assessment/indicator records | Profile evaluation and evidence references | Normative profile approval/certification |
| Indexer | Chain remains source of truth | Replaceable read-model client | Persistent index/checkpoints |

The server has no authoritative ACL or Twin database. Redis, cache, queue, object storage, and an indexer are ephemeral or derived infrastructure.
