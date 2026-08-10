import { useEffect, useRef, useState } from "react";
import { fieldsOf, LIFECYCLE, qualityScore, runQualityChecks, textOf } from "./quality.js";
import { eventLabel, isIotaObjectId, objectExplorerUrl, transactionExplorerUrl } from "./thread-ui.js";

const STANDARD_ROWS = [
  { ref: "ISO/IEC 30188:2026", area: "Reference architecture", evidence: "Autonomous OIDTwin root with identity, lifecycle, data, model, interface and governance views", status: "Aligned", url: "https://www.iso.org/standard/53308.html" },
  { ref: "ISO 23247-1:2021", area: "General principles", evidence: "Fit-for-purpose representation, synchronization and explicit lifecycle", status: "Covered", url: "https://www.iso.org/standard/75066.html" },
  { ref: "ISO 23247-2:2021", area: "Reference architecture", evidence: "Separation of asset, communication, Digital Twin, services and users", status: "Covered", url: "https://www.iso.org/standard/78743.html" },
  { ref: "ISO 23247-3:2021", area: "Digital representation", evidence: "Aspect, State, Dataset, ModelRef, Relation and Composition", status: "Covered", url: "https://www.iso.org/standard/78744.html" },
  { ref: "ISO 23247-4:2021", area: "Information exchange", evidence: "MQTT, source URI, schema, hash, network and typed interfaces", status: "Covered", url: "https://www.iso.org/standard/78745.html" },
  { ref: "ISO 23247-5:2026", area: "Digital thread", evidence: "OIDTwinEvent ordered by revision, verification and canonical hash report", status: "Covered", url: "https://www.iso.org/standard/87425.html" }
];

const QUALITY_DETAILS = {
  "OID-01": { method: "Compare the object ID returned by the IOTA RPC with the configured OIDTwin ID.", expected: "The resolved on-chain object must be the Twin selected by this console.", source: "IOTA object state", standard: "ISO/IEC 30188:2026", scope: "Identity view within the general Digital Twin reference architecture.", url: "https://www.iso.org/standard/53308.html", explorer: true },
  "OID-02": { method: "Decode lifecycle_state and verify that it belongs to the supported 1-10 lifecycle vocabulary.", expected: "A recognized lifecycle state must be explicitly represented.", source: "OIDTwin root fields", standard: "ISO 23247-3:2021", scope: "Digital representation and information attributes of observable manufacturing elements.", url: "https://www.iso.org/standard/78744.html", explorer: true },
  "OID-03": { method: "Read the current OIDTwin revision and require a positive monotonic revision number.", expected: "The Twin must expose a revision suitable for ordering state changes.", source: "OIDTwin root fields", standard: "ISO 23247-5:2026", scope: "Digital Thread continuity and ordered Digital Twin changes.", url: "https://www.iso.org/standard/87425.html", explorer: true },
  "OID-04": { method: "Compare created_at and updated_at when both root timestamps are available.", expected: "updated_at must be greater than or equal to created_at.", source: "OIDTwin root timestamps", standard: "ISO 23247-5:2026", scope: "Chronological consistency of Digital Thread evidence.", url: "https://www.iso.org/standard/87425.html", explorer: true },
  "ID-01": { method: "Collect creator, owner, steward and Twin identifiers and validate the did: URI prefix.", expected: "Every exposed responsibility identifier must be syntactically recognizable as a DID.", source: "OIDTwin identity fields", standard: "ISO/IEC 30188:2026", scope: "Identity, stakeholder and governance views in the reference architecture.", url: "https://www.iso.org/standard/53308.html", explorer: true },
  "DT-01": { method: "Use the incremental verifier result for the revision-ordered OIDTwinEvent sequence.", expected: "The indexed event sequence and its evidence chain must verify successfully.", source: "Digital Thread verifier", standard: "ISO 23247-5:2026", scope: "Digital Thread for Digital Twin.", url: "https://www.iso.org/standard/87425.html", explorer: true },
  "TEL-01": { method: "Compare the MQTT sample assetId with the configured OIDTwin object ID.", expected: "Telemetry must identify the Twin currently being monitored.", source: "Latest MQTT observation", standard: "ISO 23247-4:2021", scope: "Information exchange between entities in the Digital Twin reference architecture.", url: "https://www.iso.org/standard/78745.html", explorer: false },
  "TEL-02": { method: "Calculate the age of observedAt against the console clock using a 30-second threshold.", expected: "The latest observation must be no older than 30 seconds.", source: "Latest MQTT observation", standard: "ISO 23247-4:2021", scope: "Timely information exchange across Digital Twin networks.", url: "https://www.iso.org/standard/78745.html", explorer: false },
  "TEL-03": { method: "Count numeric values in the expected telemetry measurement set.", expected: "All five configured measurements must contain numeric values.", source: "Latest MQTT observation", standard: "ISO 23247-3:2021", scope: "Interpretable information attributes in the digital representation.", url: "https://www.iso.org/standard/78744.html", explorer: false },
  "SYS-01": { method: "Evaluate the integration server readiness aggregate for required dependencies.", expected: "ObjectID, profile loading, MQTT and object storage must all report operational readiness.", source: "Integration server readiness endpoint", standard: "ISO 23247-2:2021", scope: "Functional entities and reference architecture for a manufacturing Digital Twin.", url: "https://www.iso.org/standard/78743.html", explorer: false }
};

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

      <nav className="tabs" aria-label="Console sections">
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
              <p>{textOf(fields.description) || "Operational digital twin with MQTT telemetry, off-chain evidence and an IOTA trust anchor."}</p>
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
            <SectionTitle index="01" title="Live telemetry" note={`${telemetry.received} samples received`} />
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
              <Detail label="Creator DID" value={textOf(fields.creator_did) || "Not available"} mono />
              <Detail label="Target DID" value={textOf(fields.target_did) || "Not assigned"} mono />
              <Detail label="Twin DID" value={textOf(fields.twin_did) || "Not assigned"} mono />
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

      {!loading && tab === "assurance" && <Assurance checks={checks} score={score} verification={verification} readiness={readiness} twinId={twinId} network={dashboard?.meta?.network ?? "testnet"} />}
      {!loading && tab === "thread" && <Thread dashboard={dashboard} />}
      {!loading && tab === "standards" && <Standards />}

      <footer>
        <span>OBJECTID DIGITAL TWIN / V1</span>
        <p>Technical self-assessment. This interface does not constitute ISO certification.</p>
        <span>{dashboard?.generatedAt ? new Date(dashboard.generatedAt).toLocaleString('en-GB') : "SYNCING"}</span>
      </footer>
    </main>
  );
}

