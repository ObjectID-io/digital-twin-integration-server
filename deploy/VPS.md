# VPS deployment

This deployment starts the ObjectID Digital Twin Integration Server, an authenticated Mosquitto broker, and Redis. It uses the published testnet package `0x8228c5a214d4e7d8a194090fd70d31ab9b000e5bfdb5f4fb558e042db145d835` and stores off-chain payloads in the private Backblaze bucket `OID-Digital-Twin`.

## Required values

1. Copy `.env.vps.example` to `.env` and set the service DID.
2. Set `B2_KEY_ID` in `secrets/credentials.json` to the Backblaze Application Key ID. The bucket ID is not an S3 credential.
3. Set `MQTT_TWIN_ID` to an existing `OIDTwin` object created with the published testnet package.
4. Keep `MQTT_PASSWORD` in `secrets/credentials.json` identical to the contents of `secrets/mqtt_password.txt`.
5. Set `DTIS_IOTA_SEED` to the 64-character hexadecimal seed, without `0x`, and set `DTIS_SIGNER_ADDRESS` to its derived IOTA address.
6. Set `DTIS_TWIN_CONTROLLER_CAP_ID`, `DTIS_OID_CREDIT_POLICY_ID`, and `DTIS_OID_CREDIT_TOKEN_ID` to objects controlled by that signer.

The supplied Backblaze application key is kept only in the ignored local credentials file. Rotate it if this workspace or conversation has been shared.
The IOTA seed is equivalent to a private signing key. Never commit `secrets/credentials.json`; startup fails if the seed derives an address different from `DTIS_SIGNER_ADDRESS`.

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
```

Docker Compose implements local file-backed secrets as bind mounts and does not remap their host permissions. Keep the `secrets` directory at mode `0700` and its mounted files at `0644`; the private parent directory protects them on the VPS while allowing the non-root container processes to read the mounts. The simulator runs without Linux capabilities on a read-only filesystem.

Publish a state sample from the VPS:

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -u objectid -P "$(cat secrets/mqtt_password.txt)" \
  -q 1 -t objectid/twins/telemetry/state -m '{"temperature":42.5,"unit":"Cel"}'
```

Both published ports bind to loopback by default. Put the HTTP service behind an HTTPS reverse proxy. Expose MQTT publicly only after adding TLS or restricting port 1883 to a VPN/private network.

## Digital Twin simulator

The Compose stack also runs `mqtt-digital-twin-simulator`. It publishes industrial telemetry every five seconds to the dataset topic. The integration server aggregates these samples into five-minute windows before storing and registering each dataset, limiting OID Credit consumption.

```bash
docker compose logs -f mqtt-digital-twin-simulator digital-twin-integration-server
```

Set `SIM_INTERVAL_MS` or `SIM_MACHINE_NAME` in `.env` to customize it. Do not switch `SIM_MQTT_TOPIC` to the state topic unless on-chain state publication and its OID Credit cost are intended.

The unauthenticated demo control console is available at `https://dt-simulator.objectid.io`. It can inject overheat, high-vibration, spindle-overload, pressure-loss and emergency-stop telemetry, or pause and resume publication. Every scenario transition also publishes one state message; the integration server records the resulting `OIDTwinState` and event 30 in the on-chain Digital Thread, consuming one OID Credit per transition rather than per telemetry sample.

Successful on-chain publication is logged as `iota_twin_state_published` with the transaction digest. A transition emitted before the signer was enabled is not replayed automatically; select a different scenario after deployment to generate a new state event.

## Digital Twin Console

The `digital-twin-console` service publishes the read-only operational dashboard at `https://dt-demo.objectid.io` through the external `traefik_proxy` network. It keeps API and MQTT credentials server-side, streams live telemetry over SSE, and exposes technical congruity, coherence and standards-alignment checks.

```bash
docker network inspect traefik_proxy >/dev/null
docker compose up -d --build digital-twin-console
docker compose logs -f digital-twin-console
```

The console presents a technical self-assessment and does not claim formal ISO certification.

## Backblaze check

After setting the Application Key ID, use `/ready` and inspect the server logs. An invalid key pair or a key without read/write access to `OID-Digital-Twin` will make the required storage provider unhealthy.
