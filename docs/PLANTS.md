# Encrypted plant API

These routes are mounted at `/api/plants`, independently of `/api/v1` authentication. Private plant routes always require a plant access JWT, including when ordinary DTIS authentication is disabled. No deployment or TwinScope changes are part of this backend.

## Credentials

Configure these through the existing DTIS `CredentialProvider` (environment or the configured credentials JSON file):

- `DTIS_PLANT_ENCRYPTION_KEY`: canonical base64 encoding of exactly 32 random bytes, dedicated to AES-256-GCM plant encryption. Keep it backed up; replacing it makes existing documents unreadable. Key rotation/migration is not automatic.
- `DTIS_PLANT_ACCESS_KEY`: canonical base64 encoding of exactly 32 random bytes, shared only with the trusted TwinScope backend. Sign/verify HS256 using `Buffer.from(value, "base64")`, **not the base64 text as the signing key**.
- `DTIS_PLANT_SUPERVISORS`: JSON object mapping exact, case-sensitive tenant IDs to their pinned supervisor DIDs: `{"tenantId":"did:method:identifier"}`. The file credential provider supports either a JSON object value or a JSON-encoded string. An empty mapping denies all private access.

The JWT must contain `iss: "twinscope"`, `aud: "dtis-plants"`, `sub: <pinned DID>`, `tenantId: <tenant ID>`, `role: "tenant_supervisor"`, integer `iat`/`exp`, and a nonempty string `jti`. The proxy's 60-second lifetime is supported; maximum lifetime and age are 300 seconds, with no clock tolerance or future `iat`. Only HS256 is accepted. The tenant comes exclusively from the verified token; neither a role alone nor generic DTIS credentials grant access. `jti` identifies the token; tokens may be reused within their lifetime, and optimistic revisions guard repeated writes.

## Route contract

All responses use `Cache-Control: no-store`. The scoped Express JSON parser accepts up to 32 MiB before the default parser, allowing embedded base64 images. GET has no application response-size cap. Plant IDs are tenant-local, 1–128 ASCII letters/digits/dots/underscores/hyphens, starting with a letter or digit.

`GET /api/plants/public` is anonymous and returns:

```json
{"plants":[{"id":"plant-1","name":"Public plant name","coordinates":[9,45],"visibility":"public"}]}
```

Only explicitly published entries appear. The public route reads catalog projections only: it never requests the encryption credential, fetches ciphertext, or decrypts documents. No tree, media, areas, bindings, revision, tenant identity, or arbitrary document fields appear in the projection. Coordinates are exactly two finite numbers `[longitude,latitude]`, longitude in [-180,180] and latitude in [-90,90], matching MapLibre. Names must be nonempty and at most 256 characters. Public IDs are tenant-local; deployments publishing multiple tenants should use globally unique IDs if a consumer requires global identity.

`GET /api/plants` requires `Authorization: Bearer <JWT>` and returns only the verified tenant's records:

```json
{"plants":[{"id":"plant-1","revision":1,"document":{"tree":[],"media":[],"areas":[],"twinBindings":{},"legacyMigration":{"arbitrary":"preserved"}},"publication":{"name":"Public plant name","coordinates":[9,45]}}]}
```

`PUT /api/plants/:id` requires the same bearer token and exactly this body:

```json
{"revision":0,"document":{"tree":[],"media":[],"areas":[],"twinBindings":{},"legacyMigration":{"arbitrary":"preserved"}},"publication":{"name":"Public plant name","coordinates":[9,45]}}
```

The entire arbitrary JSON object in `document` is preserved and encrypted, including nested fields, embedded media, and `legacyMigration`. Publication is supplied separately and is never inferred from the document. Set `publication: null` to keep private or unpublish. Unknown top-level request fields and publication/coordinate fields are rejected. `revision: 0` creates; updates submit the last stored revision. The server increments it and returns HTTP 200:

```json
{"id":"plant-1","revision":1,"document":{"tree":[],"media":[],"areas":[],"twinBindings":{},"legacyMigration":{"arbitrary":"preserved"}},"publication":{"name":"Public plant name","coordinates":[9,45]}}
```

