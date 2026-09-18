# On-chain Twin access — release 2026-09-16

The webview and Integration Server enforce the upgraded Move policy. Testnet and mainnet share the same application images; original type packages remain separate from execution/new-access-type packages. Retention remains configurable (currently 30 days testnet, 5 days mainnet); subscription and Stripe settings are preserved.

## Owner activation

Sign in as the current owner, open the Twin and its access settings. Select Private, Restricted or Public. For each authorized DID, set realtime (1), history (2), export (4), location (8) and evidence (16); export requires history. Select all measurements or exact measurement keys, optional access validity and historical bounds. All dates are UTC milliseconds. Grant and history upper bounds are exclusive; dataset query endpoints are inclusive.

Click SIGN AND SAVE PERMISSIONS. Legacy ObjectID owners use their ControllerCap. Native IOTA Identity owners create a fixed request, then approve and apply it through the actual Identity. The UI signs both steps in the browser. If multiple controllers are required, the request/proposal IDs can be shared with the other owner controllers; they must load and review the fixed request before signing. The server does not receive a seed. Signed transactions bind the current session, address and Twin and are single-use.

Existing version-1 Twins remain unchanged until this owner action. The previous off-chain list is imported as an unsigned draft. Once activated, version 2 never falls back to off-chain ACLs or visibility metadata. The Energy Twin 0xe4d68dabc889a5c9e14e7853dd80b0ce85846d692ca6021bb1690ee9b8f2a083 was confirmed still version 1 after release. No owner policy was activated by the deployment.

## Recipient behavior

After activation and normal DID login, an active reader grant includes the Twin in My Twins and the map index. A Twin without location permission is listed as unlocated. Opening it creates a signed, Twin-scoped Integration Server session in the browser and uses the normal read-only console. Configuration and commands remain unavailable. Current scope, validity and revision are checked on reads, SSE samples/heartbeats and export download. Map discovery is read from the chain, including for an already logged-in session.

Measurement filtering happens before payloads leave the Integration Server. Arbitrary metadata, raw blobs, transport addresses and ungranted structured location are omitted. Already configured Device Workbench source keys can decrypt encrypted samples internally, before filtering; the keys never leave the server. Other encrypted sources require source-side decryption/filtering configuration and are rejected instead of forwarding an opaque whole payload. Previously downloaded copies cannot be recalled. On-chain objects are publicly inspectable by nature; the policy governs application discovery and off-chain data delivery.

## Historical API

Use the existing challenge/verify endpoints under `/api/v1/shared/twins/{id}` to obtain a session and send it as `Authorization: Bearer ...`.

- `POST /history/query` with `{fromTimestamp,toTimestamp}`: filtered historical samples, requires history scope 2; no archive.
- `POST /datasets` with the same selection: asynchronous ZIP preparation, requires export scope 4.
- `GET /datasets/{requestId}`: status; `GET /datasets/{requestId}/download`: ZIP, bound to the original DID session and policy revision.
- `GET /realtime/latest`, `GET /realtime/stream`: realtime scope 1 and per-measure selection.
- `GET /location/latest`: separate location scope 8.

Storage routing continues to use the configured private providers. Queries cover retained, flushed windows only, with bounded time ranges and sizes; they do not reconstruct expired samples. Export hashes verify file integrity and do not by themselves constitute an on-chain provenance attestation. The historical webview UI remains a separate next step, as requested.

## Configuration

Webview: `IOTA_PACKAGE_ID` stays the original type origin; `IOTA_EXECUTION_PACKAGE_ID` and `IOTA_ACCESS_PACKAGE_ID` select the upgrade/new access types. Integration Server: corresponding `DTIS_OBJECTID_PACKAGE_ID`, `DTIS_OBJECTID_EXECUTION_PACKAGE_ID`, `DTIS_OBJECTID_ACCESS_PACKAGE_ID`.

The policy evaluator lives in DTIS `src/sharing/policy.ts` and is transpiled without logic changes into webview `server/access-policy.js`. The verified DID-controller evaluator is shared the same way. Keep these copies synchronized. The empty Move `DataAccessKey` is represented in RPC as `{dummy_field:false}`, as verified against the published ABI.

## Verification and release evidence

- Integration Server: lint, typecheck, 292 tests and production build passed.
- Webview: 130 tests and production build passed; 16 focused transaction/access tests passed after the final backend-only adjustment (including one new signature/session/Twin/replay test).
- Local browser: dropdown selection, independent DID grants, Download→History dependency, measurement selection, and mock save succeeded. This was a disposable local fixture, not a live owner signature.
- Native request construction passed a live testnet dev-inspect simulation; no transaction was submitted.
- Both live webviews serve the identical JS asset; all four containers are healthy; documented protected endpoints return 401 anonymously; public maps and DTIS readiness return 200.
- Live controller checks accept the actual owner and recipient controllers and deny an unrelated signer. End-to-end activation of the real owner's policy still requires the owner's signature in the UI.

Images: webview `sha256:105d0fcfc0f0422ac5795730eff9ff6b635bb8d20599edae9e8e58f776cfab4e`; DTIS `sha256:4a4fc481ca6906a9bd132329f0b9260e9749351ed67a552663ae9826cb2eb63e`. Tag: `onchain-access-20260916`.

Remote code/compose backups: `/root/objectid-onchain-integration-20260916`. Previous images are retained. Rolling back to v1-only code after an owner activates a v2 policy would be incompatible and must not be done. No Git commit/push was performed. MQTT brokers and simulators were not restarted.
