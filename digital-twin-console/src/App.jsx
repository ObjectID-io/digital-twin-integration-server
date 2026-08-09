import { useEffect, useState } from "react";
import { fieldsOf, LIFECYCLE, qualityScore, runQualityChecks, textOf } from "./quality.js";

const STANDARD_ROWS = [
  { ref: "ISO/IEC 30188:2026", area: "Reference architecture", evidence: "Root OIDTwin autonomo, viste identità, lifecycle, dati, modelli, interfacce e governance", status: "Aligned", url: "https://www.iso.org/standard/53308.html" },
  { ref: "ISO 23247-1:2021", area: "Principi generali", evidence: "Rappresentazione fit-for-purpose, sincronizzazione e lifecycle esplicito", status: "Covered", url: "https://www.iso.org/standard/75066.html" },
  { ref: "ISO 23247-2:2021", area: "Reference architecture", evidence: "Separazione asset, comunicazione, Digital Twin, servizi e utenti", status: "Covered", url: "https://www.iso.org/standard/78743.html" },
  { ref: "ISO 23247-3:2021", area: "Digital representation", evidence: "Aspect, State, Dataset, ModelRef, Relation e Composition", status: "Covered", url: "https://www.iso.org/standard/78744.html" },
  { ref: "ISO 23247-4:2021", area: "Information exchange", evidence: "MQTT, URI di origine, schema, hash, rete e interfacce tipizzate", status: "Covered", url: "https://www.iso.org/standard/78745.html" },
  { ref: "ISO 23247-5:2026", area: "Digital thread", evidence: "OIDTwinEvent ordinati per revisione, verifica e report hash canonico", status: "Covered", url: "https://www.iso.org/standard/87425.html" }
];

