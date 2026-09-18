# ObjectID MQTT Digital Twin Simulator

## Device-first enrollment

The upload form also accepts `objectid.device-onboarding.v1` exported by the IS
workbench before an on-chain Twin exists. A bootstrap device publishes only its
assigned telemetry topic; state transitions and command subscriptions are disabled.
If the export contains an encryption password, outgoing samples use the IS-compatible
AES-256-GCM/scrypt envelope. The stored configuration contains secrets and remains in
the existing private configuration volume; it is never returned by the status API.
After IS classification, the same device credentials continue working: IS routes
its samples to the resulting Twin. Existing `objectid.device-provisioning.v1` and
legacy tenant configuration files remain supported. Custom endpoints require the
simulator administrator; hosted files are checked against the hosted broker.

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

After rotating one Twin's device credentials in the Webview, select the same runtime and choose **Update credentials**. The simulator accepts the replacement only when the uploaded file is bound to the selected Twin, verifies the new MQTT login, atomically replaces its protected file and restarts only that runtime. No simulator administration password is required.

Use the Twin selector to inspect and control a simulation. **Enable mobility** starts publishing a dynamic GeoJSON position for the selected asset; **Disable mobility** stops including that dynamic position in subsequent telemetry. The command publishes one sample immediately, affects only the selected Twin and does not change any other runtime. This control is operational rather than persistent: after a simulator restart, mobility returns to the value stored in the Twin configuration or `SIM_MOBILE_ENABLED`.

**Remove** deletes only its local simulator configuration and never deletes the on-chain Digital Twin; this management operation still requires the simulator administration password from `/run/secrets/sim_control_password`.

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
| `SIM_MOBILE_ENABLED` | `true` in the supplied Compose stack | Initial mobility state restored when the simulator starts. |
| `SIM_MOBILE_CENTER_LATITUDE` | `45.4642` | Latitude of the simulated circular route centre. |
| `SIM_MOBILE_CENTER_LONGITUDE` | `9.1900` | Longitude of the simulated circular route centre. |
| `SIM_MOBILE_RADIUS_KM` | `4` | Radius of the simulated route in kilometres. |
| `SIM_MOBILE_SPEED_KPH` | `42` | Simulated asset speed in kilometres per hour. |
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

## Energy simulation profile

Select a Twin, choose **Energy — solar and demand**, configure the parameters and click **APPLY PROFILE**. The industrial profile remains available. Use a dedicated energy device with the appropriate measurement mapping in the Integration Server; changing a simulator profile does not change that mapping or the Twin schema.

The energy profile publishes `objectid.telemetry.energy.v1` through the existing scoped MQTT topic and preserves device encryption. Measurements are `solarIrradiance` (W/m2), `pvPower`, `loadPower`, `gridPower`, `gridImportPower`, and `gridExportPower` (kW). Positive grid power means import, negative means export. Grid power equals demand minus PV production. Scenarios: `normal`, `cloudy`, `demand-peak`, `inverter-offline`. Mobility is disabled for energy.

Defaults: 50 kW PV, 20 kW base demand, seed 42, UTC start 2026-06-21 06:00, and 300 simulated seconds per sample. `observedAt` records publication time; `simulation.simulatedAt` records virtual time. The `simulation` object marks data synthetic and records the model version, input parameters and sample index. Identical parameters and scenario sequences reproduce the measurements, independently of publication time. This is a simplified demonstrator, not a calibrated energy forecast or a signed provenance certificate.

Profile and parameters are stored separately from credentials under `<OBJECTID_SIMULATOR_CONFIG_DIR>/simulation-settings/`, one file per Twin. Applying a profile resets its scenario and simulation clock and preserves pause state. A process restart restores parameters but starts a new replay at sample zero and the normal scenario. Scenario changes continue the clock. Profile persistence errors leave the current configuration unchanged.

For classified bootstrap devices, the Integration Server forwards only configured signal mappings; preserving simulation metadata in downstream datasets and adding energy charts to dt-demo require separate integration work. The simulator's energy controls work directly; exposing energy scenarios through the Integration Server command catalog also requires updating that catalog.
