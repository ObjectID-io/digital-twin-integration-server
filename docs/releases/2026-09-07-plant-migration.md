# Plant ownership release — 7 September 2026

Deployed on VPS to IS testnet/mainnet, DT Demo, DT mainnet and TwinScope Demo. All five runtime containers passed health checks. Both IS readiness checks report ObjectID, profiles, required connectors and storage ready.

## Migration outcome

- Testnet: 4 Twins checked. The two existing Salumificio Piemonte bindings (`dept-production`, `mixer-01`) and all existing plant content, documents and publication were preserved. The pinned supervisor DID and tenant were added explicitly to the encrypted plant document.
- Testnet: `test2` and `Sim-OID-Twin` assigned to private `personal-562dacf09171874ac2923d4bfb3ffc39`, with organizational tenant null.
- Mainnet: `OID-demo-Twin` assigned to private `personal-7d7ca42c699cb755145f0c3415763db6`, with organizational tenant null.
- Each Twin's on-chain owner, subscription, immutable metadata and mutable metadata compared unchanged before/after. No transaction was submitted and no subscription or device credential was rotated.
- A second apply run returned `preserve` for all five Twins. Authenticated membership HTTP requests returned 200 for their owner and unauthenticated requests returned 401.
- The three active testnet Twins returned current telemetry. `test2` and the mainnet Twin had no live sample available (404); the migration does not generate telemetry. The legacy unselected `/api/demo/realtime/latest` route is not a valid per-Twin smoke check in these installations (`TWIN_ID` is blank).

## Backups and rollback material

Remote root-only directory: `/root/backups/plant-release-20260907`.

- `sources.tgz`: five source/configuration roots before release, including credential files.
- `volumes.tgz`: application data and broker configuration volumes before release.
- `mainnet-credentials-with-plant-key.json`: additional protected backup after generating the previously absent mainnet plant storage key. Preserve this key to decrypt the new records; existing keys were not changed.
- `migration-testnet.json`, `migration-mainnet.json`: applied-and-verified reports.
- `migration-*-rerun.json`: idempotence verification.
- `release-sha256.txt` and `build-*.log`: source artifact hashes and build logs.
- Images tagged `pre-plant-20260907-testnet` / `pre-plant-20260907-mainnet` for IS and DT, and `objectid/twinscope-demo:pre-plant-20260907`.

Rollback must preserve the new mainnet encryption key and any post-release user changes. Do not blindly restore a whole live data volume. Previous encrypted plant blobs are retained; revert an individual catalog pointer only after reviewing current revisions. No on-chain rollback is needed.

## Verification and boundaries

Local suites: IS 199 existing tests plus 5 migration tests; DT 95 tests; TwinScope 56 tests. Typecheck, lint and builds passed. Remote builds passed independently. Only release-specific files were staged; unrelated local testnet purchase-button changes were excluded from the deployed DT App.

No live Twin creation was used as a smoke test: creation authorization and signing selection were covered with synthetic adapters. Private plant decryption remains supervisor-only. This release does not add per-plant-password telemetry encryption, generic-file plant binding, delegated decryption or automatic ownership transfers; see `../plant-ownership.md`.
