# ObjectID Digital Twin Console

Read-only operational console for the ObjectID Digital Twin deployed at `dt.objectid.io`.

The Node gateway serves the React application, subscribes to MQTT telemetry, exposes it to the browser through Server-Sent Events, and proxies a fixed set of read operations to the integration server. API keys and MQTT credentials remain Docker secrets and are never returned to the browser.

The assurance view is a deterministic technical self-assessment. It does not claim formal ISO certification or clause-by-clause conformity.

## Deploy

```bash
docker compose up -d --build digital-twin-console
docker compose ps digital-twin-console
docker compose logs -f digital-twin-console
```

Traefik must provide the external network `traefik_proxy` and the `websecure` entrypoint with the `myresolver` certificate resolver.
