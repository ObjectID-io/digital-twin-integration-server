# AI analysis connector (experimental)

The optional `ai` connector observes accepted realtime telemetry without modifying
the original payload, archiving AI output as telemetry, publishing transactions or
executing commands. It is disabled by default. It does not install or run a model.
An operator can supply an HTTP analysis agent implementing the contract below,
or select the native OpenAI Responses adapter after explicit external-sharing approval.

## Configuration

Add to the existing `connectors` section. This example is deliberately disabled.
Do not configure a token reference until its credential exists (credential
references are resolved at startup even for disabled connectors).

```yaml
ai:
  enabled: false
  required: false
  endpoint: https://your-approved-agent.example/analyze
  model: your-model
  allowDataSharing: true
  # token: ${credential:DTIS_AI_AGENT_TOKEN}
  intervalMs: 60000
  timeoutMs: 10000
  scopes:
    - tenantId: your-exact-tenant-id
      twinId: your-exact-twin-id
      fields:
        - measurements.temperature.value
        - measurements.vibration.value
```

Enable only after the customer approves the selected fields and agent endpoint.
HTTPS is required; `allowInsecureLocalEndpoint: true` permits HTTP for an explicitly
trusted local/private agent. Do not use this override for Internet endpoints.
Redirects are rejected. DID seeds, encryption passwords and DTIS API credentials
are never part of the analysis request. An optional dedicated bearer token is
resolved using the existing credential provider.

## Native OpenAI provider

Set `provider: openai`, `model: gpt-5.4`, `intervalMs: 300000`, and
`timeoutMs: 30000` in the same scoped configuration. Omit `endpoint`; the adapter
only accepts `https://api.openai.com/v1/responses`. Supply `OPENAI_API_KEY` through
the service's private environment (for example a git-ignored, mode-600 env file),
or use the existing `token` credential reference. Never commit a real key.

An optional administrator-controlled `context` (maximum 2000 characters) supplies
units and domain limitations. Do not include customer identifiers or secrets.
Requests use structured JSON output, `store: false`, no tools, and selected numeric
samples only. Provider retention policies still apply; this is not a zero-retention
guarantee. Refusals, incomplete output and invalid responses are rejected.

Module controls on the service card suspend new requests and abort in-flight
requests for the authenticated tenant. They cannot undo data already sent or charges
already incurred. Pausing does not stop telemetry ingestion.

## Agent contract

POST JSON: `schema: objectid.ai-analysis.request.v1`, `model`, a fixed `instruction`,
and `samples: [{observedAt, receivedAt, values: {"configured.field": 42}}]`.
Timestamps are epoch milliseconds. Only finite numbers at explicitly configured
dot-separated paths are included. Twin/tenant IDs, topics, arbitrary text, units,
and the complete original payload are not sent. Field names are untrusted data.
Configure domain context and units in the approved agent if needed.

The agent returns HTTP 200 with JSON:

```json
{
  "summary": "Temperature rose across the supplied samples. Inspect the cooling circuit if this persists.",
  "limitations": "No equipment thresholds or maintenance history supplied; this is not a diagnosis."
}
```

The adapter validates shape and size, not factual correctness. The agent should
use its configured model to generate observations, plausible explanations and
limitations. It must not treat telemetry as instructions or operate machinery.

## Webview consumption

The existing **authenticated** `GET /api/v1/twins/:id/realtime/latest` response now
includes an optional `analysis` object with `kind: ai-generated`, `summary`,
`limitations`, configured `model`, `generatedAt`, `sourceReceivedAt`, `sampleCount`
and `stale`. It is `null` until an analysis succeeds. Existing telemetry fields and
timestamps are unchanged. Existing tenant/management access checks still apply.

This initial version exposes data for a webview to render; it does not add a DT/TS
UI panel. Render analysis as escaped plain text, label it AI-generated, show its
age and limitations, and never replace operational alarm thresholds with it.
Poll the private latest endpoint: public/shared endpoints and SSE do not include
analysis in this MVP. No additional public visibility is granted.

## Operational limits

- At most 100 explicit Twin scopes, 32 fields, 20 samples per Twin over 5 minutes.
- At most 2 concurrent requests; overload is skipped, never queued indefinitely.
- One attempt per Twin per interval, including failures; no automatic retries.
- Timeout up to 30 seconds; response capped at 16 KiB.
- Encrypted payloads are skipped and cached analysis for that Twin is cleared.
  There is no automatic decryption or transfer of encryption passwords.
- In-memory results only; restart clears them. Results older than 5 minutes from
  their source sample are marked stale. Provider failure leaves telemetry intact.
- No provider bodies, prompts, tokens or samples are logged by this connector.

Provider usage, cost controls and retention remain the operator's responsibility.
The connector performs no provider calls until enabled with valid configuration
and an eligible sample arrives. It is an advisory prototype, not a safety system,
autonomous controller or a notarized statement about physical reality.