function Assurance({ checks, score, verification, readiness, twinId, network }) {
  const [selectedCheck, setSelectedCheck] = useState(null);
  const groups = ["Congruity", "Consistency"];
  return <section className="view assurance-view">
    <div className="assurance-head panel">
      <div><span className="eyebrow">EVIDENCE-BASED CONTROL</span><h2>Congruity &amp; consistency</h2><p>Every result is derived from live data, on-chain state or Digital Thread evidence.</p></div>
      <div className="score-ring" style={{'--score': `${score * 3.6}deg`}}><strong>{score}</strong><span>/100</span></div>
      <div className="score-meta"><StatusDot ok={score >= 80} label={score >= 80 ? "ASSURANCE NOMINAL" : "REVIEW REQUIRED"} /><small>{checks.filter(c=>c.status==='pass').length} PASS · {checks.filter(c=>c.status==='warn').length} WARN · {checks.filter(c=>c.status==='fail').length} FAIL</small></div>
    </div>
    <div className="check-columns">
      {groups.map(group => <div className="check-group" key={group}><SectionTitle index={group === 'Congruity' ? 'A' : 'B'} title={group} note={group === 'Congruity' ? 'FORM & MEANING' : 'RELATIONSHIPS & CONTINUITY'} compact />
        {checks.filter(c=>c.group===group).map(item => <button type="button" className={`check-row ${item.status}`} key={item.id} onClick={() => setSelectedCheck(item)} aria-haspopup="dialog"><span className="check-code">{item.id}</span><div><strong>{item.label}</strong><small>{item.evidence}</small></div><b>{item.status.toUpperCase()}</b></button>)}
      </div>)}
    </div>
    <div className="evidence-band panel"><div><small>DIGITAL THREAD</small><strong>{verification?.valid ? 'Cryptographically coherent' : 'Evidence pending'}</strong></div><div><small>REQUIRED SERVICES</small><strong>{readiness?.ready ? 'All operational' : 'Review required'}</strong></div><div><small>METHOD</small><strong>Deterministic / explainable</strong></div></div>
    {selectedCheck && <CheckDialog check={selectedCheck} details={QUALITY_DETAILS[selectedCheck.id]} twinId={twinId} network={network} onClose={() => setSelectedCheck(null)} />}
  </section>;
}

