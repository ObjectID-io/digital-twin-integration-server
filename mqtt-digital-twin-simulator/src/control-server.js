import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { SCENARIOS } from "./telemetry.js";

export function createControlServer({ status, control, port, publishNow, recordTransition = async () => undefined, getStatus, controlTwin, adminPassword = "", installIntegrationConfig, removeIntegrationConfig }) {
  const currentStatus = () => getStatus ? getStatus() : publicStatus(status, control);
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    if (request.url === "/health") { const value = currentStatus(); return json(response, value.connected ? 200 : 503, value); }
    if (request.method === "GET" && request.url === "/api/status") return json(response, 200, currentStatus());
    if (request.method === "POST" && request.url === "/api/integration") {
      let value;
      try { value = await readJson(request, 65_536); }
      catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
      const administrator = Boolean(adminPassword) && authorized(request, adminPassword);
      const selfProvisioning = isHostedDeviceProvisioning(value);
      if (!administrator && !selfProvisioning) {
        response.setHeader("www-authenticate", "SimulatorAdmin");
        return json(response, 401, { error: "Use a valid ObjectID Twin device file or provide the simulator administration password" });
      }
      if (!installIntegrationConfig) return json(response, 503, { error: "Credential installation is unavailable" });
      try {
        const installed = await installIntegrationConfig(value, { verifyCredential: selfProvisioning && !administrator });
        return json(response, 201, { installed: true, restarting: false, ...installed });
      } catch (error) {
        return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (request.method === "DELETE" && request.url === "/api/integration") {
      if (!adminPassword || !authorized(request, adminPassword)) return json(response, 401, { error: "Invalid simulator administration password" });
      if (!removeIntegrationConfig) return json(response, 503, { error: "Twin configuration removal is unavailable" });
      try { return json(response, 200, { removed: true, ...await removeIntegrationConfig((await readJson(request)).twinId) }); }
      catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (request.method === "POST" && request.url === "/api/control") {
      try {
        const command = await readJson(request);
        if (controlTwin) return json(response, 200, await controlTwin(command));
        const result = applyCommand(command, control);
        await publishNow();
        if (result.scenarioChanged) await recordTransition({ from: result.previousScenario, to: control.scenario });
        return json(response, 200, publicStatus(status, control));
      } catch (error) {
        return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (request.method === "GET" && (request.url === "/" || request.url === "/index.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return response.end(PAGE);
    }
    return json(response, 404, { error: "Not found" });
  });
  server.listen(port, "0.0.0.0");
  return server;
}

export function applyCommand(command, control) {
  const previousScenario = control.scenario;
  if (command?.action === "pause") control.paused = true;
  else if (command?.action === "resume") control.paused = false;
  else if (command?.action === "reset") { control.paused = false; control.scenario = "normal"; }
  else if (command?.action === "scenario" && SCENARIOS.includes(command.scenario)) control.scenario = command.scenario;
  else if (command?.action !== "publish") throw new Error("Unsupported simulator command");
  control.changedAt = new Date().toISOString();
  return { previousScenario, scenarioChanged: previousScenario !== control.scenario };
}

export function isHostedDeviceProvisioning(value) {
  if (value?.specVersion !== "objectid.device-provisioning.v1") return false;
  const twinId = String(value?.twin?.id ?? "").toLowerCase();
  const network = String(value?.objectid?.network ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(twinId) || !["testnet", "mainnet"].includes(network)) return false;
  if (!String(value?.mqtt?.username ?? "") || !String(value?.mqtt?.password ?? "")) return false;
  let endpoint;
  try { endpoint = new URL(String(value?.mqtt?.endpoint ?? "")); }
  catch { return false; }
  const expectedPath = network === "mainnet" ? "/mqtt-mainnet" : "/mqtt";
  if (endpoint.protocol !== "wss:" || endpoint.hostname !== "dtis.objectid.io" || endpoint.port || endpoint.pathname !== expectedPath || endpoint.search || endpoint.hash) return false;
  const topics = value?.mqtt?.topics;
  if (!topics || Array.isArray(topics)) return false;
  return ["state", "dataset", "commandRequests", "commandResults"].every((name) => String(topics[name] ?? "").toLowerCase().includes(`/${twinId}/`));
}

function publicStatus(status, control) {
  return { ...status, scenario: control.scenario, paused: control.paused, changedAt: control.changedAt };
}

async function readJson(request, maximumBytes = 4096) {
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new Error("Content-Type must be application/json");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maximumBytes) throw new Error("Request body is too large");
  }
  return JSON.parse(body || "{}");
}

function authorized(request, expected) {
  const actual = String(request.headers["x-simulator-admin-password"] ?? "");
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function setSecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ObjectID Twin Simulator</title><style>
:root{--bg:#04110e;--panel:#091c17;--line:#245245;--acid:#c6ff3d;--mint:#70f0bd;--text:#e8f5ef;--muted:#78998d;--alarm:#ff715f}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#12382d 0,transparent 35%),linear-gradient(135deg,#020806,var(--bg));color:var(--text);font-family:Arial,sans-serif;min-height:100vh}main{max-width:1240px;margin:auto;padding:42px 24px 70px}header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid var(--line);padding-bottom:24px}small,.mono{font-family:monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1{font-size:clamp(34px,6vw,72px);line-height:.95;margin:12px 0}.live{color:var(--mint)}.live:before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor;margin-right:10px;box-shadow:0 0 14px currentColor}.twin-picker{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:16px;border:1px solid var(--line);background:#06130f;padding:18px;margin-top:30px}.twin-picker select{min-width:0;background:#020806;border:1px solid var(--line);color:var(--text);padding:13px;font:14px monospace}.twin-picker button{padding:13px 18px;border:1px solid var(--alarm);background:transparent;color:var(--alarm);cursor:pointer}.status{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);margin:16px 0 30px}.status div{padding:20px;border-right:1px solid var(--line)}.status div:last-child{border:0}.status strong{display:block;margin-top:8px;font:16px monospace}.controls{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.scenario{min-height:145px;padding:22px;text-align:left;color:var(--text);background:linear-gradient(145deg,#0b211b,#06130f);border:1px solid var(--line);cursor:pointer;transition:.2s}.scenario:hover,.scenario.active{border-color:var(--acid);transform:translateY(-2px);box-shadow:inset 3px 0 var(--acid)}.scenario strong{display:block;font-size:19px;margin:18px 0 7px}.scenario span{color:var(--muted)}.scenario.alarm strong{color:#ffb0a7}.actions{display:flex;gap:12px;margin-top:20px}.actions button,.credential-form button{padding:14px 22px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}.actions button:hover,.credential-form button:hover{border-color:var(--acid)}#message{margin-left:auto;align-self:center;color:var(--mint);font:12px monospace}.credentials{margin-top:42px;border:1px solid var(--line);background:#06130f;padding:24px}.credentials h2{margin:8px 0}.credentials p{color:var(--muted);line-height:1.5}.credential-form{display:grid;grid-template-columns:1fr auto;gap:12px;margin-top:18px}.credential-form input{width:100%;background:#020806;border:1px solid var(--line);color:var(--text);padding:13px}.credential-form button{border-color:var(--acid);color:var(--acid)}#credential-message{display:block;margin-top:12px;color:var(--mint);font:12px monospace}@media(max-width:760px){header{display:block}.twin-picker,.status,.controls,.credential-form{grid-template-columns:1fr}.status div{border-right:0;border-bottom:1px solid var(--line)}.actions{flex-wrap:wrap}#message{width:100%}}
</style></head><body><main><header><div><small>ObjectID / Digital Twin</small><h1>Digital Twin<br>simulator fleet</h1></div><div class="live" id="connection">CONNECTING</div></header><section class="twin-picker"><small>Simulated Twin</small><select id="twin-select"></select><button id="remove-twin" type="button">REMOVE</button></section><section class="status"><div><small>Scenario</small><strong id="scenario">--</strong></div><div><small>Generator</small><strong id="generator">--</strong></div><div><small>Samples</small><strong id="published">0</strong></div><div><small>Last publish</small><strong id="last">--</strong></div></section><small>FAULT INJECTION / SELECT A MACHINE CONDITION</small><section class="controls" id="controls"><button class="scenario" data-scenario="normal"><small>00 / nominal</small><strong>Normal operation</strong><span>Restore standard CNC telemetry.</span></button><button class="scenario alarm" data-scenario="overheat"><small>01 / thermal</small><strong>Spindle overheat</strong><span>Temperature rises above 95 C.</span></button><button class="scenario alarm" data-scenario="high-vibration"><small>02 / mechanical</small><strong>High vibration</strong><span>Vibration exceeds 8 mm/s.</span></button><button class="scenario alarm" data-scenario="spindle-overload"><small>03 / load</small><strong>Spindle overload</strong><span>High RPM and active power.</span></button><button class="scenario alarm" data-scenario="pressure-loss"><small>04 / pneumatic</small><strong>Pressure loss</strong><span>Pressure falls close to 2 bar.</span></button><button class="scenario alarm" data-scenario="emergency-stop"><small>05 / safety</small><strong>Emergency stop</strong><span>RPM and active power fall to zero.</span></button></section><div class="actions"><button data-action="pause">PAUSE STREAM</button><button data-action="resume">RESUME STREAM</button><button data-action="publish">PUBLISH NOW</button><button data-action="reset">RESET ALL</button><span id="message"></span></div><section class="credentials"><small>TWIN SELF-PROVISIONING</small><h2>Add simulated Twins</h2><p>Select one or more <code>objectid.device-provisioning.v1</code> files downloaded after Twin creation. The MQTT secret in each file authenticates that Twin; no simulator administration password is required.</p><form class="credential-form" id="credential-form"><input type="file" id="credential-file" accept="application/json,.json" multiple required><button type="submit">ADD TWIN FILES</button></form><span id="credential-message"></span></section></main><script>
const ids={connection:document.querySelector('#connection'),scenario:document.querySelector('#scenario'),generator:document.querySelector('#generator'),published:document.querySelector('#published'),last:document.querySelector('#last'),message:document.querySelector('#message'),select:document.querySelector('#twin-select')};let fleet={twins:[]};function selected(){return ids.select.value}function render(){const prior=selected();ids.select.replaceChildren(...fleet.twins.map(t=>{const option=document.createElement('option');option.value=t.twinId;option.textContent=t.machineName+' · '+t.network+' · '+t.twinId.slice(0,10)+'…';return option}));if(fleet.twins.some(t=>t.twinId===prior))ids.select.value=prior;const s=fleet.twins.find(t=>t.twinId===selected());ids.connection.textContent=fleet.allConnected?'ALL MQTT CONNECTED':fleet.connected?'PARTIALLY CONNECTED':'MQTT OFFLINE';ids.scenario.textContent=s?.scenario||'--';ids.generator.textContent=s?(s.paused?'PAUSED':'RUNNING'):'--';ids.published.textContent=s?.published||0;ids.last.textContent=s?.lastPublishedAt?new Date(s.lastPublishedAt).toLocaleTimeString():'--';document.querySelectorAll('[data-scenario]').forEach(b=>b.classList.toggle('active',b.dataset.scenario===s?.scenario))}async function refresh(){const r=await fetch('/api/status');fleet=await r.json();render()}async function command(body){if(!selected())return;ids.message.textContent='APPLYING...';const r=await fetch('/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,twinId:selected()})});const s=await r.json();ids.message.textContent=r.ok?'COMMAND APPLIED':s.error||'FAILED';await refresh()}ids.select.onchange=render;document.querySelectorAll('[data-scenario]').forEach(b=>b.onclick=()=>command({action:'scenario',scenario:b.dataset.scenario}));document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>command({action:b.dataset.action}));document.querySelector('#credential-form').onsubmit=async event=>{event.preventDefault();const output=document.querySelector('#credential-message');const files=[...document.querySelector('#credential-file').files];let installed=0;try{for(const file of files){output.textContent='VERIFYING '+file.name+'...';const value=JSON.parse(await file.text());const response=await fetch('/api/integration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});const result=await response.json();if(!response.ok)throw new Error(file.name+': '+(result.error||'INSTALLATION FAILED'));installed+=result.installed||1}document.querySelector('#credential-file').value='';output.textContent=installed+' SIMULATED TWIN(S) ADDED';await refresh()}catch(error){output.textContent=error.message}};document.querySelector('#remove-twin').onclick=async()=>{const twinId=selected();if(!twinId)return;const password=prompt('Simulator administration password');if(!password)return;if(!confirm('Remove this simulated Twin configuration? The on-chain Twin is not deleted.'))return;const response=await fetch('/api/integration',{method:'DELETE',headers:{'content-type':'application/json','x-simulator-admin-password':password},body:JSON.stringify({twinId})});const result=await response.json();ids.message.textContent=response.ok?'SIMULATOR REMOVED':result.error||'FAILED';await refresh()};refresh();setInterval(refresh,3000);
</script></body></html>`;
