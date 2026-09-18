# Generic encrypted file storage API (v1)

Independent of Twins, Datasets, IOTA writes and `/api/plants`. Store PDF, images,
JSON, CAD and arbitrary binary files on the Integration Server's StorageRouter.
The API is server-to-server; no generic file-manager UI or browser credential delivery is added.

## Authentication and authorization

Use the **tenant REST API key** in `x-api-key`, from the existing tenant registry/provisioning.
In configured JWT mode use a Bearer token with a registered `tenantId`/`tenant_id` and
`sub` exactly equal to that tenant's owner DID. Existing JWT verification applies.
The server derives scope from the authenticated registry entry, never a body/query tenant ID.
The tenant owner (supervisor) can read all files of that tenant. Per-user delegation,
per-file ACLs and anonymous/public file download are not implemented in v1.
Global administration keys without a tenant, MQTT/device passwords, disabled-auth mode,
and TwinScope plant-specific assertions cannot access this API. Keep tenant keys in trusted
backends, never browser JS, query strings, source control or public configuration files.

## Configure

Put `DTIS_FILE_ENCRYPTION_KEY` in the selected credential provider: canonical base64
encoding of 32 random bytes (generate with `openssl rand -base64 32`). This is a **new,
independent key**, not the REST API key, seed, plant key or MQTT password. Do not print
the credential provider file to logs. Mount it readable by the container's service user.

`storage.routes.files` selects an existing filesystem or S3-compatible provider;
without the route, the default provider is used. Bytes are AES-256-GCM encrypted before
storage. Each file and index gets a fresh 96-bit nonce; AAD binds tenant, file ID and
purpose. Filenames, MIME type, uploader DID, size, creation time, SHA-256 and storage URI
are encrypted in the index. Index files persist in `files/` beside the dynamic tenant
registry (fallback `/data/files`), grouped by SHA-256 tenant scope. Blobs use the existing
provider's `twins/unscoped/files` namespace. IDs and file sizes may still be inferred
from filesystem/object-store metadata. The service decrypts in memory for authorized
retrieval: this is server-managed encryption, **not end-to-end encryption**.

Back up **index volume + provider blobs + encryption key** together. The service fails
closed without its key or on GCM/hash failure. Online key rotation/re-encryption is not
implemented: replacing the key would make existing files unreadable. Separate key and
storage namespace per independently operated server/network. Customer-run IS means
customer custody of all these resources. There is no global file catalog in the Webview.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/v1/files` | 201 immutable ID and metadata; Location header |
| GET | `/api/v1/files?limit=25&after=UUID` | files and nextCursor; max 100/page |
| GET | `/api/v1/files/:id` | metadata including original MIME type and SHA-256 |
| GET | `/api/v1/files/:id/content` | exact original bytes, verified before delivery |

Upload **raw bytes**, not multipart or base64. `X-File-Name` is percent-encoded UTF-8
(240 decoded bytes maximum, no slash, backslash or control characters).
`Content-Type` is a bare MIME type without parameters, default application/octet-stream.
Empty files are supported; maximum **16 MiB per file**. Compressed HTTP request bodies
are not supported. The API reads each bounded file in memory (not streaming/resumable).
Configure reverse-proxy body/time limits accordingly. Rate limiting applies, but no
per-tenant byte quota or malware scanning is provided. Treat downloaded files as untrusted.

```bash
# DTIS_URL and TENANT_API_KEY supplied by the operator's secure environment.
curl --fail-with-body "$DTIS_URL/api/v1/files" \
  -H "x-api-key: $TENANT_API_KEY" \
  -H 'X-File-Name: manual.pdf' -H 'Content-Type: application/pdf' \
  --data-binary @manual.pdf

curl --fail-with-body "$DTIS_URL/api/v1/files?limit=25" \
  -H "x-api-key: $TENANT_API_KEY"

# FILE_ID is the id returned by the successful upload.
curl --fail-with-body "$DTIS_URL/api/v1/files/$FILE_ID/content" \
  -H "x-api-key: $TENANT_API_KEY" --output downloaded-manual.pdf
```

Keep TLS enabled. Shell history should contain variable references, not pasted keys.
Content retrieval returns `application/octet-stream`, attachment Content-Disposition,
`nosniff`, `Cache-Control: no-store`, and `X-File-SHA256`. No inline HTML execution or
presigned public storage URL. Metadata/list requests also disable caching.

Files are immutable. POST retries (including Idempotency-Key) create separate IDs;
there is no replace/delete API in v1. Index publication is atomic after durable write.
A crash before publication can leave an unreferenced encrypted blob; no automatic orphan
cleanup is supplied. Listing is lexicographic by UUID, not a snapshot under concurrent writes.
The existing Twin telemetry retention worker excludes unscoped files: they do **not** expire
after the telemetry retention period. Apply a deliberate backup/lifecycle policy and do not
delete blobs independently of their indexes. Existing plant APIs/data are unchanged.

Errors: 400 invalid metadata/pagination; 401 invalid/missing credentials; 403 valid identity
without tenant-owner access; 404 missing or other-tenant file; 413 oversized request;
415 unsupported content encoding; 503 missing key/storage or integrity failure. Formal schema: IS `/openapi.json` and `/docs`.
