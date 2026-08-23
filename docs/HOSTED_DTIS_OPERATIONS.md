# Hosted DTIS operations

This runbook describes the current hosted testnet service at
`dtis.objectid.io`, its relationship with the ObjectID Webview and the supported
device/simulator credential lifecycle.

## Responsibility boundaries

| Component | Responsibility | Not authoritative for |
| --- | --- | --- |
| IOTA / ObjectID Move package | Twin roots, roles, subscriptions, credit accounting and Digital Thread evidence | Realtime transport and bulk payload bytes |
| ObjectID Gas Station | IOTA gas sponsorship for allowlisted package targets | Subscription entitlement or application authorization |
| DTIS | Tenant validation, policy enforcement, connector ingestion, sponsored mutations and off-chain storage routing | Twin ownership or billing account selection by clients |
| Webview BFF | DID session proof, secret isolation, Integration Server selection and private-location encryption | MQTT transport or final Move authorization |
| MQTT broker | Authenticated device transport with generated ACLs | Tenant accounting or Twin policy |
| Simulator/device | Telemetry publication and signed command execution | Choosing another tenant's subscription or Twin |

Gas is always paid by ObjectID for allowlisted targets. Subscription operation
credits and Twin limits are charged independently to the customer's
`SubscriptionAccount`.

## Tenant request path

For an authenticated mutation DTIS:

1. resolves the API key or JWT to a server-side tenant entry;
2. obtains the tenant's customer ID, owner DID and subscription ID from that
   entry, never from the request body;
3. reads the Twin and subscription from IOTA;
4. verifies that the Twin belongs to the same subscription;
5. verifies the active period, remaining operation credits and caller role;
6. constructs the controlled Move call;
7. asks an ObjectID Gas Station to sponsor gas;
8. submits and returns the finalized transaction result.

The Move call repeats the material controller, subscription, period and credit
checks atomically. A trusted DTIS therefore cannot spend another customer's
subscription merely because a caller supplies an object ID.

## Subscription authority boundary

DTIS never owns or uses `SubscriptionAdminCap`. The service supervisor in the
Webview control plane creates and renews `SubscriptionAccount` objects after
testnet policy checks or verified mainnet billing events. Only after the
on-chain account is active does the Webview call `POST /internal/integration-accounts`.
DTIS independently verifies the supplied account on IOTA, then creates the
generic tenant API and MQTT credentials required for integration.

## Tenant and Twin credential lifecycle

The Webview's **Integration credentials** console uses protected internal
endpoints; browsers never receive the provisioning key.

1. **Tenant status** reports whether administration credentials exist without
   returning secrets.
2. **Tenant generate/rotate** creates a tenant API key, MQTT username and MQTT password,
   stores only verifiers/required server state, regenerates Mosquitto ACLs and
   displays secrets once.
3. **Tenant download** produces an administration configuration containing:
   - DTIS API and MQTT endpoints;
   - tenant ID and API key;
   - MQTT username and password;
   - permitted Twin IDs;
   - exact state, dataset and command topics.
   The hosted Webview records successful download and does not enable Twin
   creation before this prerequisite is complete.
4. **Twin create/provision** issues a different MQTT principal after creation.
   Its `objectid.device-provisioning.v1` file has no REST key and contains only
   one Twin ID and that Twin's exact four topic permissions.
5. **Rotate/revoke** may affect all tenant administration credentials or one
   Twin device credential independently. Tenant revocation also revokes its
   active per-Twin principals without deleting the
   DID, subscription or Twins.

Rotation invalidates the previous credential at the selected scope. Both JSON
files are live secrets and must never be committed, logged or placed in a
public volume. PLCs, gateways and simulators should receive only their per-Twin
file.

## MQTT tenancy and topics

Hosted tenant devices publish only to generated ACL topics:

```text
objectid/tenants/{tenantId}/twins/{twinId}/telemetry/state
objectid/tenants/{tenantId}/twins/{twinId}/telemetry/dataset
```

Command requests and results use the exact topics returned in the downloaded
configuration. DTIS derives tenant and Twin context from trusted connector
mapping/topic captures and revalidates the Twin subscription before processing.
Payload fields cannot select a billing account.