function CheckDialog({ check, details, twinId, network, onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => event.key === "Escape" && onClose();
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus?.();
    };
  }, [onClose]);

  const explorerUrl = `https://explorer.iota.org/object/${twinId}?network=${network}`;
  return <div className="check-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} tabIndex="-1" className="check-dialog panel" role="dialog" aria-modal="true" aria-labelledby="check-dialog-title">
      <button type="button" className="dialog-close" onClick={onClose} aria-label="Close verification details">CLOSE <span aria-hidden="true">X</span></button>
      <div className="dialog-heading">
        <span className="check-code">{check.id}</span>
        <div><small>{check.group} verification</small><h2 id="check-dialog-title">{check.label}</h2></div>
        <b className={`dialog-status ${check.status}`}>{check.status.toUpperCase()}</b>
      </div>
      <div className="dialog-evidence"><small>OBSERVED RESULT</small><strong>{check.evidence}</strong></div>
      <div className="dialog-detail-grid">
        <div><small>VERIFICATION METHOD</small><p>{details?.method}</p></div>
        <div><small>EXPECTED CONDITION</small><p>{details?.expected}</p></div>
        <div><small>DATA SOURCE</small><p>{details?.source}</p></div>
        <div><small>ISO ALIGNMENT</small><p><strong>{details?.standard}</strong><br />{details?.scope}</p></div>
      </div>
      <p className="dialog-disclaimer">This is an explainable technical check against the implemented architecture. It is not a certification result or a clause-by-clause conformity assessment.</p>
      <div className="dialog-actions">
        <a href={details?.url} target="_blank" rel="noreferrer">OPEN ISO REFERENCE <span>↗</span></a>
        {details?.explorer && twinId && <a href={explorerUrl} target="_blank" rel="noreferrer">VIEW EVIDENCE ON IOTA <span>↗</span></a>}
      </div>
    </section>
  </div>;
}

function Thread({ dashboard }) {
  const [selectedEvent, setSelectedEvent] = useState(null);
  const thread = dashboard?.thread?.ok ? dashboard.thread.data : null;
  const items = Array.isArray(thread) ? thread : thread?.items ?? [];
  const verification = dashboard?.verification?.ok ? dashboard.verification.data : null;
  const report = dashboard?.report?.ok ? dashboard.report.data : null;
  const network = dashboard?.meta?.network ?? "testnet";
  return <section className="view thread-view">
    <div className="thread-head"><div><span className="eyebrow">ISO 23247-5:2026</span><h2>Digital thread</h2><p>Native revision-ordered sequence of OIDTwin events.</p></div><div className={`verification-seal ${verification?.valid ? 'valid' : ''}`}><span>{verification?.valid ? 'VERIFIED' : 'PENDING'}</span><strong>{verification?.eventCount ?? items.length}</strong><small>EVENTS</small></div></div>
    {items.length ? <div className="timeline">{items.map((event,index)=><button type="button" className="timeline-event" key={event.eventId ?? index} onClick={() => setSelectedEvent(event)} aria-haspopup="dialog"><span className="timeline-node"/><div className="timeline-rev">R{event.revisionAfter ?? index+1}</div><div><strong>{eventLabel(event.eventType)}</strong><p>{event.actorDid || 'Actor DID unavailable'}</p><code>{shortId(event.eventId)}</code></div><time>{formatChainTime(event.createdAt)}</time><span className="timeline-open">DETAILS ↗</span></button>)}</div> : dashboard?.thread?.ok ? <Empty title="Digital Thread is empty" text="No OIDTwinEvent records are currently associated with this Twin." /> : <Empty title="Digital Thread unavailable" text={dashboard?.thread?.error || "The on-chain event sequence could not be read."} />}
    <div className="report-panel panel"><SectionTitle index="HASH" title="Audit evidence" note="RFC 8785 / SHA-256" compact/><Detail label="Verifier" value={report?.verifierVersion || 'ObjectID incremental verifier'} /><Detail label="Evidence digest" value={report?.eventEvidenceDigest || report?.evidenceHash?.digest || 'Pending'} mono/><Detail label="Report hash" value={report?.reportHash || 'Pending'} mono/></div>
    {selectedEvent && <ThreadEventDialog event={selectedEvent} network={network} onClose={() => setSelectedEvent(null)} />}
  </section>;
}

