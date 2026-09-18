const statusNames = {
  operational: "Operational",
  degraded: "Degraded",
  unavailable: "Unavailable",
  disabled: "Not enabled",
};

const metricDefinitions = [
  ["requests", "API requests"],
  ["averageResponseMs", "Average response", "ms"],
  ["serverErrors", "Server errors"],
  ["queueDepth", "Queued jobs"],
  ["queueFailures", "Queue failures"],
  ["connectorErrors", "Connector errors"],
  ["objectIdTransactions", "ObjectID transactions"],
  ["datasetSamples", "Dataset samples"],
  ["datasetsCreated", "Datasets created"],
  ["policyDenials", "Policy denials"],
  ["digitalThreadFailures", "Thread verification failures"],
  ["idempotencyHits", "Idempotency hits"],
];

const byId = (id) => document.getElementById(id);
let pageNetwork=null, currentServices=[], moduleState=[], moduleError="", moduleBusy=false, sessionGeneration=0;
let loginState=window.dtisSessionState || {authenticated:false};
const moduleForService={"connector-rest":"rest","connector-ai":"ai","connector-mqtt":"commands"};
function mayControl(){return loginState.authenticated && loginState.network===pageNetwork;}
async function loadModules(){
  const generation=++sessionGeneration;
  if(!mayControl()){moduleState=[];moduleError="";return;}
  try{
    const response=await fetch("api/modules/",{credentials:"same-origin",cache:"no-store"});
    const data=await response.json();
    if(!response.ok)throw Error(data.error?.message || "Module controls unavailable");
    if(generation===sessionGeneration && mayControl()){moduleState=data.modules;moduleError="";}
  }catch(error){if(generation===sessionGeneration){moduleState=[];moduleError=error.message;}}
}
window.addEventListener("dtis-native-session",async event=>{
  loginState=event.detail;moduleState=[];moduleError="";++sessionGeneration;
  renderServices(currentServices);
  await loadModules();renderServices(currentServices);
});

function appendModuleControls(card,service){
  const id=moduleForService[service.id];
  if(!id || !mayControl())return;
  const area=document.createElement("div");area.className="module-controls";
  const label=id==="commands"?"Device commands for your tenant":"Your tenant";
  area.append(textElement("p","service-meta",label));
  const state=moduleState.find(m=>m.id===id);
  const message=textElement("p","module-state",moduleError || (!state?"Loading controls…":!state.available?"Not configured for your tenant":state.enabled?"Enabled":"Paused"));
  message.setAttribute("role","status");area.append(message);
  if(state){
    const button=textElement("button","",state.enabled?"PAUSE":"ENABLE");
    button.type="button";button.disabled=!state.available || moduleBusy;
    button.setAttribute("aria-label",`${state.enabled?"Pause":"Enable"} ${id} for your tenant`);
    button.onclick=async()=>{
      if(!mayControl() || moduleBusy || !confirm(`${state.enabled?"Pause":"Enable"} ${id} for your tenant only?`))return;
      const generation=sessionGeneration;
      moduleBusy=true;renderServices(currentServices);
      try{
        const response=await fetch("api/modules/"+id,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:!state.enabled})});
        const data=await response.json();
        if(!response.ok)throw Error(data.error?.message || "Unable to update module");
        if(generation===sessionGeneration && mayControl()){moduleState=data.modules;moduleError="";}
      }catch(error){if(generation===sessionGeneration)moduleError=error.message;}
      finally{moduleBusy=false;renderServices(currentServices);}
    };
    area.append(button);
  }
  card.append(area);
}

function textElement(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function renderServices(services) {
  const container = byId("services");
  container.replaceChildren();
  for (const service of services) {
    const card = document.createElement("article");
    card.className = `service-card ${service.status}`;
    const heading = document.createElement("div");
    heading.className = "service-heading";
    heading.append(textElement("h3", "", service.label));
    const badge = textElement("span", `badge ${service.status}`, statusNames[service.status] || service.status);
    heading.append(badge);
    card.append(heading, textElement("p", "service-detail", service.detail || "Health check"));
    const meta = service.required ? "REQUIRED" : "OPTIONAL";
    card.append(textElement("p", "service-meta", meta));
    appendModuleControls(card,service);
    container.append(card);
  }
  const active = services.filter((item) => item.status !== "disabled");
  const healthy = active.filter((item) => item.status === "operational").length;
  byId("service-summary").textContent = `${healthy} of ${active.length} active services operational`;
}

function renderMetrics(metrics) {
  const container = byId("metrics");
  container.replaceChildren();
  for (const [key, label, suffix = ""] of metricDefinitions) {
    const card = document.createElement("article");
    card.className = "metric-card";
    const value = metrics[key];
    const formatted = value === null || value === undefined ? "—" : Number(value).toLocaleString();
    card.append(textElement("p", "metric-value", `${formatted}${suffix}`), textElement("p", "metric-label", label));
    container.append(card);
  }
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function refresh() {
  const button = byId("refresh");
  button.disabled = true;
  button.textContent = "CHECKING";
  try {
    const response = await fetch("status.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    pageNetwork=data.network;
    currentServices=Array.isArray(data.services)?data.services:[];
    if(!moduleBusy)await loadModules();
    const overall = String(data.overall || "unavailable");
    byId("overall").textContent = statusNames[overall]?.toUpperCase() || overall.toUpperCase();
    byId("overall-dot").className = `status-dot ${overall}`;
    byId("network").textContent = String(data.network || "—").toUpperCase();
    byId("api-version").textContent = String(data.apiVersion || "—").toUpperCase();
    byId("uptime").textContent = formatUptime(Number(data.uptimeSeconds || 0));
    byId("last-check").textContent = new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const networkLink = byId("network-link");
    networkLink.textContent = data.network === "mainnet" ? "TESTNET" : "MAINNET";
    networkLink.href = data.network === "mainnet" ? "/" : "/mainnet/";
    renderServices(currentServices);
    renderMetrics(data.metrics || {});
  } catch (error) {
    byId("overall").textContent = "UNREACHABLE";
    byId("overall-dot").className = "status-dot unavailable";
    byId("service-summary").textContent = "Status endpoint could not be reached";
  } finally {
    button.disabled = false;
    button.textContent = "REFRESH";
  }
}

byId("refresh").addEventListener("click", refresh);
refresh();
setInterval(refresh, 30_000);
