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

Do not enable `delegatedAccounts` against the previous package: it does not expose
`create_twin_for_subscription_owner`.