export function App() {
  const [dashboard, setDashboard] = useState(null);
  const [telemetry, setTelemetry] = useState({ connected: false, latest: null, samples: [], received: 0 });
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/dashboard", { cache: "no-store" });
        if (!response.ok) throw new Error(`Dashboard API ${response.status}`);
        const value = await response.json();
        if (active) {
          setDashboard(value);
          setTelemetry(value.telemetry ?? telemetry);
          setError("");
        }
      } catch (cause) { if (active) setError(cause.message); }
      finally { if (active) setLoading(false); }
    }
    void load();
    const poll = setInterval(load, 30_000);
    const stream = new EventSource("/api/live");
    stream.addEventListener("snapshot", (event) => active && setTelemetry(JSON.parse(event.data)));
    stream.addEventListener("telemetry", (event) => {
      if (!active) return;
      const { sample, received } = JSON.parse(event.data);
      setTelemetry((current) => ({ ...current, connected: true, latest: sample, received, samples: [...(current.samples ?? []), sample].slice(-60) }));
    });
    return () => { active = false; clearInterval(poll); stream.close(); };
  }, []);

  const twinResult = dashboard?.twin;
  const twin = twinResult?.ok ? twinResult.data : null;
  const fields = fieldsOf(twin);
  const latest = telemetry.latest;
  const verification = dashboard?.verification?.ok ? dashboard.verification.data : null;
  const readiness = dashboard?.readiness?.ok ? dashboard.readiness.data : null;
  const twinId = dashboard?.meta?.twinId ?? "";
  const checks = runQualityChecks({ twin, telemetry: latest, verification, readiness, expectedTwinId: twinId });
  const score = qualityScore(checks);
  const lifecycle = LIFECYCLE[Number(fields.lifecycle_state)] ?? "Operation";

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="ObjectID Digital Twin Console">
          <span className="official-brand">
            <img src="/objectid-logo-white.png" alt="ObjectID" />
            <small>Digital Twin</small>
          </span>
        </a>
        <div className="system-line">
          <StatusDot ok={readiness?.ready} label={readiness?.ready ? "SYSTEM NOMINAL" : "SYSTEM CHECK"} />
          <span className="network">IOTA / {dashboard?.meta?.network?.toUpperCase() ?? "TESTNET"}</span>
          <LiveClock />
        </div>
      </header>

      <nav className="tabs" aria-label="Sezioni console">
        {[['overview','Operational view'],['assurance','Quality assurance'],['thread','Digital thread'],['standards','Standards map']].map(([id,label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><span>{label}</span></button>
        ))}
      </nav>

      {error && <div className="alert"><b>UPSTREAM DEGRADED</b><span>{error}</span></div>}
      {loading && <Loading />}

      {!loading && tab === "overview" && (
        <section className="view overview-view">
          <div className="hero-panel panel">
            <div className="panel-label">LIVE ASSET / 01</div>
            <TwinVisual connected={telemetry.connected} />
            <div className="hero-copy">
              <span className="eyebrow">PHYSICAL ASSET MIRROR</span>
              <h1>{textOf(fields.name) || latest?.machineName || "MQTT VPS Twin"}</h1>
              <p>{textOf(fields.description) || "Digital twin operativo con telemetria MQTT, evidenze off-chain e trust anchor IOTA."}</p>
              <div className="identity-strip">
                <span>OID</span><code title={twinId}>{shortId(twinId)}</code><Copy value={twinId} />
              </div>
            </div>
            <div className="hero-state">
              <span className="state-index">L{String(fields.lifecycle_state ?? 6).padStart(2,'0')}</span>
              <small>LIFECYCLE</small>
              <strong>{lifecycle.toUpperCase()}</strong>
            </div>
          </div>

          <section className="telemetry-section">
            <SectionTitle index="01" title="Live telemetry" note={`${telemetry.received} campioni ricevuti`} />
            <div className="metric-rail">
              <Metric name="Temperature" metric={latest?.measurements?.temperature} accent="hot" />
              <Metric name="Vibration" metric={latest?.measurements?.vibration} accent="signal" />
              <Metric name="Rotational speed" metric={latest?.measurements?.rotationalSpeed} />
              <Metric name="Active power" metric={latest?.measurements?.activePower} />
              <Metric name="Pressure" metric={latest?.measurements?.pressure} />
            </div>
            <TelemetryChart samples={telemetry.samples ?? []} />
          </section>

          <section className="detail-grid">
            <div className="panel details-panel">
              <SectionTitle index="02" title="Twin identity" note="ON-CHAIN ROOT" compact />
              <Detail label="Twin type" value={textOf(fields.twin_type) || "machine"} />
              <Detail label="Namespace" value={textOf(fields.namespace) || "objectid-vps"} />
              <Detail label="Target kind" value={textOf(fields.target_kind) || "physical-asset"} />
              <Detail label="Twin DID" value={textOf(fields.twin_did) || textOf(fields.target_did)} mono />
              <Detail label="Revision" value={textOf(fields.revision) || "1"} />
            </div>
            <div className="panel trust-panel">
              <SectionTitle index="03" title="Trust anchor" note="IOTA TESTNET" compact />
              <Detail label="Package" value={shortId(dashboard?.meta?.packageId)} title={dashboard?.meta?.packageId} mono />
              <Detail label="Network" value={dashboard?.meta?.network || "testnet"} />
              <Detail label="Storage" value={readiness?.storage?.backblaze?.healthy === false ? "Degraded" : "Backblaze B2 / healthy"} />
              <Detail label="MQTT stream" value={telemetry.connected ? "Connected / QoS 1" : "Reconnecting"} />
              <a className="external-link" href={`https://explorer.iota.org/object/${twinId}?network=testnet`} target="_blank" rel="noreferrer">VIEW ON IOTA EXPLORER <span>↗</span></a>
            </div>
          </section>
        </section>
      )}

      {!loading && tab === "assurance" && <Assurance checks={checks} score={score} verification={verification} readiness={readiness} />}
      {!loading && tab === "thread" && <Thread dashboard={dashboard} />}
      {!loading && tab === "standards" && <Standards />}

      <footer>
        <span>OBJECTID DIGITAL TWIN / V1</span>
        <p>Technical self-assessment. This interface does not constitute ISO certification.</p>
        <span>{dashboard?.generatedAt ? new Date(dashboard.generatedAt).toLocaleString('it-IT') : "SYNCING"}</span>
      </footer>
    </main>
  );
}

