# ObjectID Digital Twin Stateless Integration Server

## Purpose

Local-first integration and interoperability layer between PLC/IoT/enterprise
systems and the ObjectID Digital Twin package. It is not a Twin database, MES,
SCADA, time-series store, CAD or simulation platform.

## Architecture

```text
PLC / MQTT / REST / MES / ERP / PLM / CMMS
                    |
             connector plugins
                    |
       validation / mapping / orchestration
             /                  \
 off-chain storage          ObjectID adapter
             \                  /
        URI + SHA-256 metadata / IOTA
```

## Why Stateless

Authoritative state remains on ObjectID/IOTA and in external source systems.
Memory cache, in-memory queues, dataset windows and local idempotency records
are disposable. Optional Redis coordinates idempotency across replicas but is
never authoritative. Off-chain storage is an independent repository selected
by configuration; ObjectID stores its URI, SHA-256 and provenance.

## Quick Start

```bash
cp config/config.example.yaml config/config.yaml
npm ci
npm run build
npm start
```

Open `http://localhost:8080/docs`, `/openapi.json`, `/health`, `/ready` or
`/metrics`.

## Configuration

YAML is loaded from `DTIS_CONFIG`. `DTIS_*` environment variables override
server, ObjectID, profile, security and data settings. Connector strings such
as `${credential:MQTT_PASSWORD}` are resolved by the selected environment or
JSON file credential provider and never written on-chain.

`storage` selects one or more named filesystem or S3-compatible providers and
routes categories such as `dataset`, `model`, `evidence`, `artifact` and
`event-payload`. A mounted NAS uses the filesystem provider. See
[STORAGE.md](docs/STORAGE.md) and `config/examples/`.

## Docker

```bash
docker build -t objectid/digital-twin-integration-server:local .
docker run --rm -p 8080:8080 \
  -v "$PWD/config:/config:ro" -v "$PWD/profiles:/profiles:ro" \
  -v "$PWD/secrets:/secrets:ro" -v "$PWD/data:/data" \
  objectid/digital-twin-integration-server:local
```

`docker compose -f docker-compose.example.yml up --build` adds a hardened,
unprivileged example deployment.

`docker compose -f docker-compose.minio.example.yml up --build` runs the server,
MinIO and one-time bucket initialization; credentials come from `.env`.

## Connectors

REST supports outbound HTTP with timeout and circuit breaker. MQTT supports
TLS/authentication, QoS, publish, wildcard subscriptions and configured
topic-to-Twin mappings. MQTT `state` mappings enqueue `publishState`; `dataset`
mappings aggregate time windows, persist exact JSON bytes, hash them and enqueue
`addDataset`. Connector construction is configuration-driven. OPC-UA, Modbus
and WebSocket are plugin-ready but **not implemented**.

## ObjectID Integration

`ProviderObjectIdAdapter` hides provider details, uses ObjectID owner/type
queries for reads and delegates mutations to Digital Twin SDK methods. It does
not create an alternative Credit model; ObjectID/Move remains authoritative.

## Digital Thread

`GET /api/v1/twins/:id/thread` returns `OIDTwinEvent[]`.
`GET /api/v1/twins/:id/thread/verify` checks Twin consistency, known types,
actor, revision transitions, continuity, ordering and required payload refs.

## Identifier Resolver

Resolver APIs read `OIDTwinIdentifier` and `OIDTwinIdentifierMapping` from
ObjectID. Global routes delegate lookup to an ObjectID indexer-capable adapter;
providers without that capability return `OBJECTID_IDENTIFIER_INDEXER_REQUIRED`.
The optional `?twinId=` bounded behavior remains backward compatible.

## ISO Profiles

Filesystem profiles use logical URIs such as
`objectid-profile://iso23247/ome/v1`. The included OME schema is deliberately
minimal and extensible; it does not invent normative requirements.

## Maturity Engine

Weighted indicators, thresholds, evidence requirements and levels come from
`profiles/maturity/*.json`. `commit=true` delegates assessment registration to
ObjectID.

## Policy Engine

Every Twin-specific mutation route resolves the caller DID, reads disposable-
cached `OIDTwinRoleGrant` objects and invokes the local policy engine before the
ObjectID mutation. It never replaces final Move authorization.

## Queue And Retry

MQTT ingestion uses a typed in-memory queue and lifecycle-managed worker.
Retries use bounded exponential backoff and jitter only for classified temporary
errors. Ambiguous transaction outcomes are retried only when the adapter can
prove the external idempotency reference was not committed; otherwise the job
is retained in the ephemeral `failedJobs` collection.

## Idempotency

`memory` is the default. Set `idempotency.provider: redis` and `redisUrl` (or
`DTIS_REDIS_URL`) for atomic cross-instance request-key acquisition. Redis is
optional shared ephemeral state and the server remains functional without it.

## Security

Helmet headers, API key/JWT/disabled auth providers, body limits, rate limits,
secret-redacted structured logs, non-root container and typed errors are
enabled. Terminate TLS in an ingress/reverse proxy or inject an HTTPS listener.

## API

The API is versioned under `/api/v1`. Mutations accept `Idempotency-Key`.
Errors use `{ error: { code, message, category, details } }`.

## Development

```bash
npm run dev
npm run lint
npm run typecheck
```

## Testing

```bash
npm run test:unit
npm run test:integration
npm run check
```

Tests use a fake ObjectID adapter and do not require a funded wallet.

## Deployment

Docker standalone and Compose are supported. Kubernetes can run multiple
replicas behind a Service/Ingress using ConfigMaps for `/config` and `/profiles`
and Secrets for credentials. No sticky sessions are required. For shared
cross-replica idempotency or buffering, add a disposable Redis provider without
making it the source of truth.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md), [STATELESS.md](docs/STATELESS.md),
[ISO_ALIGNMENT.md](docs/ISO_ALIGNMENT.md), [STORAGE.md](docs/STORAGE.md) and
[IMPLEMENTATION_REPORT.md](docs/IMPLEMENTATION_REPORT.md). V1 closure details
are in [V1_COMPLETION_REPORT.md](docs/V1_COMPLETION_REPORT.md).
# ISO Alignment Evidence

The server provides versioned profile validation, a replaceable Twin indexer boundary, globally indexed identifier resolution, paginated Digital Thread verification/audit reports, on-chain role-grant enforcement, and MQTT/OPC-UA ingestion through one queue/aggregation pipeline. See `docs/ISO_CONFORMANCE_MATRIX.md` and run `npm run conformance-report` for repeatable technical evidence. These capabilities are ISO-aligned; they are not an ISO certification claim.
