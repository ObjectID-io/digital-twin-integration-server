# Off-Chain Storage

## Generic encrypted files (v1)

The independent `/api/v1/files` API accepts raw files from authenticated tenant owners,
encrypts content and metadata with a dedicated AES-256-GCM key, and retrieves original
bytes by immutable file ID. No Twin or IOTA transaction is required. Files are private,
limited to 16 MiB, and excluded from telemetry retention. See [FILES.md](FILES.md) for
authentication, configuration, endpoint contracts, examples, backup and lifecycle limits.

## Automatic Retention And Pruning

The Integration Server automatically prunes managed objects after five days by default. Only objects inside a configured provider's `twins/{twinId}/{category}` namespace are eligible. External URIs and unscoped objects are never enumerated.

```yaml
retention:
  enabled: true
  defaultDays: 5
  intervalMs: 3600000
  startupDelayMs: 60000
  maxDeletesPerRun: 500
  onChainStates:
    enabled: true
    retentionDays: 30
    maxPrunesPerRun: 50
  ownerPolicies:
    - ownerDid: did:iota:testnet:0xPREMIUM_OWNER
      retentionDays: 30
    - ownerDid: did:iota:testnet:0xARCHIVE_OWNER
      retentionDays: null
```

The current on-chain Twin owner is resolved before deletion. If the Twin or owner cannot be resolved, pruning fails closed and preserves the object. `retentionDays: null` keeps data indefinitely. `ownerPolicies` is the initial policy source and implements the resolver boundary intended for the future Service Level Agreement service.

The oldest eligible objects are deleted first, with a bounded number of deletions per run. Status and the most recent result are available from `GET /api/v1/storage/retention/status`.

Pruning removes the off-chain bytes, not the immutable ObjectID/IOTA record. The URI and hash remain as historical integrity evidence, but payload retrieval will return unavailable after retention expires.

On-chain state pruning is a separate, stricter pass. For each `aspectCode` / `sampleType` stream it always retains the newest `OIDTwinState`. An older state is deleted only after its retention window and only when its publication record and payload hash are coherent. The upgraded Move call atomically emits `EVENT_STATE_PRUNED` with the state ID and SHA-256 hash before deleting the state. Digital Thread events are never deleted, so revision continuity and payload verification remain available after the state object disappears. A non-empty publication hash that disagrees with the state fails closed.

The Move package must include the publication-hash and `prune_state_with_receipt` upgrade before enabling this pass. DTIS deliberately calls only this new entry point: an older package rejects the transaction instead of performing an unverifiable deletion. This also lets legacy states whose original publication event had an empty hash be migrated safely. The scheduler uses the Twin's own subscription and limits each run with `maxPrunesPerRun`. Environment overrides are available as `DTIS_ONCHAIN_STATE_PRUNING_ENABLED`, `DTIS_ONCHAIN_STATE_RETENTION_DAYS`, and `DTIS_ONCHAIN_STATE_MAX_PRUNES`.

## Architecture

The Integration Server stores content through a generic `StorageProvider` and
registers only URI, SHA-256, size and domain metadata through the ObjectID
adapter. ObjectID/IOTA remains responsible for identity, metadata, provenance,
relationships and events; it is not used as object storage.

```text
bytes -> StorageRouter -> filesystem / mounted NAS / S3-compatible
                         -> URI + SHA-256 + size
                         -> ObjectID adapter -> ObjectID / IOTA
```

`store()` accepts a `Buffer` or stream plus content type, file name, free-form
category, Twin ID and metadata. The provider hashes the exact bytes it writes.
Optional `read`, `exists` and `delete` methods are provider capabilities rather
than assumptions made by business services.

## Configuration And Routing

Use `storage.defaultProvider`, named `storage.providers` and optional category
routes. Supported built-in categories are `dataset`, `model`, `evidence`,
`artifact` and `event-payload`; arbitrary category strings remain valid.

```yaml
storage:
  defaultProvider: local
  providers:
    local:
      type: filesystem
      basePath: /data
    telemetry:
      type: s3
      endpoint: http://minio:9000
      region: local
      bucket: telemetry
      forcePathStyle: true
      accessKeyEnv: MINIO_ROOT_USER
      secretKeyEnv: MINIO_ROOT_PASSWORD
  routes:
    dataset: telemetry
    model: local
```