function Assurance({ checks, score, verification, readiness }) {
  const groups = ["Congruità", "Coerenza"];
  return <section className="view assurance-view">
    <div className="assurance-head panel">
      <div><span className="eyebrow">EVIDENCE-BASED CONTROL</span><h2>Congruità & coerenza</h2><p>Ogni risultato deriva da dati live, stato on-chain o evidenze del Digital Thread.</p></div>
      <div className="score-ring" style={{'--score': `${score * 3.6}deg`}}><strong>{score}</strong><span>/100</span></div>
      <div className="score-meta"><StatusDot ok={score >= 80} label={score >= 80 ? "ASSURANCE NOMINAL" : "REVIEW REQUIRED"} /><small>{checks.filter(c=>c.status==='pass').length} PASS · {checks.filter(c=>c.status==='warn').length} WARN · {checks.filter(c=>c.status==='fail').length} FAIL</small></div>
    </div>
    <div className="check-columns">
      {groups.map(group => <div className="check-group" key={group}><SectionTitle index={group === 'Congruità' ? 'A' : 'B'} title={group} note={group === 'Congruità' ? 'FORMA & SIGNIFICATO' : 'RELAZIONI & CONTINUITÀ'} compact />
        {checks.filter(c=>c.group===group).map(item => <div className={`check-row ${item.status}`} key={item.id}><span className="check-code">{item.id}</span><div><strong>{item.label}</strong><small>{item.evidence}</small></div><b>{item.status.toUpperCase()}</b></div>)}
      </div>)}
    </div>
    <div className="evidence-band panel"><div><small>DIGITAL THREAD</small><strong>{verification?.valid ? 'Cryptographically coherent' : 'Evidence pending'}</strong></div><div><small>REQUIRED SERVICES</small><strong>{readiness?.ready ? 'All operational' : 'Review required'}</strong></div><div><small>METHOD</small><strong>Deterministic / explainable</strong></div></div>
  </section>;
}

function Thread({ dashboard }) {
  const thread = dashboard?.thread?.ok ? dashboard.thread.data : null;
  const items = Array.isArray(thread) ? thread : thread?.items ?? [];
  const verification = dashboard?.verification?.ok ? dashboard.verification.data : null;
  const report = dashboard?.report?.ok ? dashboard.report.data : null;
  return <section className="view thread-view">
    <div className="thread-head"><div><span className="eyebrow">ISO 23247-5:2026</span><h2>Digital thread</h2><p>Sequenza revisionale nativa degli eventi OIDTwin.</p></div><div className={`verification-seal ${verification?.valid ? 'valid' : ''}`}><span>{verification?.valid ? 'VERIFIED' : 'PENDING'}</span><strong>{verification?.eventCount ?? items.length}</strong><small>EVENTS</small></div></div>
    {items.length ? <div className="timeline">{items.map((event,index)=><article key={event.eventId ?? index}><span className="timeline-node"/><div className="timeline-rev">R{event.revisionAfter ?? index+1}</div><div><strong>Event type {event.eventType ?? '—'}</strong><p>{event.actorDid || 'Actor DID unavailable'}</p><code>{shortId(event.eventId)}</code></div><time>{formatChainTime(event.createdAt)}</time></article>)}</div> : <Empty title="Digital Thread non indicizzato" text={dashboard?.thread?.error || "Il Twin esiste; gli eventi saranno mostrati quando l'indexer espone la sequenza."} />}
    <div className="report-panel panel"><SectionTitle index="HASH" title="Audit evidence" note="RFC 8785 / SHA-256" compact/><Detail label="Verifier" value={report?.verifierVersion || 'ObjectID incremental verifier'} /><Detail label="Evidence digest" value={report?.eventEvidenceDigest || report?.evidenceHash?.digest || 'Pending'} mono/><Detail label="Report hash" value={report?.reportHash || 'Pending'} mono/></div>
  </section>;
}

function Standards() {
  return <section className="view standards-view">
    <div className="standards-intro"><span className="eyebrow">ARCHITECTURE ASSURANCE</span><h2>Standards alignment map</h2><p>Tracciabilità tecnica tra capacità ObjectID e riferimenti normativi applicabili. Le valutazioni sono architetturali e non sostituiscono un audit di certificazione.</p><div className="publication-note"><b>30188 / EDITORIAL STATUS</b><span>Edizione 2026 · Reference architecture · pagina ISO in fase di pubblicazione</span></div></div>
    <div className="standards-table">{STANDARD_ROWS.map((row,index)=><a href={row.url} target="_blank" rel="noreferrer" key={row.ref}><span className="std-index">0{index+1}</span><div><strong>{row.ref}</strong><small>{row.area}</small></div><p>{row.evidence}</p><b>{row.status}</b><i>↗</i></a>)}</div>
    <div className="architecture-views panel"><SectionTitle index="RA" title="Implemented architecture views" note="OBJECTID INTERPRETATION" compact/><div className="view-map"><span>Physical entity<small>machine / source</small></span><i>MQTT</i><span>Digital twin<small>OIDTwin / aspects</small></span><i>API</i><span>Services<small>storage / assurance</small></span><i>DID</i><span>Users & roles<small>owner / steward</small></span></div></div>
  </section>;
}

