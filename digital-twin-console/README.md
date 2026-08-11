# ObjectID Digital Twin Console

Read-only operational console for the ObjectID Digital Twin deployed at `dt-demo.objectid.io`.

The Node gateway serves the React application, subscribes to MQTT telemetry, exposes it to the browser through Server-Sent Events, and proxies a fixed set of read operations to the integration server. API keys and MQTT credentials remain Docker secrets and are never returned to the browser.

The console starts in public demo mode. A user can optionally enter an IOTA DID and its seed: the seed signs a one-time personal-message challenge locally in the browser and is immediately discarded. The gateway verifies the signature and confirms on IOTA that the signer address owns the DID `ControllerCap`; the seed is never transmitted. The resulting `HttpOnly`, `Secure`, `SameSite=Strict` session exposes the OIDTwins where the DID is owner, creator, steward or Twin identity.

During the active browser login, the in-memory signer can create a new OIDTwin or delete a selected Twin for which the DID is owner or steward. Transactions are built and signed in the browser; every operation consumes one compatible OID Credit and is confirmed on IOTA before the local list changes. The published Twin package is statically bound to the configured Identity and OID Credit package versions, so caps or credits from other ObjectID package versions are deliberately ignored.

Authenticated discovery does not depend exclusively on the integration server. If that backend is unavailable, the gateway uses IOTA GraphQL for object discovery and IOTA RPC for the OIDTwin root, identifiers and Digital Thread events. The interface clearly switches to `CHAIN ONLY` and hides off-chain telemetry, readiness and verifier reports instead of presenting stale or unrelated data.

The assurance view is a deterministic technical self-assessment. It does not claim formal ISO certification or clause-by-clause conformity.

## Deploy

```bash
docker compose up -d --build digital-twin-console
docker compose ps digital-twin-console
docker compose logs -f digital-twin-console
```

Traefik must provide the external network `traefik_proxy` and the `websecure` entrypoint with the `myresolver` certificate resolver.

The compose configuration supplies `IOTA_RPC_URL`, `IOTA_GRAPHQL_URL` and `DID_AUTH_AUDIENCE`. DID sessions are in memory and intentionally expire after 30 minutes or whenever the console container restarts.
