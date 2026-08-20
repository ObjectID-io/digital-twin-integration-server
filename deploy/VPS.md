# VPS deployment

This deployment starts the ObjectID Digital Twin Integration Server, an authenticated Mosquitto broker, and Redis. It uses the subscription-based testnet package configured in `config/config.vps-testnet.yaml` (currently `0xbab702f8fb2478bac6df8b64c5b92ca998366791913659f373bddc05d89c5147`), exposes the API through the existing Traefik network at `https://dtis.objectid.io`, and stores off-chain payloads in the private Backblaze bucket `OID-Digital-Twin`.

Before deployment, update both ObjectID Gas Station allowlists to accept only the new package ID above (and the required IOTA framework/system packages). Do not leave the previously published Digital Twin package enabled for DTIS mutations.

## Create the public DTIS subscription

Use the provisioning script with the `SubscriptionAdminCap` from the current publish and the customer/integration controller IDs. The CLI address executing this administrative call must control the administrative capability. Plans are `base`, `advanced`, `pro` and `enterprise`; the example creates the hosted public Pro tenant:

```bash
export PACKAGE_ID=0xbab702f8fb2478bac6df8b64c5b92ca998366791913659f373bddc05d89c5147
export SUBSCRIPTION_ADMIN_CAP_ID=0xreplace-with-current-admin-cap
export CUSTOMER_ID=objectid-dtis-public
export CUSTOMER_CONTROLLER_ID=0xreplace-with-public-customer-controller-id
export INTEGRATION_CONTROLLER_ID=0xreplace-with-dtis-controller-id
export PLAN=pro

./scripts/provision-dtis-tenant.sh
```

Save the printed `SubscriptionAccount` ID and registry entry. Add the entry to `DTIS_TENANTS_JSON`; do not reuse capability or account IDs from an earlier package publish. Upgrade the IOTA CLI before administrative calls when the client/server protocol versions differ.

## Required values

1. Copy `.env.vps.example` to `.env` and set the service DID.
2. Set `B2_KEY_ID` in `secrets/credentials.json` to the Backblaze Application Key ID. The bucket ID is not an S3 credential.
3. `MQTT_TWIN_ID` is a legacy service-account mapping only. The core service and simulator can start without a real Twin; use `unknown`/the supplied placeholder until dedicated tenant credentials are installed.
4. Keep the legacy `MQTT_PASSWORD` in `secrets/credentials.json` identical to `secrets/mqtt_password.txt` only while the legacy connector mappings remain enabled.
5. Set `DTIS_IOTA_SEED` to the 64-character hexadecimal seed, without `0x`, and set `DTIS_SIGNER_ADDRESS` to its derived IOTA address.
6. Set `DTIS_TWIN_CONTROLLER_CAP_ID` to the ControllerCap controlled by that signer and `DTIS_SUBSCRIPTION_ACCOUNT_ID` to the new shared account. No OID Credit token or policy is used.
7. Set `DTIS_GAS_STATION_1_TOKEN` and `DTIS_GAS_STATION_2_TOKEN` to the ObjectID Gas Station Bearer tokens. All normal Twin mutations are sponsored and fail closed if both stations are unavailable.
8. For the simulator, prefer the JSON downloaded from Webview Integration credentials. Do not set `SIM_ASSET_ID`/`MQTT_TWIN_ID` as the primary tenant configuration; the uploaded file supplies the Twin, username, password and exact ACL topics.

The supplied Backblaze application key is kept only in the ignored local credentials file. Rotate it if this workspace or conversation has been shared.
The IOTA seed is equivalent to a private signing key. Never commit `secrets/credentials.json`; startup fails if the seed derives an address different from `DTIS_SIGNER_ADDRESS`.

No Twin has to exist before the API stack starts. The simulator is isolated behind the Compose `simulator` profile and is not launched by the normal command below. Twins can then be created through the Webview or the sponsored endpoint. To use the API directly:

```bash
docker compose up -d --build digital-twin-integration-server

API_KEY=$(jq -r .DTIS_PUBLIC_TENANT_API_KEY secrets/credentials.json)
curl --fail -X POST http://127.0.0.1:8080/api/v1/twins \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -H "Idempotency-Key: create-machine-v1" \
  --data '{"twinType":"machine","targetKind":"asset","name":"Example machine","description":"Tenant Digital Twin","namespace":"customer"}'
```

## Start and verify

