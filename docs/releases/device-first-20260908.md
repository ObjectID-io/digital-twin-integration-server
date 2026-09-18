# Device-first testnet release — 2026-09-08

Published IS testnet, simulator, DT demo and TwinScope demo. Mainnet services were not changed or restarted.

Native DID login: https://dtis.objectid.io/devices . Personal message signature is generated in the browser; server verifies the exact configured identity-package ControllerCap. An opaque HttpOnly Secure SameSite cookie authorizes the workbench. Subscription checks remain on creation; delegated TwinScope ownership is retained in scoped workbench sessions.

Checks: 216 IS tests passed, TypeScript and production build passed. DT tests/build passed. All four deployed containers healthy, public pages and login bundle return 200. Anonymous device listing returns 401. A real existing service identity signed a login challenge; on-chain controller verification, native session context and logout passed, without a chain transaction or Twin creation.

Customer device-to-Twin creation, decryption and catalog import still require an end-to-end test with the customer's DID/subscription. Initial wizard supports MQTT and HTTPS JSON. Readiness reports required connectors and storage healthy; optional OPC UA has no session and Modbus reports not implemented.

VPS backup: /root/backups/device-first-20260908/{sources,volumes}.tgz (root-only). Pre-release images tagged pre-device-20260908 for IS, simulator, DT and TwinScope. Existing data and broker were preserved. DTIS_IDENTITY_PACKAGE_ID was added from the existing DT testnet public configuration; other credentials preserved.
