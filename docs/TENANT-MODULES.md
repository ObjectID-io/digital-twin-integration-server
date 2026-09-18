# Tenant module controls

Open `/` (testnet) or `/mainnet/`, sign in using the DID signature dialog, then use the controls directly on the **Service health** cards. Controls appear only when the session network matches the displayed network. REST and AI controls are on their respective cards; device-command controls are inside the MQTT card and do not stop the shared broker. Tenant access remains dedicated to credentials.

Only the authenticated tenant owner can change these controls. The server derives the tenant from the verified DID session, never from submitted tenant IDs. Mutations require the existing same-origin session checks. Login does not grant server-administrator access.

| Module | Pause effect |
| --- | --- |
| AI analysis | Stops new analysis for this tenant, aborts pending HTTP requests locally, and removes cached samples/results. Late results are discarded. |
| Device commands | Rejects new command submissions from this tenant. Previously submitted commands are not recalled. |
| REST data requests | Rejects new requests through the REST fetch endpoint from this tenant. Existing requests and MQTT ingestion are unaffected. |

Enable only resumes an already configured module. AI additionally requires this tenant to have an explicitly approved scope in the server configuration. Provider, secrets, field allowlists and data-sharing consent cannot be changed through this panel. Disabled server features cannot be enabled by a tenant.

Settings are atomically stored in `tenant-modules.json` in the local plant catalog directory, with the actor DID and timestamp of the latest change. Mount this directory persistently. One DTIS process must own the file; it is not a multi-replica coordination mechanism. Invalid persisted settings fail startup rather than silently enabling modules. Existing deployments default to their configured behaviour until an owner changes a switch.

Shared MQTT infrastructure, storage, authentication, subscriptions and security are deliberately not tenant-toggleable. AI cancellation cannot recall data already received by an external provider or guarantee cancellation of provider-side billing. AI analysis remains advisory and never executes device commands.
