# VPS deployment

This deployment starts the ObjectID Digital Twin Integration Server, an authenticated Mosquitto broker, and Redis. It uses the subscription-based testnet package `0x2b20f39e5e954b232370b019d21c7cc87ff41e7ee0a7802b9a47be14059e1772`, exposes the API through the existing Traefik network at `https://dtis.objectid.io`, and stores off-chain payloads in the private Backblaze bucket `OID-Digital-Twin`.

Before deployment, update both ObjectID Gas Station allowlists to accept only the new package ID above (and the required IOTA framework/system packages). Do not leave the previously published Digital Twin package enabled for DTIS mutations.

## Create the public DTIS subscription

The publish transaction created `SubscriptionAdminCap` `0xc930565e921a411451d42a189ad7b407be7a059b77698fb887d314012b5851f3`. Create one monthly subscription for the ControllerCap used by this server. The CLI address executing this administrative call must control both caps. Plan codes are `1=base`, `2=advanced`, `3=pro`, `4=enterprise`; the command below creates Pro (100 Twins, 200000 monthly operation credits):

```bash
PACKAGE_ID=0x2b20f39e5e954b232370b019d21c7cc87ff41e7ee0a7802b9a47be14059e1772
ADMIN_CAP_ID=0xc930565e921a411451d42a189ad7b407be7a059b77698fb887d314012b5851f3
CONTROLLER_CAP_ID=0xreplace-with-controller-cap
START_MS=$(($(date +%s) * 1000))
END_MS=$(($(date -d '+1 month' +%s) * 1000))

iota client call \
  --package "$PACKAGE_ID" \
  --module oid_twin \
  --function create_subscription \
  --args "$ADMIN_CAP_ID" "$CONTROLLER_CAP_ID" "objectid-dtis-public" 3 "$START_MS" "$END_MS" 0 0 0x6 \
  --gas-budget 100000000
```

Save the shared `SubscriptionAccount` ID shown under created object changes. The publish output also warns that the local CLI/protocol versions do not match the testnet node; upgrade the IOTA CLI before doing administrative calls.

## Required values

1. Copy `.env.vps.example` to `.env` and set the service DID.
2. Set `B2_KEY_ID` in `secrets/credentials.json` to the Backblaze Application Key ID. The bucket ID is not an S3 credential.
3. `MQTT_TWIN_ID` does not have to reference a Twin for the core service to start. Keep the valid 32-byte placeholder `0x0000000000000000000000000000000000000000000000000000000000000000` until an MQTT mapping is enabled.
4. Keep `MQTT_PASSWORD` in `secrets/credentials.json` identical to the contents of `secrets/mqtt_password.txt`.
5. Set `DTIS_IOTA_SEED` to the 64-character hexadecimal seed, without `0x`, and set `DTIS_SIGNER_ADDRESS` to its derived IOTA address.
6. Set `DTIS_TWIN_CONTROLLER_CAP_ID` to the ControllerCap controlled by that signer and `DTIS_SUBSCRIPTION_ACCOUNT_ID` to the new shared account. No OID Credit token or policy is used.
7. Set `DTIS_GAS_STATION_1_TOKEN` and `DTIS_GAS_STATION_2_TOKEN` to the ObjectID Gas Station Bearer tokens. All normal Twin mutations are sponsored and fail closed if both stations are unavailable.
8. Only when enabling the optional simulator, set both `MQTT_TWIN_ID` and `SIM_ASSET_ID` to the Twin that must receive its telemetry. The command catalog resolves the same `MQTT_TWIN_ID` credential.

The supplied Backblaze application key is kept only in the ignored local credentials file. Rotate it if this workspace or conversation has been shared.
The IOTA seed is equivalent to a private signing key. Never commit `secrets/credentials.json`; startup fails if the seed derives an address different from `DTIS_SIGNER_ADDRESS`.

No Twin has to exist before the API stack starts. The simulator is isolated behind the Compose `simulator` profile and is not launched by the normal command below. Twins can then be created through the Webview or the sponsored endpoint. To use the API directly:

