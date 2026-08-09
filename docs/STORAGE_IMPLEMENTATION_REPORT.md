# Storage Implementation Report

Status values: **IMPLEMENTED**, **PARTIAL**, **PLANNED**.

| Area | Status | Result |
|---|---|---|
| Storage abstraction | IMPLEMENTED | Generic exact-byte `StorageProvider` with optional read/exists/delete |
| Provider factory | IMPLEMENTED | Providers are built exclusively from validated configuration |
| Filesystem | IMPLEMENTED | Local paths and mounted NAS/NFS/SMB/SAN, URI prefix and writable health check |
| S3-compatible | IMPLEMENTED | Official AWS SDK, endpoint/region/bucket/prefix/path-style and bucket health check |
| MinIO | IMPLEMENTED | S3-compatible provider, config and Compose/bucket-init example |
| AWS S3 | IMPLEMENTED | Default credential chain or credential-provider environment names |
| Multiple providers | IMPLEMENTED | Named providers can coexist in one process |
| Category routing | IMPLEMENTED | Default plus extensible routes for datasets, models, evidence, artifacts and event payloads |
| Azure Blob | PLANNED | Typed placeholder and explicit startup rejection; no provider/SDK |
| IPFS | PLANNED | Typed placeholder and explicit startup rejection; no provider/SDK |

## Hash And URI Strategy

Both implemented providers buffer the incoming content once, compute SHA-256
over those exact bytes, and write those same bytes. Results use
`sha256:<lowercase hex>`, byte size and content type. Filesystem/NAS emits its
configured URI prefix; S3 emits `s3://bucket/key`. Persisted URIs never contain
credentials or permanent signatures.

## Service Integration

The dataset aggregator depends on the generic provider/router rather than local
filesystem storage. Dataset, model, inline maturity evidence and event-payload
flows store content first and pass URI/hash/size metadata to `ObjectIdAdapter`.
External evidence references remain untouched. The legacy
`LocalFilesystemDatasetStorage` API is retained as a compatibility wrapper.

## Credentials And Health

S3 credential names are resolved through `CredentialProvider`; omitting them
uses the AWS SDK default chain. Logger redaction covers access keys, storage
passwords, connection strings and SAS tokens. Readiness checks only configured
providers that are required, default or routed; liveness remains independent.

## Examples And Packaging

Examples cover pure local, mounted NAS, MinIO, AWS S3 and hybrid category
routing. `docker-compose.minio.example.yml` includes MinIO health and idempotent
bucket initialization without production credentials. `.gitignore` and
`.dockerignore` exclude data, secrets, build output and dependencies.

## Tests And Limitations

Unit/integration coverage verifies filesystem bytes/read/hash/size/URI, S3
PutObject bucket/key/prefix/hash, dataset aggregation through filesystem and S3,
category isolation, secret redaction, maturity/model integration and stateless
restart with shared external storage. S3 is tested with an SDK command mock;
live MinIO execution depends on a Docker daemon and valid local credentials.

The server does not mount NAS protocols, back up content, expose permanent
signed URLs, or implement Azure/IPFS. ObjectID remains metadata/provenance and
never receives large off-chain content.

## Verification

Verified in WSL Ubuntu 20.04 on 2026-08-07:

| Check | Result |
|---|---|
| `npm ci` | PASSED, 412 packages installed, 0 vulnerabilities |
| `npm run typecheck` | PASSED |
| `npm run lint` | PASSED with zero warnings |
| `npm test` | PASSED, 19 files and 51 tests |
| `npm run build` | PASSED |
| Storage example loading | PASSED for local, NAS, MinIO, AWS S3 and hybrid YAML |
| Docker/MinIO live test | NOT RUN: Docker daemon unavailable and WSL Compose plugin invalid |