A mismatched revision returns HTTP 409 `PLANT_REVISION_CONFLICT`, with the current tenant-local revision in `error.details.revision`. A concurrently held catalog lock returns HTTP 409 `PLANT_WRITE_BUSY`; retry and reload on revision conflict. Invalid input returns 400, missing/invalid tokens 401, unpinned/wrong-role claims 403, oversized bodies 413, and missing/malformed credentials or integrity failures 503. Errors follow the standard DTIS `{error:{code,message,category,details}}` envelope. A failed read never returns a partial decrypted list.

For migration, compare `JSON.stringify(record.document)` after authenticated GET with `JSON.stringify(originalDocument)` before removing legacy media. The backend performs no legacy-file deletion.

## Storage and durability

The catalog is `<dirname(security.tenantProvisioning.dynamicTenantFile)>/plants/catalog.json`, even if provisioning is disabled. Without that path, it is `/data/plants/catalog.json`. It lives in DTIS data storage, not TwinScope. Catalog records contain only opaque tenant and plant-ID hashes, revision, ciphertext URI, and the explicit public projection (or null). Private plant IDs and all private names/metadata stay encrypted; published IDs are included only in the public projection.

`StorageRouter` uses `storage.routes.plants` when configured, otherwise the default provider. Filesystem and S3 blobs use `twins/unscoped/plants` with opaque random filenames, no twin ID, and no identifying metadata. The binary envelope is a version byte (1), 12-byte random nonce, 16-byte authentication tag, and AES-256-GCM ciphertext of `{id,document}`, containing the complete original document. Authenticated additional data binds the version, tenant hash, plant-ID hash, revision, and publication to the ciphertext; ciphertext changes or pointer swaps fail authenticated reads.

An exclusive `catalog.lock` file serializes writers sharing the directory. Each write stores the encrypted blob first, then writes a unique catalog temporary file, fsyncs it, and atomically renames it. On POSIX the catalog directory is fsynced after rename. Windows supports file fsync and atomic rename but not the POSIX directory-fsync guarantee. The deployment filesystem must support exclusive creation and atomic same-directory replacement. Independent DTIS replicas must share the catalog directory as well as access to the configured blobs.

A crash can leave an orphan ciphertext blob or lock. After confirming **all writers are stopped**, an operator may remove the exact stale `catalog.lock` file; locks are never stolen automatically. Retrying after an uncertain response may return a revision conflict; reload the record. The catalog and encryption credential require backup. Local catalog files are trusted DTIS state and must not be writable by untrusted users.

Automatic retention never deletes plant blobs: both providers exclude `unscoped`, and retention explicitly excludes the `plants` category and `unscoped` twin ID. Superseded/orphan plant blobs remain indefinitely; no garbage collection is introduced here.

## Minimal mounting changes for an existing DTIS app

Copy the three new `src/plants/*.ts` modules. Apply only these additions to the existing `src/api/app.ts`; do not replace the remote file with the local working copy.

Add imports:

```ts
import { PlantService, plantCatalogDirectory } from "../plants/service.js";
import { plantRoutes } from "../plants/routes.js";
```

Before the existing default `app.use(express.json(...))` parser:

```ts
app.use("/api/plants", express.json({ limit: "32mb" }));
```

Immediately after the existing `const storage = new StorageProviderFactory(credentials).createRouter(config.storage);` line (with the existing credentials in scope):

```ts
app.use("/api/plants", plantRoutes(new PlantService(storage, credentials, plantCatalogDirectory(config)), credentials));
```

This mount must precede the catch-all 404 and error handler and must remain independent of the `/api/v1` authentication middleware. The existing DTIS app uses Express 5, which forwards rejected async handlers to the error handler.

In `src/storage/retention.ts`, add this first inside the managed-object loop, before owner resolution:

```ts
if (object.category === "plants" || object.twinId === "unscoped") continue;
```

No dependency or configuration-schema changes are required. The three credentials described above are resolved through the existing provider.
