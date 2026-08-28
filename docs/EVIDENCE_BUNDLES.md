# On-demand Dataset evidence bundles

Dataset-mode MQTT ingestion writes rolling telemetry windows to the configured
off-chain storage. It does **not** register every window on IOTA and therefore
does not create a continuous stream of Dataset events.

When an authorized user requests an export, DTIS performs one explicit
mutation:

```http
POST /api/v1/twins/<twinId>/evidence-bundles
Idempotency-Key: <unique request id>
Content-Type: application/json

{ "fromTimestamp": 1787000000000, "toTimestamp": 1787086400000 }
```

DTIS reads the retained telemetry windows overlapping the requested interval,
builds one `objectid.digital-twin-export-dataset.v1` JSON payload, stores its
exact bytes under the `evidence` category and calls `add_dataset`. That
transaction creates one `OIDTwinDataset` and one type-70 `OIDTwinEvent` whose
hash is the SHA-256 of the exported JSON bytes.

The response contains the new `datasetId`, transaction digest, covered period,
source-window count, byte length and hash. Download the corresponding archive:

```http
GET /api/v1/twins/<twinId>/evidence-bundles/<datasetId>
```

The ZIP contains exactly one Dataset JSON file, `manifest.json` and a README.
The archive is limited to 256 MiB of uncompressed Dataset data.

## Privacy-preserving validation

The Webview extracts the selected ZIP and hashes the Dataset file locally. It
sends only the manifest and `{ path, sha256, byteLength }` to:

```http
POST /api/v1/twins/<twinId>/evidence-bundles/validate
```

DTIS reloads the manifest's specific `OIDTwinDataset` and its matching type-70
Digital Thread event from ObjectID/IOTA. Validation succeeds only when the
network, package, Twin and Dataset identifiers match and the file, manifest,
Dataset object and event all contain the same SHA-256 and byte-length evidence.

Retention of source telemetry controls what can be included in a future
snapshot. Once a snapshot is created, its exported payload is stored separately
under the `evidence` category and follows the configured evidence retention
policy. The on-chain hash cannot reconstruct bytes deleted from storage.

Successful validation proves byte-level agreement with the immutable anchor;
it does not prove sensor accuracy, calibration, completeness before ingestion
or post-export chain of custody.
