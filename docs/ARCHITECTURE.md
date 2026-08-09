# Architecture

```text
Industrial / Enterprise Systems
          |
          v
Connectors (REST, MQTT, plugins)
          |
          v
Mapping / Validation
          |
          v
Ephemeral Queue / Dataset Windows
          |
     +----+---------+----------------+
     |              |                |
 Resolver       Maturity       StorageRouter
 Thread/Policy      |          /     |      \
     |              |    filesystem NAS  S3/MinIO
     +--------------+--------- URI + SHA-256
                    |
             ObjectID SDK adapter
                    |
                    v
                ObjectID / IOTA
```

The HTTP layer owns transport concerns. Services depend on `ObjectIdAdapter`,
so test doubles, indexers and future SDK releases can be substituted without
duplicating Move transaction construction.

The adapter name denotes the broader ObjectID SDK boundary. Digital Twin
mutations target the autonomous `oid_twin` package directly; they do not create,
borrow or mutate a generic `OIDObject`. Identity capabilities and Credit remain
shared SDK infrastructure.

HTTP mutations execute authentication, caller DID resolution, Twin/role-grant
loading, local policy fail-fast, ObjectID mutation and definitive Move checks.
MQTT mutations execute mapping, queueing and worker dispatch. Temporary errors
use bounded backoff; ambiguous outcomes require an adapter status check before
retry and otherwise become failed jobs.

Dataset mode buffers samples in an ephemeral time window, serializes one JSON
dataset, routes it to the configured external provider, hashes the exact stored
bytes, then queues `addDataset` with URI/hash metadata. Models, inline maturity
evidence and event payloads use the same category router. Shutdown
stops subscriptions, attempts window flush, drains/stops the worker, disconnects
connectors and closes optional Redis.

`ConnectorFactory` provides REST and MQTT built-ins. OPC-UA, Modbus and
WebSocket are explicit plugin entries but are not implemented. Large telemetry,
CAD, models and evidence remain external; ObjectID records identity, trust,
provenance, revision and Digital Thread evidence.
# ISO/TS 25271 Physical/Digital Boundary

```text
Physical Twin
    <-> MQTT / OPC-UA / REST
    <-> Stateless Integration Server
    <-> OIDTwinInterface
    <-> OIDTwin
```

The Integration Server is stateless. The external `TwinIndexer` is a derived read model with checkpoint/resume/rebuild support; IOTA/ObjectID remains authoritative.