Dataset telemetry is normally aggregated into five-minute windows, stored
off-chain and registered with URI/hash evidence. State publication and scenario
transitions create on-chain `OIDTwinState`/Digital Thread evidence and consume
the package-defined operation credit.

## Twin lifecycle API

All tenant API routes require the tenant credential and reject cross-tenant Twin
IDs.

```text
POST   /api/v1/twins
GET    /api/v1/twins/{id}
PATCH  /api/v1/twins/{id}
DELETE /api/v1/twins/{id}
```

`PATCH` calls `update_twin_metadata` after owner/steward policy enforcement. It
is used by the Webview for both public/private visibility and explicit public
location publication. The Webview reads the current metadata first and
preserves unrelated fields.

Public discovery uses:

```json
{
  "objectid": {
    "visibility": "public",
    "location": {
      "visibility": "public",
      "latitude": 45.4642,
      "longitude": 9.19,
      "precision": "city",
      "label": "Milan"
    }
  }
}
```

Twin visibility does not automatically publish a private Webview location.
Location publication requires a separate explicit owner/steward action.

## Simulator onboarding

The recommended hosted workflow is:

1. generate and download the tenant administration file in the Webview;
2. create a Twin and download its non-dismissible per-Twin configuration;
3. open `https://dt-simulator.objectid.io`;
4. upload the per-Twin JSON and enter the password stored on the VPS in
   `secrets/sim_control_password.txt`;
5. choose **Upload & apply**.

The simulator validates file size and schema, network/Twin consistency, exact
topics and a secure MQTT endpoint. The per-Twin file contains no REST API key;
the simulator stores its MQTT/ObjectID subset with mode `0600` in the private
`simulator-data` volume and restarts automatically. Before the first valid
upload it starts paused with `twinId=unknown`.

For unattended/self-hosted deployments, mount the per-Twin file and set
`OBJECTID_INTEGRATION_CONFIG_FILE`. Legacy multi-Twin tenant files remain
accepted for migration, with `SIM_TWIN_ID` selecting the desired Twin.

## Self-hosted DTIS

A customer-operated DTIS uses its own signer/controller configuration and a
subscription whose integration controller has been explicitly assigned by the
owner. It can manage another owner's Twin only when all of the following are
true:

- the owner assigned that integration controller;
- the authenticated tenant maps to the owner's subscription;
- the Twin `subscription_id` matches;
- the local role policy and Move authorization allow the operation;
- the subscription is active and has remaining credits.

Gas remains sponsored by ObjectID for the controlled package. Self-hosting does
not grant arbitrary authority and does not move gas cost to the customer.

## Deployment and health verification

No Twin is required before starting the stack. Start the API/broker/storage
services first; create Twins later through Webview or API; configure devices or
the simulator last.

```bash
docker compose config --quiet
docker compose up -d --build digital-twin-integration-server
docker compose ps

curl --fail http://127.0.0.1:8080/health
curl --fail http://127.0.0.1:8080/ready

API_KEY=$(jq -r '.DTIS_PUBLIC_TENANT_API_KEY' secrets/credentials.json)
curl --fail -H "x-api-key: $API_KEY" \
  http://127.0.0.1:8080/api/v1/subscription
```

`/ready` must report ObjectID, profiles, required connectors and storage as
healthy. Keep the credential parent directory private while making bind-mounted
files readable by the non-root container user as described in `deploy/VPS.md`.

## Failure interpretation

| Symptom | Likely cause |
| --- | --- |
| `OBJECTID_TENANT_TWIN_MISMATCH` | API tenant subscription and Twin `subscription_id` differ |
| `TWIN_POLICY_DENIED` | Caller DID lacks the required owner/steward/role grant |
| `OBJECTID_SUBSCRIPTION_CREDIT_EXHAUSTED` | Inactive period or no remaining operation credits |
| Sponsored submission reports wrong signer | `ControllerCap` owner and configured DTIS signer differ |
| MQTT `Not authorized` | Username/password or generated ACL does not match the tenant configuration |
| Simulator connected but no ingestion | Wrong Twin/topic selection, revoked credentials or simulator paused |
| Public Twin is unlocated | Visibility is public but no explicit public on-chain location exists |