```bash
cp .env.vps.example .env
chmod 700 secrets
chmod 600 .env
chmod 644 secrets/credentials.json secrets/mqtt_password.txt
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8080/ready
curl --fail -H "x-api-key: $(jq -r .DTIS_PUBLIC_TENANT_API_KEY secrets/credentials.json)" \
  https://dtis.objectid.io/api/v1/subscription
```

Docker Compose implements local file-backed secrets as bind mounts and does not remap their host permissions. Keep the `secrets` directory at mode `0700` and its mounted files at `0644`; the private parent directory protects them on the VPS while allowing the non-root container processes to read the mounts. The simulator runs without Linux capabilities on a read-only filesystem.

Inspect hosted credential/connector status without exposing secrets:

```bash
curl --fail http://127.0.0.1:8080/ready | jq
docker compose logs --tail=100 digital-twin-integration-server
```

Both published ports bind to loopback by default; Traefik reaches the API over the external `traefik_proxy` Docker network. Expose MQTT publicly only after adding TLS or restricting port 1883 to a VPN/private network.

## Digital Twin simulator

The optional `mqtt-digital-twin-simulator` publishes industrial telemetry every five seconds to the tenant dataset topic. The integration server aggregates these samples into five-minute windows before storing and registering each dataset, limiting monthly subscription-credit consumption. Start it safely before onboarding; it remains paused with `twinId=unknown` until valid credentials are installed:

```bash
docker compose --profile simulator up -d --build mqtt-digital-twin-simulator
docker compose logs -f mqtt-digital-twin-simulator digital-twin-integration-server
```

Set `SIM_INTERVAL_MS` or `SIM_MACHINE_NAME` in `.env` to customize it. Keep periodic samples on the generated dataset topic; routing every sample to the generated state topic creates an on-chain operation and consumes monthly subscription credits for each processed state.

Create a Twin in the Webview, generate/rotate Integration credentials, download the JSON, then open `https://dt-simulator.objectid.io`. Uploading the file is protected by the password in `secrets/sim_control_password.txt`; the validated MQTT/ObjectID subset is stored with mode `0600` in the private `simulator-data` volume and applied through an automatic restart. Every scenario transition also publishes one state message; the integration server records the resulting `OIDTwinState` and event 30 in the on-chain Digital Thread, consuming the package-defined operation credit.

Successful on-chain publication is logged as `iota_sponsored_transaction_executed` with the operation and transaction digest. A transition emitted before the signer was enabled is not replayed automatically; select a different scenario after deployment to generate a new state event.
The testnet signer uses a `100000000` gas budget so state publication can cover temporary storage charges before rebates are applied.

## Digital Twin Webview

The user-facing application lives in the separate repository `git@github.com:sdellava/digital-twin-webview.git`. Deploy that Compose project independently. Its BFF reads IOTA directly for anonymous maps/QR pages and uses the encrypted hosted tenant credential or a configured private Integration Server only for authenticated operations and realtime.

For two Compose projects on the same VPS, either expose this API behind an authenticated HTTPS hostname or attach both services to a dedicated external Docker network and enable `ALLOW_PRIVATE_INTEGRATION_SERVERS=true` only in the trusted webview deployment. Keep the default `false` on public hosted webviews. If the webview cannot route to the server because it is inside a private network, realtime data remains hidden by design.

The realtime endpoints are `/api/v1/capabilities`, `/api/v1/twins/:id/realtime/status`, `/latest` and `/stream`. The existing `DTIS_AUTH_MODE=api-key` protects all of them. Encrypted MQTT payloads pass through unchanged; only the webview BFF has the per-user decryption password.

## Multi-tenant rollout

The hosted DTIS resolves the API key to a tenant registry entry and never accepts a caller-selected
subscription ID. After publishing the Move package, provision the public/demo account and every
customer account with `scripts/provision-dtis-tenant.sh`, then add the returned entries to
`DTIS_TENANTS_JSON` in `secrets/credentials.json`. Set the new package ID in `.env` as
`DTIS_OBJECTID_PACKAGE_ID`. Create Twins through the authenticated tenant, rotate/download dedicated
Integration credentials, and configure simulators/devices from the generated Twin/topic assignments. See `docs/MULTI_TENANT_ACCOUNTING.md` for the complete format and
security model.

## Backblaze check

After setting the Application Key ID, use `/ready` and inspect the server logs. An invalid key pair or a key without read/write access to `OID-Digital-Twin` will make the required storage provider unhealthy.