function TwinVisual({ connected }) { return <div className="twin-visual" aria-label="Rappresentazione del macchinario digitale"><div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="scan-line"/><svg viewBox="0 0 260 260" role="img"><defs><linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#d8ffdf" stopOpacity=".8"/><stop offset=".45" stopColor="#2aa889" stopOpacity=".35"/><stop offset="1" stopColor="#071b19" stopOpacity=".8"/></linearGradient></defs><path className="machine-shadow" d="M52 211 130 236 214 208 133 187Z"/><path className="machine-body" d="M78 76 132 55l55 24v109l-56 27-53-25Z"/><path className="machine-side" d="m132 55 55 24v109l-56 27V102Z"/><path className="machine-top" d="m78 76 54-21 55 24-56 23Z"/><circle cx="131" cy="145" r="35"/><circle className="rotor" cx="131" cy="145" r="21"/><path d="M131 124v42M110 145h42"/><path className="signal-stroke" d="M195 92h24v-29M195 111h40M64 126H35v36"/><circle className={connected ? 'live-node' : ''} cx="219" cy="63" r="5"/></svg><div className="visual-tag"><span>{connected ? 'LIVE' : 'LINK'}</span><small>DIGITAL REPRESENTATION</small></div></div> }

function TelemetryChart({ samples }) {
  const values = samples.slice(-30).map(s=>Number(s.measurements?.temperature?.value)).filter(Number.isFinite);
  const vibration = samples.slice(-30).map(s=>Number(s.measurements?.vibration?.value)).filter(Number.isFinite);
  return <div className="chart-panel panel"><div className="chart-head"><span>TEMP / VIBRATION TREND</span><small>LAST {Math.max(values.length,vibration.length)} SAMPLES</small></div><svg viewBox="0 0 1000 180" preserveAspectRatio="none"><g className="grid-lines">{[30,75,120,165].map(y=><line key={y} x1="0" y1={y} x2="1000" y2={y}/>)}</g><path className="area" d={areaPath(values,45,85)}/><path className="line-temp" d={linePath(values,45,85)}/><path className="line-vibration" d={linePath(vibration,0,6)}/></svg><div className="chart-legend"><span className="temp">Temperature</span><span className="vibration">Vibration</span><small>MQTT · QoS 1 · 5 sec</small></div></div>;
}

function Metric({ name, metric, accent="" }) { return <div className={`metric ${accent}`}><span>{name}</span><strong>{metric?.value ?? '—'}</strong><small>{metric?.unit ?? 'WAITING'}</small><i/></div> }
function Detail({ label, value, mono=false, title }) { return <div className="detail"><span>{label}</span><strong className={mono?'mono':''} title={title || value}>{value || '—'}</strong></div> }
function SectionTitle({ index, title, note, compact=false }) { return <div className={`section-title ${compact?'compact':''}`}><span>{index}</span><h2>{title}</h2><small>{note}</small></div> }
function StatusDot({ ok, label }) { return <span className={`status-dot ${ok?'ok':''}`}><i/>{label}</span> }
function Copy({ value }) { const [done,setDone]=useState(false); return <button className="copy" onClick={()=>navigator.clipboard.writeText(value).then(()=>{setDone(true);setTimeout(()=>setDone(false),1200)})}>{done?'COPIED':'COPY'}</button> }
function LiveClock() { const [now,setNow]=useState(new Date()); useEffect(()=>{const id=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(id)},[]); return <time>{now.toLocaleTimeString('it-IT')}</time> }
function Empty({title,text}) { return <div className="empty panel"><span>NO DATA</span><h3>{title}</h3><p>{text}</p></div> }
function Loading() { return <div className="loading"><i/><span>Synchronizing digital representation</span></div> }
function shortId(value="") { return value.length > 20 ? `${value.slice(0,10)}…${value.slice(-8)}` : value || '—'; }
function formatChainTime(value) { const number=Number(value); if(!number)return '—'; return new Date(number < 1e12 ? number*1000:number).toLocaleString('it-IT'); }
function linePath(values,min,max) { if(!values.length)return ''; return values.map((v,i)=>`${i?'L':'M'} ${(i/Math.max(1,values.length-1))*1000} ${165-((v-min)/(max-min))*140}`).join(' '); }
function areaPath(values,min,max) { const line=linePath(values,min,max); return line ? `${line} L 1000 180 L 0 180 Z` : ''; }
