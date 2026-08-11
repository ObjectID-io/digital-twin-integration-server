import { createServer } from "node:http";
import { SCENARIOS } from "./telemetry.js";

export function createControlServer({ status, control, port, publishNow, recordTransition = async () => undefined }) {
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    if (request.url === "/health") return json(response, status.connected ? 200 : 503, publicStatus(status, control));
    if (request.method === "GET" && request.url === "/api/status") return json(response, 200, publicStatus(status, control));
    if (request.method === "POST" && request.url === "/api/control") {
      try {
        const command = await readJson(request);
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

function publicStatus(status, control) {
  return { ...status, scenario: control.scenario, paused: control.paused, changedAt: control.changedAt };
}

async function readJson(request) {
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new Error("Content-Type must be application/json");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error("Request body is too large");
  }
  return JSON.parse(body || "{}");
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
:root{--bg:#04110e;--panel:#091c17;--line:#245245;--acid:#c6ff3d;--mint:#70f0bd;--text:#e8f5ef;--muted:#78998d;--alarm:#ff715f}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#12382d 0,transparent 35%),linear-gradient(135deg,#020806,var(--bg));color:var(--text);font-family:Arial,sans-serif;min-height:100vh}main{max-width:1240px;margin:auto;padding:42px 24px 70px}header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid var(--line);padding-bottom:24px}small,.mono{font-family:monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1{font-size:clamp(34px,6vw,72px);line-height:.95;margin:12px 0}.live{color:var(--mint)}.live:before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor;margin-right:10px;box-shadow:0 0 14px currentColor}.status{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);margin:30px 0}.status div{padding:20px;border-right:1px solid var(--line)}.status div:last-child{border:0}.status strong{display:block;margin-top:8px;font:16px monospace}.controls{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.scenario{min-height:145px;padding:22px;text-align:left;color:var(--text);background:linear-gradient(145deg,#0b211b,#06130f);border:1px solid var(--line);cursor:pointer;transition:.2s}.scenario:hover,.scenario.active{border-color:var(--acid);transform:translateY(-2px);box-shadow:inset 3px 0 var(--acid)}.scenario strong{display:block;font-size:19px;margin:18px 0 7px}.scenario span{color:var(--muted)}.scenario.alarm strong{color:#ffb0a7}.actions{display:flex;gap:12px;margin-top:20px}.actions button{padding:14px 22px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}.actions button:hover{border-color:var(--acid)}#message{margin-left:auto;align-self:center;color:var(--mint);font:12px monospace}@media(max-width:760px){header{display:block}.status,.controls{grid-template-columns:1fr}.status div{border-right:0;border-bottom:1px solid var(--line)}.actions{flex-wrap:wrap}#message{width:100%}}
</style></head><body><main><header><div><small>ObjectID / Digital Twin</small><h1>5-axis CNC<br>simulator</h1></div><div class="live" id="connection">CONNECTING</div></header><section class="status"><div><small>Scenario</small><strong id="scenario">--</strong></div><div><small>Generator</small><strong id="generator">--</strong></div><div><small>Samples</small><strong id="published">0</strong></div><div><small>Last publish</small><strong id="last">--</strong></div></section><small>FAULT INJECTION / SELECT A MACHINE CONDITION</small><section class="controls" id="controls"><button class="scenario" data-scenario="normal"><small>00 / nominal</small><strong>Normal operation</strong><span>Restore standard CNC telemetry.</span></button><button class="scenario alarm" data-scenario="overheat"><small>01 / thermal</small><strong>Spindle overheat</strong><span>Temperature rises above 95 C.</span></button><button class="scenario alarm" data-scenario="high-vibration"><small>02 / mechanical</small><strong>High vibration</strong><span>Vibration exceeds 8 mm/s.</span></button><button class="scenario alarm" data-scenario="spindle-overload"><small>03 / load</small><strong>Spindle overload</strong><span>High RPM and active power.</span></button><button class="scenario alarm" data-scenario="pressure-loss"><small>04 / pneumatic</small><strong>Pressure loss</strong><span>Pressure falls close to 2 bar.</span></button><button class="scenario alarm" data-scenario="emergency-stop"><small>05 / safety</small><strong>Emergency stop</strong><span>RPM and active power fall to zero.</span></button></section><div class="actions"><button data-action="pause">PAUSE STREAM</button><button data-action="resume">RESUME STREAM</button><button data-action="publish">PUBLISH NOW</button><button data-action="reset">RESET ALL</button><span id="message"></span></div></main><script>
const ids={connection:document.querySelector('#connection'),scenario:document.querySelector('#scenario'),generator:document.querySelector('#generator'),published:document.querySelector('#published'),last:document.querySelector('#last'),message:document.querySelector('#message')};async function refresh(){const r=await fetch('/api/status');const s=await r.json();ids.connection.textContent=s.connected?'MQTT CONNECTED':'MQTT OFFLINE';ids.scenario.textContent=s.scenario;ids.generator.textContent=s.paused?'PAUSED':'RUNNING';ids.published.textContent=s.published;ids.last.textContent=s.lastPublishedAt?new Date(s.lastPublishedAt).toLocaleTimeString():'--';document.querySelectorAll('[data-scenario]').forEach(b=>b.classList.toggle('active',b.dataset.scenario===s.scenario))}async function command(body){ids.message.textContent='APPLYING...';const r=await fetch('/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const s=await r.json();ids.message.textContent=r.ok?'COMMAND APPLIED':s.error||'FAILED';await refresh()}document.querySelectorAll('[data-scenario]').forEach(b=>b.onclick=()=>command({action:'scenario',scenario:b.dataset.scenario}));document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>command({action:b.dataset.action}));refresh();setInterval(refresh,3000);
</script></body></html>`;
