# Plant ownership and creation authority

## Implemented creation paths

| Entry point | Authorization | Subscription charged | Twin owner |
| --- | --- | --- | --- |
| DT / DT Demo, `POST /api/v1/twins` | Authenticated subscription owner; the Webview also matches its DID session against `ownerControllerId` | Authenticated owner's active subscription, with capacity and credits | Subscription owner DID |
| TwinScope, `POST /api/plants/twins` | Trusted backend checks live AAA, then issues an operation-bound assertion; DTIS verifies signature, audience, lifetime, request ID, payload hash and scope | Plant owner's registered active subscription | Plant owner DID, not necessarily requester |

The signer must use `create_twin_for_subscription_owner` (`objectid.signer.delegatedAccounts=true`). The signing seed stays on DTIS. A tenant API key is not a signing seed, a plant encryption key, or proof of another user's DID login.

DTIS resolves industrial ownership from `DTIS_PLANT_SUPERVISORS[tenantId]` and checks an explicit document owner against it. Plant saves set `document.ownerDid` and `document.tenantId` on the server; submitting another owner is rejected. The requester is recorded as `application_creator_did` separately from `owner_did`, `plant_id`, `tenant_id` and `creation_source`. These immutable metadata fields are on-chain and are not confidential storage.

The TwinScope assertion uses the existing 32-byte base64 `DTIS_PLANT_ACCESS_KEY`, audience `dtis-twin-create`, issuer `twinscope`, a maximum 60-second lifetime, and a required idempotency key as JTI. It is not a plant-read token. TwinScope is a trusted policy enforcement backend: DTIS verifies its signed scope assertion, not an independently replicated AAA database. Revocation prevents issuance of new assertions; an already issued assertion has at most 60 seconds of validity.

## Personal plants

When a personal creation omits `plantId`, DTIS creates/reuses `personal-<SHA256(ownerDid)[0:32]>` in an owner-specific storage scope. The plant is private with organizational `tenantId: null`. Null does not identify a shared security tenant. The actual billing tenant remains the authenticated accounting context. Explicit plant IDs are accepted only from that owner's personal scope. The encrypted record is stored through PlantService/StorageRouter, never in the Webview's filesystem.

## Rollout prerequisites

1. Back up the tenant registry, plant catalogs, connection catalog and their referenced encrypted blobs.
2. Configure persistent PlantService storage and `DTIS_PLANT_ENCRYPTION_KEY` also on IS installations previously used only by DT. Do not rotate existing encryption keys during rollout.
3. Enable the subscription-owner signer and verify owner subscription registration and integration delegation on each network.
4. For each TwinScope installation, configure the existing trusted backend key and tenant-owner pin. A custom creation IS must contain the corresponding plant; no cross-server implicit copying or owner fallback occurs.
5. Upgrade DTIS before its TwinScope and DT clients. Test with synthetic adapters first, then perform an explicitly authorized testnet transaction.

## Legacy membership migration

`deploy/migrate-twin-plants.mjs` runs inside the deployed IS runtime (stdin module). Without `--apply` it only validates and reports. With `--apply` it preserves existing industrial bindings and publication, stamps the pinned plant owner, and assigns unbound personal Twins to the owner's private personal plant. It stops on unknown owners, subscription mismatches or ambiguous industrial bindings. Reruns are idempotent. No IOTA transaction, owner transfer or immutable/mutable metadata rewrite is performed. Catalogs and credentials must be backed up before applying it; encrypted previous blobs are retained.

Authenticated owners can retrieve membership through `GET /api/v1/twins/{id}/plant`; DT proxies it through `GET /api/my/twins/{id}/plant`. The API verifies the current on-chain owner and subscription, returns a membership summary only, and is not a public plant-document endpoint. Legacy associations live in the encrypted IS store; newly created Twins can also resolve their immutable plant reference.

## Remaining boundaries

- Existing on-chain Twins, owners, visibility and metadata are not rewritten. The off-chain migration above must be run separately on every IS/network, after reviewing its dry-run report.
- Private plant reads and decryption remain supervisor-only. This change permits scoped delegated **creation**, not general delegated document reads or UI access to private plants.
- Existing encryption remains unchanged: plant documents/inline attachments use the IS plant storage key; generic files use the IS file key. Per-plant password-driven telemetry encryption, key rotation, generic-file plant binding and delegated decryption are not implemented by this creation change.
- The UI still commits the node-to-Twin binding after successful creation. Keep the returned Twin ID on a binding-save failure. Do not blindly recreate after an ambiguous transaction timeout; reconcile IOTA first.
- Device provisioning and legacy live-data routing are unchanged; no global administration key is exposed to delegated users.

Tests: `tests/unit/plant-twin-creation.test.ts`, `tests/integration/plant-twin-creation.test.ts`, existing encrypted-plant, signer and security suites. DT and DT Demo use the same Webview source with network-specific configuration.
