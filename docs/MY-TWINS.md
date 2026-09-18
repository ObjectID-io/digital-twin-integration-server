# Personal Twin management

> UI migration: personal Twin setup and mapping now run in DT/DT-demo.
> The former IS `/my-twins` and `/devices` pages redirect to DT.
> The API details below describe retained compatibility services, not the current IS UI.
> Native IS sign-in opens **Tenant access** instead. Subscription commerce remains in DT.

## Device credentials

The Edit Twin dialog includes device credential status, non-mutating JSON download and explicitly confirmed regeneration. Native DID ownership, subscription membership and policy are checked for every request; regeneration additionally requires an active subscription. No credentials are included in catalog/status responses.

New onboarding files and regenerated files are retained only in the IS encrypted PlantService store. Older bootstrap secrets or legacy MQTT secrets cannot be recovered until regenerated. Legacy downloads use `objectid.device-provisioning.v1`; bootstrap downloads use `objectid.device-onboarding.v1`. Legacy files contain transport credentials: retain any independently configured device payload encryption settings.

`GET /api/my-twins/:id/credentials` returns availability only. `POST` with `{action:"download"}` retrieves the current file without rotation. `{action:"rotate",confirm:true}` regenerates it. Bootstrap rotation fails closed while broker/storage changes are pending. A failed rotation may already have invalidated credentials; inspect status before retrying. A legacy file is downloadable only while its saved version matches the current active credential version.

The status homepage authenticates a DID in a modal without navigation. After login, **My Twins** opens `/my-twins`. The native session cookie is shared on the same IS origin and network path. Scoped links from DT/TwinScope still open device onboarding; they cannot authorize the personal management API.

The personal list comes from the on-chain/indexed DID catalog, filtered to owned Twins, including Twins not created through the device wizard. New Twin opens device credential provisioning; Continue device setup opens sample classification. Open/Edit changes the on-chain name and description and preserves mutable metadata and signal configuration.

`GET /api/my-twins` returns the owned catalog. `POST /api/my-twins/:id/edit` accepts only name and description. `POST /api/my-twins/delete` requires `{ids: [...], confirm: true}` with 1–50 distinct valid IDs. Every mutation checks the authenticated DID against current on-chain ownership, subscription membership and policy. The server serializes personal management operations per Twin. Bulk deletion returns an individual result for each transaction, including uncertain failures; do not blindly retry an uncertain transaction.

Successful deletion attempts credential revocation for the Twin and linked bootstrap devices. `cleanupPending` means the Twin was deleted but revocation needs operator attention. Plant hierarchy nodes, documents and historical storage are not deleted by this operation. Index updates may lag on-chain receipts.

Browser regression checks: `deploy/check-my-twins-ui.mjs` uses mocked APIs and disposable non-secret identity data. It verifies unchanged homepage URL after sign-in, catalog navigation and modal create/edit/delete at desktop and mobile widths. It does not submit real chain transactions.
