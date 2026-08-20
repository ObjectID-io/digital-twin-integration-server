# Trusted DTIS multi-tenant accounting

`dtis.objectid.io` signs mutations as the trusted integration controller, but every authenticated
tenant is resolved server-side to its own on-chain `SubscriptionAccount`. The caller cannot select
the billed account in an API payload.

For every mutation DTIS reads the Twin and subscription from IOTA and verifies that:

- the API key/JWT maps to a configured tenant;
- the tenant customer ID and owner DID match the subscription;
- the Twin `subscription_id` matches the tenant account;
- the subscription is active and has remaining credits;
- the configured DTIS controller is authorized by Move as the subscription integration controller
  and Twin steward.

The Move call repeats the controller, Twin/subscription, period and credit checks atomically. Gas is
always sponsored separately by the ObjectID Gas Station.

## Tenant registry

Store the registry inside the protected DTIS credential file. API keys remain separate credentials:

```json
{
  "CUSTOMER_ACME_API_KEY": "a-long-random-secret",
  "DTIS_TENANTS_JSON": {
    "tenants": [
      {
        "tenantId": "acme",
        "customerId": "acme",
        "ownerDid": "did:iota:testnet:0x...customer-controller-id...",
        "subscriptionId": "0x...subscription-account-id...",
        "apiKeyCredential": "CUSTOMER_ACME_API_KEY"
      }
    ]
  }
}
```

Connector mappings must declare `tenantId`; this value comes from trusted server configuration,
not from MQTT payload data. A `defaultTenantId` may be configured for a dedicated single-tenant
connector.

## Provision a customer account

After publishing the updated Move package, export the package/admin/controller values and run:

```bash
export PACKAGE_ID=0x...
export SUBSCRIPTION_ADMIN_CAP_ID=0x...
export CUSTOMER_ID=acme
export CUSTOMER_CONTROLLER_ID=0x...
export INTEGRATION_CONTROLLER_ID=0x...public-dtis-controller-id...
export PLAN=base

./scripts/provision-dtis-tenant.sh
```

The script creates the monthly subscription and prints both its object ID and the registry entry.
`CUSTOMER_CONTROLLER_ID` owns the entitlement. `INTEGRATION_CONTROLLER_ID` may be the public DTIS
controller or a customer's self-hosted controller.

The owner can later call `assign_subscription_integration` with its `ControllerCap` to revoke the
public DTIS and assign another integration controller without recreating the subscription.

## Deployment order

1. Publish the updated Move package.
2. Create a customer subscription with `create_customer_subscription`.
3. Update the package ID and tenant registry in DTIS credentials/configuration.
4. Rebuild and restart DTIS.
5. Create new Twin objects through the authenticated tenant API. They are owned by the customer DID
   and the assigned DTIS is recorded as steward.

## Free testnet onboarding

The hosted testnet DTIS may enable `security.testnetFreeSubscriptions`. A trusted Webview BFF calls
`POST /internal/testnet/free-subscriptions` with `DTIS_TESTNET_PROVISIONING_KEY` after it has verified
control of the customer's DID. DTIS provisions a 30-day Base account, stores only a SHA-256 hash of
the generated tenant API key, and returns the key once to the BFF for encrypted storage. Dynamic
tenants are persisted in `/data/testnet-tenants.json`. Expired free accounts are renewed lazily on
the next authenticated tenant request, retaining the SubscriptionAccount and resetting the Base
allowance. This endpoint is disabled outside testnet.

Both Gas Stations must allow the controlled package targets `create_customer_subscription`,
`renew_subscription`, and `create_twin_for_subscription_owner` before onboarding is enabled.

## External API and MQTT credentials

Free-subscription onboarding creates the BFF's tenant credential, but devices
and simulators use a separately managed external credential set. The protected
integration-credential endpoints can generate/rotate or revoke:

- one tenant API key;
- one MQTT username and password;
- ACL entries limited to the tenant's current Twin IDs and exact topics.

Secrets are returned only on generation/rotation. Status calls return metadata
and Twin IDs, not secret material. Revocation does not delete the on-chain
subscription or Twins. See `HOSTED_DTIS_OPERATIONS.md` for the complete flow.

## Metadata and public discovery mutations

`PATCH /api/v1/twins/:id` invokes `update_twin_metadata`. DTIS applies the same
tenant/Twin subscription validation as other mutations and the policy engine
restricts metadata changes to owner/steward authority. The hosted Webview uses
this route to change `objectid.visibility` and to publish an explicit
`objectid.location` while preserving unrelated mutable metadata.

Do not enable `delegatedAccounts` against the previous package: it does not expose
`create_twin_for_subscription_owner`.
