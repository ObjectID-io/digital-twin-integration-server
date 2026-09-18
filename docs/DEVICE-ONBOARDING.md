# Device-first Twin onboarding

## Workflow

### One workflow in DT

Sign in to DT/DT-demo with your DID and open **Create a Digital Twin**.
Register the device, download its credentials, read a sample, map signals and
create/open the Twin in the same dialog. DT's BFF obtains the five-minute IS
capability server-side; the new workflow never puts it in a browser link.
The old IS `/devices` and `/my-twins` pages redirect to DT and clear old fragments.

### Native DID login on IS: tenant credentials only

Choose **SIGN IN** on the IS homepage, then **TENANT ACCESS**. The seed or
recovery file signs a one-time challenge in the browser. IS verifies the configured
identity-package ControllerCap. A 30-minute Secure/HttpOnly/SameSite=Strict cookie
is scoped to the network; mutations require the configured Origin.

Login does not require a subscription. Tenant access can inspect the linked
dynamic tenant, generate/rotate application credentials after checking its active
subscription, or revoke those application credentials without revoking devices.
Secrets are downloaded once as `objectid.tenant-access.v1`; existing secrets are
not recoverable. Rotation invalidates old application credentials.
Subscription purchase, activation and renewal remain exclusively in DT.
IS does not receive a subscription-administration capability.

### Device setup in DT

1. Register a named device, optionally setting an AES-256-GCM/scrypt payload password.
   Download `objectid.device-onboarding.v1`. This file contains device secrets;
   transfer it only to the device/simulator. It has a device ID, not an on-chain Twin ID.
2. Send JSON via the supplied HTTPS endpoint and bearer token, or MQTT telemetry topic.
   MQTT credentials can only publish that device topic; no command or wildcard read ACL.
3. Inspect a sample, supplying its decryption password when encrypted. Select scalar
   fields, assign unique keys, labels and units. Source JSON pointers remain separate.
   Units are metadata: no automatic numerical conversion is performed.
4. Confirm creation. IS validates the subscription, signs the private Twin and records
   a version-1 signal schema in mutable metadata and its encrypted device store.
5. Choose **OPEN TWIN** in DT without downloading/importing another file.
   TwinScope can select the existing authorized catalog or import `objectid.twin-catalog.v1`.
   Imports select an existing authorized Twin; they never recreate it or trust URLs,
   passwords, ownership or field overrides from the file. TwinScope filters by plant
   and tenant. DT verifies on-chain DID association before remembering the Twin.

## Authority and storage

Personal DT creation uses the logged-in DID's subscription and personal plant, tenant
null. TwinScope creation retains the plant/tenant owner's subscription and ownership,
with the requesting operator identified separately. The trusted TwinScope BFF signs
the plant/node scope after AAA; custom connections must belong to the owner.
The IS workbench session is a capability with a maximum five-minute lifetime: a grant
revoked in TwinScope prevents new sessions, but an issued session lasts until expiry.

Device records and decoder passwords are encrypted through PlantService in IS-managed
storage; `/data/plants/devices` (relative to the configured tenant catalog directory)
contains only catalog pointers. `DTIS_PLANT_ENCRYPTION_KEY` protects records and
`DTIS_PLANT_ACCESS_KEY` signs workbench sessions. Keep both in the credential provider,
never source control. Device payload encryption is distinct from storage encryption.

Phase-one samples stay in bounded RAM (256 devices, latest sample only, 15-minute TTL,
64 KiB/sample, one accepted sample/second/device), not a historical raw-data archive.
After classification, subsequent samples follow the existing Twin realtime/dataset
pipeline. Encrypted input is decoded on IS and the normalized output re-encrypted with
the configured payload password. Authorized viewers still need that password configured
in their connection. Catalog exports contain no secrets.

Revoking a device blocks HTTP and MQTT ingestion and removes its broker credentials;
it does not delete its Twin. Bootstrap credentials are not Twin credentials and must
not be rotated using the old Twin credential button. To replace them in this initial
version, revoke the old device and enroll a new device.

## Compatibility and current limits

The new acquisition path supports MQTT and HTTPS JSON. Existing OPC UA/Modbus edge
flows are unchanged; they can forward to the HTTPS/MQTT endpoint, but direct wizard
provisioning for those protocols is not implemented. Existing Twin-first configurations
continue to work. The simulator accepts both provisioning formats; bootstrap devices
publish telemetry only, not IOTA state transitions or commands.

This first version classifies up to 100 scalar fields and creates one Twin per device.
Arrays, schema editing/reclassification, device-to-many-Twins mappings and automatic
reconciliation are not yet exposed. No alarm thresholds are inferred: configure them
in TwinScope. DT displays classified labels/units without applying legacy machine
thresholds or charts to unrelated signals.

A persisted `creating` marker blocks repeat chain submissions after an ambiguous
result. An operator must inspect the chain receipt before reconciling the record;
never clear this marker and retry blindly. Subscription preflight failures leave the
device waiting and retryable. Registration is not idempotent; if the download fails,
revoke the unused device before enrolling another.

## Rollout

Deploy IS, webview (both networks), TwinScope and simulator as a coordinated release.
Back up encrypted stores, catalog volumes and credential providers. No existing Twin
or device credentials are migrated automatically. Test the complete workflow with a
dedicated testnet subscription before any mainnet rollout. Unit tests mock the chain;
they do not prove that a production signer, broker or storage deployment is configured.

OpenAPI documents `/api/device-workbench/*`, `/api/plants/device-workbench/session`,
`/api/v1/device-workbench/session` and `/device-input/{tenantId}/{deviceId}`. The internal
DT BFF provisioning bridge `/internal/device-workbench/session` requires its existing
provisioning key and an owner DID; do not expose it as a public login API.
