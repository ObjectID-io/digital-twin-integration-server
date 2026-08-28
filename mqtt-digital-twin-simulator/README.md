# ObjectID MQTT Digital Twin Simulator

Simulates an industrial machine and publishes JSON telemetry to the MQTT broker used by the ObjectID Digital Twin Integration Server.

With dedicated Twin credentials, the dataset topic is read exactly from the downloaded ACL configuration. `objectid/twins/telemetry/dataset` is only the legacy service-account fallback. Samples are emitted every fifteen seconds and aggregated by the integration server into five-minute datasets. This avoids invoking the on-chain state operation, and therefore consuming a subscription operation credit, for every simulated sample.

## Configuration

### Dedicated Twin credentials (recommended)

First download the tenant administration file from **Webview → Integration**; this is required before Twin creation and must remain on a trusted operator system. After creating each Twin, download its one-time `objectid.device-provisioning.v1` file. A simulator installation can run any number of these Twin-scoped files concurrently: every Twin gets an independent MQTT connection, client identity, ACL, telemetry sequence, scenario and command subscription.

For a first bootstrap file, start the simulator with:

```bash
export SIM_INTEGRATION_CONFIG_FILE=/absolute/path/objectid-dtis-free-customer.json
docker compose -f docker-compose.yml -f compose.simulator-tenant.yml \
  --profile simulator up -d --build mqtt-digital-twin-simulator
```

The simulator reads the MQTT endpoint, one-time password, Twin-scoped username, bound Twin ID and the exact state/dataset/command topics from each file. A device credential can access only its assigned Twin and contains no tenant REST API key. Never commit a downloaded file: it contains live credentials. Older tenant configuration files remain accepted for migration.

Open `https://dt-simulator.objectid.io`, select one or more per-Twin JSON files in **Add simulated Twins** and choose **Add Twin files**. No additional password is required: possession of the one-time device file and successful authentication of its MQTT credential authorize that Twin's self-provisioning. Only files bound to the hosted `dtis.objectid.io` testnet or mainnet MQTT endpoint are accepted through this flow. The server verifies the credential before storing the file separately under `/data/twins` with mode `0600`, then starts or replaces only that Twin runtime. Existing simulations continue without a restart.

Use the Twin selector to inspect and control a simulation. **Remove** deletes only its local simulator configuration and never deletes the on-chain Digital Twin; this management operation still requires the simulator administration password from `/run/secrets/sim_control_password`.

On the VPS, read that administration password with:

```bash
cd ~/digital-twin-integration-server
cat secrets/sim_control_password.txt
```

Before the first valid upload, the container may connect with the legacy broker account but stays paused with `twinId=unknown`; it cannot publish telemetry to a retired or placeholder Twin. After upload, `/api/status` returns a `twins` array. Each entry must report `credentialSource: "integration-file"`, its expected Twin ID and `paused: false`.

| Variable | Default | Description |
| --- | --- | --- |
| `MQTT_URL` | `mqtt://mosquitto:1883` | Broker URL inside the Compose network. |
| `MQTT_USERNAME` | `objectid` | Broker username. |
| `MQTT_PASSWORD_FILE` | `/run/secrets/mqtt_password` | Docker secret containing the password. |
| `OBJECTID_INTEGRATION_CONFIG_FILE` | unset | Downloaded DTIS integration configuration JSON. |
| `OBJECTID_SIMULATOR_CONFIG_DIR` | `/data/twins` | Persistent directory containing one protected configuration file per simulated Twin. |
| `SIM_TWIN_ID` | first Twin in configuration | Selects a Twin when the downloaded configuration contains several. |
| `MQTT_TOPIC` | `objectid/twins/telemetry/dataset` | Destination topic. |
| `SIM_INTERVAL_MS` | `15000` | Sample interval, minimum 1000 ms. |
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

Open `https://dt-simulator.objectid.io` to select a simulated Twin, inject CNC fault scenarios and control its telemetry stream. Each scenario transition publishes one state message, producing an on-chain `OIDTwinState` and `EVENT_STATE_PUBLISHED` Digital Thread record through the integration server. Repeated telemetry samples remain in the aggregated dataset and do not consume one subscription operation credit each.
