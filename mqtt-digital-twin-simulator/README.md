# ObjectID MQTT Digital Twin Simulator

Simulates an industrial machine and publishes JSON telemetry to the MQTT broker used by the ObjectID Digital Twin Integration Server.

With dedicated tenant credentials, the dataset topic is read exactly from the downloaded ACL configuration. `objectid/twins/telemetry/dataset` is only the legacy service-account fallback. Samples are emitted every five seconds and aggregated by the integration server into five-minute datasets. This avoids invoking the on-chain state operation, and therefore consuming a subscription operation credit, for every simulated sample.

## Configuration

### Dedicated tenant credentials (recommended)

Download the JSON file from **Webview → Integration → Integration credentials**, then start the simulator with the tenant overlay:

```bash
export SIM_INTEGRATION_CONFIG_FILE=/absolute/path/objectid-dtis-free-customer.json
docker compose -f docker-compose.yml -f compose.simulator-tenant.yml \
  --profile simulator up -d --build mqtt-digital-twin-simulator
```

The simulator reads the MQTT endpoint, one-time password, tenant username, Twin ID and the exact state/dataset/command topics from that file. When the file contains more than one Twin, set `SIM_TWIN_ID` to select one. Once installed, the file takes precedence over legacy service-account variables; dedicated `SIM_MQTT_*` override variables remain available for diagnostics. Never commit the downloaded file: it contains live credentials.

Alternatively, open `https://dt-simulator.objectid.io`, select the downloaded JSON in **Integration credentials**, enter the simulator administration password and choose **Upload & apply**. The server validates the file, discards the unused REST API key, stores the MQTT subset with mode `0600`, and restarts automatically. The administration password is read from `/run/secrets/sim_control_password` and is never stored by the browser.

On the VPS, read that administration password with:

```bash
cd ~/digital-twin-integration-server
cat secrets/sim_control_password.txt
```

Before the first valid upload, the container may connect with the legacy broker
account but stays paused with `twinId=unknown`; it cannot publish telemetry to a
retired or placeholder Twin. After upload, `/api/status` must report
`credentialSource: "integration-file"`, the expected Twin ID and `paused: false`.

| Variable | Default | Description |
| --- | --- | --- |
| `MQTT_URL` | `mqtt://mosquitto:1883` | Broker URL inside the Compose network. |
| `MQTT_USERNAME` | `objectid` | Broker username. |
| `MQTT_PASSWORD_FILE` | `/run/secrets/mqtt_password` | Docker secret containing the password. |
| `OBJECTID_INTEGRATION_CONFIG_FILE` | unset | Downloaded DTIS integration configuration JSON. |
| `SIM_TWIN_ID` | first Twin in configuration | Selects a Twin when the downloaded configuration contains several. |
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

To publish every sample as an on-chain state update, use the generated state topic (`SIM_STATE_TOPIC` when overriding diagnostics). Each processed state consumes a subscription operation credit, so keep dataset aggregation as the normal telemetry path.

## VPS commands

```bash
docker compose up -d --build mqtt-digital-twin-simulator
docker compose ps
docker compose logs -f mqtt-digital-twin-simulator digital-twin-integration-server
curl --fail https://dt-simulator.objectid.io/api/status | jq
```

Open `https://dt-simulator.objectid.io` to inject CNC fault scenarios and control the telemetry stream without authentication. Each scenario transition publishes one state message, producing an on-chain `OIDTwinState` and `EVENT_STATE_PUBLISHED` Digital Thread record through the integration server. Repeated telemetry samples remain in the aggregated dataset and do not consume one subscription operation credit each.
