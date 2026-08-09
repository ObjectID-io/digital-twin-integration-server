# VPS deployment

This deployment starts the ObjectID Digital Twin Integration Server, an authenticated Mosquitto broker, and Redis. It uses the published testnet package `0x8228c5a214d4e7d8a194090fd70d31ab9b000e5bfdb5f4fb558e042db145d835` and stores off-chain payloads in the private Backblaze bucket `OID-Digital-Twin`.

## Required values

1. Copy `.env.vps.example` to `.env` and set the service DID.
2. Set `B2_KEY_ID` in `secrets/credentials.json` to the Backblaze Application Key ID. The bucket ID is not an S3 credential.
3. Set `MQTT_TWIN_ID` to an existing `OIDTwin` object created with the published testnet package.
4. Keep `MQTT_PASSWORD` in `secrets/credentials.json` identical to the contents of `secrets/mqtt_password.txt`.

The supplied Backblaze application key is kept only in the ignored local credentials file. Rotate it if this workspace or conversation has been shared.

## Start and verify

```bash
cp .env.vps.example .env
chmod 600 .env secrets/credentials.json secrets/mqtt_password.txt
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8080/ready
```

Publish a state sample from the VPS:

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -u objectid -P "$(cat secrets/mqtt_password.txt)" \
  -q 1 -t objectid/twins/telemetry/state -m '{"temperature":42.5,"unit":"Cel"}'
```

Both published ports bind to loopback by default. Put the HTTP service behind an HTTPS reverse proxy. Expose MQTT publicly only after adding TLS or restricting port 1883 to a VPN/private network.

## Backblaze check

After setting the Application Key ID, use `/ready` and inspect the server logs. An invalid key pair or a key without read/write access to `OID-Digital-Twin` will make the required storage provider unhealthy.