```bash
docker compose up -d --build digital-twin-integration-server

API_KEY=$(jq -r .DTIS_API_KEY secrets/credentials.json)
curl --fail -X POST http://127.0.0.1:8080/api/v1/twins \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -H "Idempotency-Key: bootstrap-public-demo-twin-v1" \
  --data '{"twinType":"machine","targetKind":"asset","name":"ObjectID public demo machine","description":"Public DTIS demonstration Twin","namespace":"objectid-demo"}'
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
curl --fail -H "x-api-key: $(jq -r .DTIS_API_KEY secrets/credentials.json)" \
  https://dtis.objectid.io/api/v1/subscription
```

Docker Compose implements local file-backed secrets as bind mounts and does not remap their host permissions. Keep the `secrets` directory at mode `0700` and its mounted files at `0644`; the private parent directory protects them on the VPS while allowing the non-root container processes to read the mounts. The simulator runs without Linux capabilities on a read-only filesystem.

Publish a state sample from the VPS:

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -u objectid -P "$(cat secrets/mqtt_password.txt)" \
  -q 1 -t objectid/twins/telemetry/state -m '{"temperature":42.5,"unit":"Cel"}'
```

Both published ports bind to loopback by default; Traefik reaches the API over the external `traefik_proxy` Docker network. Expose MQTT publicly only after adding TLS or restricting port 1883 to a VPN/private network.

## Digital Twin simulator

The optional `mqtt-digital-twin-simulator` publishes industrial telemetry every five seconds to the dataset topic. The integration server aggregates these samples into five-minute windows before storing and registering each dataset, limiting monthly subscription-credit consumption. Configure `MQTT_TWIN_ID` in `secrets/credentials.json` and `SIM_ASSET_ID` in `.env` with the same real Twin ID, then enable its profile:

```bash
docker compose --profile simulator up -d --build mqtt-digital-twin-simulator
docker compose logs -f mqtt-digital-twin-simulator digital-twin-integration-server
```

Set `SIM_INTERVAL_MS` or `SIM_MACHINE_NAME` in `.env` to customize it. Do not switch `SIM_MQTT_TOPIC` to the state topic unless on-chain publication for every sample and its monthly operation-credit usage are intended.

The unauthenticated demo control console is available at `https://dt-simulator.objectid.io`. It can inject overheat, high-vibration, spindle-overload, pressure-loss and emergency-stop telemetry, or pause and resume publication. Every scenario transition also publishes one state message; the integration server records the resulting `OIDTwinState` and event 30 in the on-chain Digital Thread, consuming the package-defined operation credit.

Successful on-chain publication is logged as `iota_sponsored_transaction_executed` with the operation and transaction digest. A transition emitted before the signer was enabled is not replayed automatically; select a different scenario after deployment to generate a new state event.
The testnet signer uses a `100000000` gas budget so state publication can cover temporary storage charges before rebates are applied.

## Digital Twin Webview

The user-facing application now lives in the separate private repository `git@github.com:sdellava/digital-twin-webview.git`. Deploy that Compose project independently. Its BFF reads IOTA directly for public QR pages and contacts this integration server only for a logged-in DID that has saved a server URL and API token.

For two Compose projects on the same VPS, either expose this API behind an authenticated HTTPS hostname or attach both services to a dedicated external Docker network and enable `ALLOW_PRIVATE_INTEGRATION_SERVERS=true` only in the trusted webview deployment. Keep the default `false` on public hosted webviews. If the webview cannot route to the server because it is inside a private network, realtime data remains hidden by design.

The realtime endpoints are `/api/v1/capabilities`, `/api/v1/twins/:id/realtime/status`, `/latest` and `/stream`. The existing `DTIS_AUTH_MODE=api-key` protects all of them. Encrypted MQTT payloads pass through unchanged; only the webview BFF has the per-user decryption password.

## Multi-tenant rollout

The hosted DTIS resolves the API key to a tenant registry entry and never accepts a caller-selected
subscription ID. After publishing the Move package, provision the public/demo account and every
customer account with `scripts/provision-dtis-tenant.sh`, then add the returned entries to
`DTIS_TENANTS_JSON` in `secrets/credentials.json`. Set the new package ID in `.env` as
`DTIS_OBJECTID_PACKAGE_ID` and use a newly created Twin for `SIM_ASSET_ID`, `MQTT_TWIN_ID`, connector
mappings and command catalogs. See `docs/MULTI_TENANT_ACCOUNTING.md` for the complete format and
security model.

## Backblaze check

After setting the Application Key ID, use `/ready` and inspect the server logs. An invalid key pair or a key without read/write access to `OID-Digital-Twin` will make the required storage provider unhealthy.
