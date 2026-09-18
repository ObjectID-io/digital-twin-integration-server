const responses = {"200":{description:"Authorized result; never cache credentials or samples"},"401":{description:"DID workbench session required or expired"},"403":{description:"Owner/scope mismatch, revoked device or decryption denied"},"409":{description:"Waiting for samples, conflicting operation or creation needs reconciliation"}};
const body = {required:true,content:{"application/json":{schema:{type:"object"}}}};
const id = [{name:"id",in:"path",required:true,schema:{type:"string",pattern:"^device-[a-f0-9-]{36}$"}}];
const operation = (summary:string) => ({summary,security:[{Bearer:[]}],responses});
export const devicePaths = {
  "/api/tenant-access/":{get:{summary:"Inspect your tenant application credential status (native DID cookie; no secrets)",description:"Uses the network-specific __Secure-oid_dtis_<network> session cookie. No owner or tenant selector is accepted.",responses}},
  "/api/tenant-access/{action}":{post:{summary:"Rotate or revoke your tenant application credentials",description:"Native DID cookie and exact configured Origin required. Body confirm must be true. Rotation checks the existing on-chain subscription; no purchase, activation or renewal is performed. Rotation returns a secret objectid.tenant-access.v1 JSON once. Revocation here preserves separate device credentials.",parameters:[{name:"action",in:"path",required:true,schema:{type:"string",enum:["rotate","revoke"]}}],requestBody:{required:true,content:{"application/json":{schema:{type:"object",required:["confirm"],properties:{confirm:{type:"boolean",enum:[true]}}}}}},responses:{...responses,"402":{description:"Active subscription required for rotation; manage it in DT"},"422":{description:"Explicit confirmation required"}}}},
  "/api/device-auth/session":{get:{summary:"Get native DID session and linked-subscription status, or public login availability",responses}},
  "/api/device-auth/challenge":{post:{summary:"Start native DID login; same-origin browser only, five-minute one-time challenge",requestBody:body,responses}},
  "/api/device-auth/verify":{post:{summary:"Verify local personal-message signature and on-chain ControllerCap; issue 30-minute Secure HttpOnly SameSite=Strict cookie",requestBody:body,responses}},
  "/api/device-auth/logout":{post:{summary:"Revoke native DID cookie session; same-origin only",responses:{"204":{description:"Logged out"}}}},
  "/api/v1/device-workbench/session":{post:{summary:"Create a five-minute workbench session from owner tenant authentication; no global admin key",security:[{ApiKey:[]}],responses}},
  "/api/plants/device-workbench/session":{post:{summary:"Create a scoped delegated workbench session after TwinScope AAA",security:[{TwinScopeCreation:[]}],parameters:[{name:"Idempotency-Key",in:"header",required:true,schema:{type:"string"}}],requestBody:body,responses}},
  "/api/device-workbench/devices":{
    get:operation("List accessible devices; credentials never returned"),
    post:{...operation("Register device before a Twin exists; return one-time device credentials and optional encryption configuration"),requestBody:body,responses:{...responses,"201":{description:"objectid.device-onboarding.v1, contains device secrets"}}}},
  "/api/device-workbench/devices/{id}/inspect":{post:{...operation("Decrypt latest sample with supplied password and discover scalar signal paths"),parameters:id,requestBody:body}},
  "/api/device-workbench/devices/{id}/classify":{post:{...operation("Validate signals and owner subscription, create private Twin once, persist classified schema"),parameters:id,requestBody:body}},
  "/api/device-workbench/devices/{id}/export":{get:{...operation("Export objectid.twin-catalog.v1 references and schema without credentials"),parameters:id}},
  "/api/device-workbench/devices/{id}/revoke":{post:{...operation("Revoke device HTTP and MQTT ingestion; does not delete the Twin"),parameters:id}},
  "/api/device-workbench/catalog":{get:operation("List classified Twins in the authenticated device scope")},
  "/device-input/{tenantId}/{deviceId}":{post:{summary:"Publish device sample over HTTPS with device-scoped opaque bearer credential",security:[{Bearer:[]}],parameters:[{name:"tenantId",in:"path",required:true,schema:{type:"string"}},{name:"deviceId",in:"path",required:true,schema:{type:"string"}}],requestBody:body,responses:{...responses,"202":{description:"Sample accepted; at most one sample per device per second"}}}},
};
