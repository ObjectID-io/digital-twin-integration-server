# DID-authorized realtime and historical datasets

The owner controls each authorized DID in **Configure Twin → Access settings**.
An unchecked **Stored data access** flag permits realtime reads only. A checked
flag also permits retained telemetry exports. Legacy policies without flags remain
realtime-only. This feature uses the same code on mainnet and testnet.

## Owner policy

The existing authenticated owner endpoint `GET/PUT /api/v1/twins/{twinId}/data-access`
now returns/accepts `storageDids`, an array that must be a subset of `allowedDids`.
Example body (replace DID placeholders with valid DIDs for the selected network):

```json
{
  "mode": "restricted",
  "visibility": "private",
  "liveLocationVisibility": "private",
  "allowedDids": ["<realtime-only DID>", "<realtime-and-storage DID>"],
  "storageDids": ["<realtime-and-storage DID>"],
  "revision": "<revision from GET>"
}
```

Only the current owner may modify this policy. Flags and DID lists are stored
privately on the IS, not published on-chain. An omitted `storageDids` preserves
existing flags only for DIDs retained by the same owner; a new DID never inherits
storage access. Send `storageDids: []` to explicitly disable all third-party
historical access. Changing out of restricted mode clears both lists.

## Reader API

Use the existing signature challenge flow; an API key or a plain DID string is
not a reader session:

1. `POST /api/v1/shared/twins/{twinId}/challenge` with `{ "did": "..." }`.
2. Sign the returned message with the DID controller's IOTA personal-message key.
3. `POST /api/v1/shared/twins/{twinId}/verify` with `did`, `challengeId`, `signature`.
4. Pass the returned token in `Authorization: Bearer <token>` on subsequent calls.

The authenticated `GET .../{twinId}/dashboard` includes
`permissions: { realtime: true, storage: false | true }` for this DID only.

| Method | Path after `/api/v1/shared/twins/{twinId}` | Result |
|---|---|---|
| POST | `/datasets` | 202, request ID, status URL, expiry |
| GET | `/datasets/{requestId}` | preparing, ready or failed; download URL when ready |
| GET | `/datasets/{requestId}/download` | ZIP, `X-Dataset-SHA256` header |
| DELETE | `/datasets/{requestId}` | Cancel/delete temporary request, 204 |

Create body: `{"fromTimestamp":1789500000000,"toTimestamp":1789503600000}`.
Both values are required Unix milliseconds, inclusive, not in the future and
at most 31 days apart. The API rejects unrecognized fields (including arbitrary
storage URLs). URLs include the configured IS prefix, e.g. `/mainnet`.
Poll the status URL approximately every 2 seconds. Failed jobs contain a safe
error code/message; status polling returns 200 even when the job failed.

The URL is not a bearer capability: the original DID session is required in the
header. Tokens in query parameters are not accepted. Requests are bound to the
Twin, DID, session and policy revision. Permission and ownership are checked at
creation, after preparation, on status and at download. A policy update removes
all pending/ready exports for that Twin; regranting does not restore old exports.
A DID with realtime-only access gets 403 before storage is read. Missing/expired
sessions get 401; unavailable jobs get 404; unfinished downloads get 409.

## ZIP contents and integrity

- `data.json`: exact selected samples, observation timestamps, values and source hashes.
- `data.csv`: observation milliseconds, UTC time, source hash, JSON-encoded value.
- `manifest.json`: Twin, owner, network/package, interval, counts, source window
  hashes, file hashes/sizes, source-declared synthetic flags and encryption counts.

Filtering uses each sample's `observedAt`, including boundary samples. It does not
filter on the simulator's simulated date. Only flushed, retained telemetry windows
are included; buffered, deleted or expired samples cannot be recovered. Storage
credentials, private paths and URIs are not returned. Files are read using the
configured StorageRouter (including private filesystem/S3 providers), not a URL
supplied by the requester. No external storage is exposed publicly.

Encrypted values remain encrypted, with their envelope intact. The recipient
needs the key/password through the owner's existing arrangement. Unmarked or
encrypted samples are not classified as real by inference. The hashes verify
the export's byte integrity; this read-only API creates no on-chain dataset or
provenance attestation and consumes no transaction credit for export preparation.

## Initial operational limits

Archives are held only in process memory, expire within 10 minutes or at session
expiry (whichever is earlier), and disappear on restart. No disk archive cleanup
or public object-store bucket is required. Limits: 2 preparations concurrently,
32 requests globally, 4 per DID, 64 MiB resident archives, 16 MiB per archive/source
object, 256 MiB scanned retained bytes and 10,000 retained windows per request.
Selected rows also have an early byte budget to bound JSON/CSV serialization.
The initial implementation enumerates retained windows for the Twin; requests
exceeding the scan budget fail explicitly rather than return partial datasets.
Large deployments will need an indexed/paginated history provider and durable
jobs. These limits are exported in `/api/v1/capabilities`.

No historical-download webview is included in this release; the owner flag is
available now and the reader flow can use these APIs. Downloaded copies cannot
be remotely revoked, although future download requests can be blocked.