function ThreadEventDialog({ event, network, onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (keyboardEvent) => keyboardEvent.key === "Escape" && onClose();
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus?.();
    };
  }, [onClose]);

  const objectUrl = objectExplorerUrl(event.eventId, network);
  const twinUrl = objectExplorerUrl(event.twinId, network);
  const transactionUrl = event.transactionDigest ? transactionExplorerUrl(event.transactionDigest, network) : "";
  return <div className="check-dialog-backdrop" role="presentation" onMouseDown={(mouseEvent) => mouseEvent.target === mouseEvent.currentTarget && onClose()}>
    <section ref={dialogRef} tabIndex="-1" className="check-dialog thread-event-dialog panel" role="dialog" aria-modal="true" aria-labelledby="thread-event-title">
      <button type="button" className="dialog-close" onClick={onClose} aria-label="Close event details">CLOSE <span aria-hidden="true">X</span></button>
      <div className="dialog-heading">
        <span className="event-type-code">E{String(event.eventType).padStart(3, "0")}</span>
        <div><small>ON-CHAIN TWIN EVENT</small><h2 id="thread-event-title">{eventLabel(event.eventType)}</h2></div>
        <b className="dialog-status">REV {event.revisionAfter}</b>
      </div>
      <div className="dialog-evidence"><small>REVISION TRANSITION</small><strong>{event.revisionBefore} → {event.revisionAfter}</strong><span>{formatChainTime(event.createdAt)}</span></div>
      <div className="event-detail-list">
        <EventField label="EVENT OBJECT ID" value={event.eventId} copy />
        <EventField label="TWIN OBJECT ID" value={event.twinId} copy />
        <EventField label="ACTOR DID" value={event.actorDid} copy />
        <EventField label="PAYLOAD REFERENCE" value={event.payloadRef || "Not provided"} copy={Boolean(event.payloadRef)} />
        <EventField label="PAYLOAD HASH" value={event.payloadHash || "Not provided"} copy={Boolean(event.payloadHash)} />
        <EventField label="TRANSACTION DIGEST" value={event.transactionDigest || "Not exposed by the current provider"} copy={Boolean(event.transactionDigest)} />
      </div>
      <p className="dialog-disclaimer">This record is an OIDTwinEvent child object stored on IOTA. Payload bodies may remain off-chain; the event stores their reference and integrity hash when supplied.</p>
      <div className="dialog-actions">
        {isIotaObjectId(event.eventId) && <a href={objectUrl} target="_blank" rel="noreferrer">VIEW EVENT ON IOTA <span>↗</span></a>}
        {isIotaObjectId(event.twinId) && <a href={twinUrl} target="_blank" rel="noreferrer">VIEW TWIN ON IOTA <span>↗</span></a>}
        {transactionUrl && <a href={transactionUrl} target="_blank" rel="noreferrer">VIEW TRANSACTION <span>↗</span></a>}
      </div>
    </section>
  </div>;
}

function EventField({ label, value, copy = false }) {
  return <div><small>{label}</small><code title={value}>{value}</code>{copy && <Copy value={value} />}</div>;
}

function Standards() {
  return <section className="view standards-view">
    <div className="standards-intro"><span className="eyebrow">ARCHITECTURE ASSURANCE</span><h2>Standards alignment map</h2><p>Technical traceability between ObjectID capabilities and applicable standards. These assessments are architectural and do not replace a certification audit.</p><div className="publication-note"><b>30188 / PUBLISHED</b><span>Edition 1 · July 2026 · General reference architecture</span></div></div>
    <div className="standards-table">{STANDARD_ROWS.map((row,index)=><a href={row.url} target="_blank" rel="noreferrer" key={row.ref}><span className="std-index">0{index+1}</span><div><strong>{row.ref}</strong><small>{row.area}</small></div><p>{row.evidence}</p><b>{row.status}</b><i>↗</i></a>)}</div>
    <div className="architecture-views panel"><SectionTitle index="RA" title="Implemented architecture views" note="OBJECTID INTERPRETATION" compact/><div className="view-map"><span>Physical entity<small>machine / source</small></span><i>MQTT</i><span>Digital twin<small>OIDTwin / aspects</small></span><i>API</i><span>Services<small>storage / assurance</small></span><i>DID</i><span>Users & roles<small>owner / steward</small></span></div></div>
  </section>;
}

function TwinVisual({ connected }) { return <div className="twin-visual" aria-label="Realistic digital representation of an industrial machine"><div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="scan-line"/><img className="machine-render" src="/digital-twin-machine-v2.png" alt="Automated industrial production machine represented by the Digital Twin"/><i className={`machine-link ${connected ? 'live' : ''}`}/><div className="visual-tag"><span>{connected ? 'LIVE' : 'LINK'}</span><small>DIGITAL REPRESENTATION</small></div></div> }

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
function LiveClock() { const [now,setNow]=useState(new Date()); useEffect(()=>{const id=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(id)},[]); return <time>{now.toLocaleTimeString('en-GB')}</time> }
function Empty({title,text}) { return <div className="empty panel"><span>NO DATA</span><h3>{title}</h3><p>{text}</p></div> }
function Loading() { return <div className="loading"><i/><span>Synchronizing digital representation</span></div> }
function shortId(value="") { return value.length > 20 ? `${value.slice(0,10)}…${value.slice(-8)}` : value || '—'; }
function formatChainTime(value) { const number=Number(value); if(!number)return '—'; return new Date(number < 1e12 ? number*1000:number).toLocaleString('en-GB'); }
function linePath(values,min,max) { if(!values.length)return ''; return values.map((v,i)=>`${i?'L':'M'} ${(i/Math.max(1,values.length-1))*1000} ${165-((v-min)/(max-min))*140}`).join(' '); }
function areaPath(values,min,max) { const line=linePath(values,min,max); return line ? `${line} L 1000 180 L 0 180 Z` : ''; }
