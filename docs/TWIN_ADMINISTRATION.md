# Twin administration and ownership transfer

The same application code supports testnet and mainnet. Network, package IDs,
Stripe configuration and off-chain retention remain deployment configuration.

## Permissions

The owner can grant **Admin** from Access settings. Admin is on-chain scope bit
32, combined with all five read scopes (63 in total), all measurements and no
history bounds. Valid-from and expiry remain supported. Checking every read
permission (31) does not grant administration.

An active Admin has the same Twin capabilities as its owner: configuration,
image, location, operational data, commands, device credentials, access grants,
ownership transfer and deletion. API requests recheck current on-chain rights;
read-only grants never authorize mutations. Revocation and expiry apply to open
streams as well as new requests.

## Transfer

Open Twin configuration > Ownership > Transfer ownership. Enter the destination
IOTA DID on the same network, review the consequences and sign with the current
owner or an active Admin. The destination must be an active native Identity.
Native Identity quorum proposals are supported; a second approval can be needed.

The transfer keeps the Twin ID, bound subscription, subscription payer/controller,
storage configuration, encryption source context and service steward. It consumes
the normal UPDATE_TWIN_OWNER credit on the existing subscription. If the old owner
was also the steward, that steward role follows the new owner.

The transfer makes the Twin private, removes all previous reader/Admin grants and
increments the policy revision. The former owner loses Twin management rights;
the new owner can create fresh grants. Pending requests bind the actor, Twin,
previous owner, policy revision and expiry and cannot be replayed.

## Integration

The webview establishes a signed DID session with the source Integration Server.
Management sessions are bound to the browser session, DID, Twin and server and are
kept server-side. DTIS accepts x-objectid-twin-session only for that Twin's routes;
it cannot grant subscription/account-wide access. Accounting and encrypted source
lookup use the original bound subscription, independently from the current owner.

Package type origins must be preserved: IOTA_PACKAGE_ID is the original package,
IOTA_ACCESS_PACKAGE_ID is the v2 access type origin, IOTA_EXECUTION_PACKAGE_ID is
v3 and IOTA_MANAGEMENT_PACKAGE_ID is the v3 transfer request type origin. DTIS uses
the analogous DTIS_OBJECTID_* execution/access settings. See the Move release JSON
administration-release-2026-09-17.json for exact IDs and transaction digests.

This release does not add the historical dataset download UI. No existing Twin
was transferred or assigned an Admin as part of deployment.
