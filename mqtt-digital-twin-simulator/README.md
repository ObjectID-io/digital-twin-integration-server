# ObjectID MQTT Digital Twin Simulator

Simulates an industrial machine and publishes JSON telemetry to the MQTT broker used by the ObjectID Digital Twin Integration Server.

The default topic is `objectid/twins/telemetry/dataset`. Samples are emitted every five seconds and aggregated by the integration server into five-minute datasets. This avoids invoking the on-chain state operation, and therefore consuming an OID Credit, for every simulated sample.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MQTT_URL` | `mqtt://mosquitto:1883` | Broker URL inside the Compose network. |
| `MQTT_USERNAME` | `objectid` | Broker username. |
| `MQTT_PASSWORD_FILE` | `/run/secrets/mqtt_password` | Docker secret containing the password. |
| `MQTT_TOPIC` | `objectid/twins/telemetry/dataset` | Destination topic. |
| `SIM_INTERVAL_MS` | `5000` | Sample interval, minimum 1000 ms. |
| `SIM_ASSET_ID` | `unknown` | Object ID included in each sample. |
| `SIM_MACHINE_NAME` | `mqtt-digital-twin` | Simulated machine name. |
| `SIM_STATE_TOPIC` | `objectid/twins/telemetry/state` | Topic used once per fault transition to create an on-chain State Published event. |
| `SIM_COMMAND_TOPIC` | `objectid/twins/{SIM_ASSET_ID}/commands/request` | Signed operational commands dispatched by the Integration Server. |
| `SIM_COMMAND_INTERFACE_ID` | `urn:objectid:interface:simulator-control:v1` | Only commands for this allowlisted interface are accepted. |
| `SIM_COMMAND_SIGNING_KEY_FILE` | `/run/secrets/command_signing_key` | Base64-encoded 32-byte shared key used to authenticate Integration Server envelopes. |
| `SIM_COMMAND_SIGNING_KEY_ID` | `dtis-command-v1` | Identifier of the accepted transport-signing key. |

The simulator implements `pauseSimulation`, `resumeSimulation` and `setSimulationScenario`. Before execution it validates the Twin and interface identifiers, command catalog and parameters, caller proof presence, request lifetime and idempotency fields, then verifies the Integration Server's RFC 8785 / HMAC-SHA256 authorization with constant-time comparison. It publishes `accepted`, `executing` and final result envelopes to `objectid/twins/{twinId}/commands/{commandId}/result`, replays the cached final result for QoS 1 duplicates, and rejects `emergency-stop` through this non-safety channel.

To publish on-chain state updates instead, set `SIM_MQTT_TOPIC=objectid/twins/telemetry/state`. Each processed state can consume an OID Credit, so use a suitably long interval.

## VPS commands

```bash
docker compose up -d --build mqtt-digital-twin-simulator
docker compose ps
docker compose logs -f mqtt-digital-twin-simulator digital-twin-integration-server
```

Open `https://dt-simulator.objectid.io` to inject CNC fault scenarios and control the telemetry stream without authentication. Each scenario transition publishes one state message, producing an on-chain `OIDTwinState` and `EVENT_STATE_PUBLISHED` Digital Thread record through the integration server. Repeated telemetry samples remain in the aggregated dataset and do not consume one OID Credit each.