The legacy single-provider form (`storage.provider` plus `filesystem` or `s3`)
is normalized to this model. If `storage` is omitted, the previous local
filesystem behavior and `dataset.directory` remain available.

## Filesystem And NAS

The filesystem provider writes under
`<basePath>/twins/<twinId>/<category>/<hash>-<filename>`. It can create missing
directories and checks accessibility and writability during readiness. A
custom `uriPrefix` can produce `file:///...` or customer resolver URIs such as
`nas://factory-storage/objectid/...`.

NFS, SMB/CIFS, a local NAS and SAN-mounted filesystems use this same provider.
The server does not implement those network protocols: mount the volume on the
host, in Docker, or through a Kubernetes PersistentVolume, then set `basePath`.

```yaml
storage:
  provider: filesystem
  filesystem:
    basePath: /mnt/objectid-nas
    uriPrefix: nas://plant-storage/objectid
```

Docker bind mount example:

```yaml
volumes:
  - /mnt/customer/objectid:/mnt/objectid-nas
```

For NFS or SMB/CIFS, operating-system credentials and mount options stay outside
the server configuration. See `config/examples/storage-local.yaml` and
`storage-nas.yaml`.

## S3-Compatible, MinIO And AWS

`S3StorageProvider` uses the official AWS SDK. It supports AWS S3 and endpoints
implementing the required S3 API, including MinIO, Ceph Object Gateway and
Wasabi-compatible services. `forcePathStyle: true` is normally required for
MinIO. Stored references use `s3://<bucket>/<key>` and contain no credentials or
signed query parameters.

When `accessKeyEnv` and `secretKeyEnv` are omitted, the AWS SDK default
credential chain applies, including IAM roles and workload/container identity.
When specified, both names are resolved through `CredentialProvider`; the YAML
contains environment variable names, never secret values.

Examples are provided in `storage-minio.yaml`, `storage-aws-s3.yaml` and
`storage-hybrid.yaml`. Start the on-premise example with:

```bash
cp .env.example .env
docker compose -f docker-compose.minio.example.yml up --build
```

The Compose stack creates the `objectid-digital-twin` bucket and exposes the
MinIO API on port 9000 and console on port 9001.

## Azure Blob And IPFS

Azure Blob and IPFS are **NOT IMPLEMENTED** in this version. Their configuration
types and factory rejection paths reserve extension points, but selecting either
provider fails startup instead of suggesting false support. No Azure or IPFS SDK
is installed. A future Azure implementation should prefer Managed Identity or
`DefaultAzureCredential`; a future IPFS provider should persist `ipfs://<CID>`.

## Service Integration

MQTT dataset windows, REST datasets, model content, inline maturity evidence and
event payload data all use the abstraction. Already external evidence containing
a URI/hash is referenced without forced copying. Services pass only the stored
reference and metadata to ObjectID, not the full file or dataset.

`/health` reports process liveness. `/ready` checks ObjectID and every provider
used as default, by a route, or marked `required: true`. Unreferenced optional
providers do not block readiness. Missing S3 bucket/region or filesystem
`basePath` fails configuration loading; a non-writable required filesystem or
inaccessible required bucket fails readiness.

## Security And URI Resolution

Storage secrets come from environment/credential providers and sensitive field
names are redacted from structured logs. Never put credentials in URI prefixes.
Permanent signed URLs are not stored on-chain. If clients cannot resolve a
private `nas://` or `s3://` URI directly, expose a separate authenticated
resolver that issues short-lived access without changing the persisted URI.

## Backup, HA And Statelessness

ObjectID certifies URI, hash, provenance and identity; it does not back up the
off-chain bytes. The customer owns the durability policy: backup NAS volumes,
configure MinIO replication/erasure coding, or enable S3 versioning, lifecycle
and replication as appropriate.

External storage does not make the Integration Server stateful. Multiple server
replicas can use the same provider, and a replacement instance can reconstruct
the Twin from ObjectID and access the same storage without migrating local
server state. Content-addressed object names reduce collision risk; automatic
retention remains an Integration Server policy while provider lifecycle rules
must be configured not to delete data earlier than that policy.
