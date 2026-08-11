import { useEffect, useRef, useState } from "react";
import { Ed25519Keypair } from "@iota/iota-sdk/keypairs/ed25519";
import { fieldsOf, LIFECYCLE, qualityScore, runQualityChecks, textOf } from "./quality.js";
import { eventLabel, isIotaObjectId, objectExplorerUrl, transactionExplorerUrl } from "./thread-ui.js";
import { validateAuditEvidence } from "./audit-validation.js";
import "./auth.css";
import { buildCreateTwinTransaction, buildDeleteTwinTransaction, createdTwinId, executeTwinTransaction, usableCreditTokens } from "./twin-mutations.js";

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

const SIMULATION_FAULTS = {
  overheat: "Spindle temperature exceeds the nominal operating envelope",
  "high-vibration": "Mechanical vibration exceeds the configured alarm threshold",
  "spindle-overload": "Spindle speed and active power indicate an overload condition",
  "pressure-loss": "Pneumatic pressure is below the safe operating threshold",
  "emergency-stop": "Emergency stop is active; spindle and power output are zero",
};

export function App() {
  const [dashboard, setDashboard] = useState(null);
  const [telemetry, setTelemetry] = useState({ connected: false, latest: null, samples: [], received: 0 });
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [session, setSession] = useState(null);
  const [selectedTwinId, setSelectedTwinId] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [twinPickerOpen, setTwinPickerOpen] = useState(false);
  const [mutationMode, setMutationMode] = useState(null);
  const [transactionNotice, setTransactionNotice] = useState(null);
  const signerRef = useRef(null);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then(setSession)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    async function load() {
      try {
        const query = selectedTwinId ? `?twinId=${encodeURIComponent(selectedTwinId)}` : "";
        const response = await fetch(`/api/dashboard${query}`, { cache: "no-store" });
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
    const stream = selectedTwinId ? null : new EventSource("/api/live");
    stream?.addEventListener("snapshot", (event) => active && setTelemetry(JSON.parse(event.data)));
    stream?.addEventListener("telemetry", (event) => {
      if (!active) return;
      const { sample, received } = JSON.parse(event.data);
      setTelemetry((current) => ({ ...current, connected: true, latest: sample, received, samples: [...(current.samples ?? []), sample].slice(-60) }));
    });
    return () => { active = false; clearInterval(poll); stream?.close(); };
  }, [selectedTwinId]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setSession(null);
    setSelectedTwinId("");
    signerRef.current = null;
  }

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
          <span className={`data-source ${dashboard?.meta?.dataSource === "chain-only" ? "chain" : ""}`}>{dashboard?.meta?.dataSource === "chain-only" ? "CHAIN ONLY" : "BE + CHAIN"}</span>
          <span className="network">IOTA / {dashboard?.meta?.network?.toUpperCase() ?? "TESTNET"}</span>
          <LiveClock />
          {session
            ? <div className="did-session-controls"><button className="did-session-button" type="button" onClick={() => setTwinPickerOpen(true)}>MY DIGITAL TWINS</button><button className="did-logout-button" type="button" onClick={logout}>LOGOUT</button></div>
            : <button className="did-login-button" type="button" onClick={() => setLoginOpen(true)}>DID LOGIN</button>}
        </div>
      </header>

      {session && <TwinSelector session={session} selectedTwinId={selectedTwinId} signingEnabled={Boolean(signerRef.current)} onOpen={() => setTwinPickerOpen(true)} onCreate={() => setMutationMode("create")} onDelete={() => setMutationMode("delete")} onEnableSigning={() => setLoginOpen(true)} />}

      <nav className="tabs" aria-label="Console sections">
        {[['overview','Operational view'],['assurance','Quality assurance'],['thread','Digital thread'],['standards','Standards map']].map(([id,label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><span>{label}</span></button>
        ))}
      </nav>

      {error && <div className="alert"><b>UPSTREAM DEGRADED</b><span>{error}</span></div>}
      {dashboard?.meta?.dataSource === "chain-only" && <div className="chain-notice"><b>CHAIN-ONLY VIEW</b><span>The integration backend is unavailable or incomplete. Only evidence resolved directly from IOTA is shown; off-chain data is intentionally hidden.</span></div>}
      {transactionNotice && <div className="transaction-notice"><div><b>{transactionNotice.title}</b><span>{transactionNotice.message}</span></div><a href={transactionExplorerUrl(transactionNotice.digest, dashboard?.meta?.network ?? "testnet")} target="_blank" rel="noreferrer">VIEW TRANSACTION ↗</a><button type="button" onClick={() => setTransactionNotice(null)}>×</button></div>}
      {latest?.simulationScenario && latest.simulationScenario !== "normal" && <div className="simulation-alert"><div><small>SIMULATED CNC FAULT</small><strong>{latest.simulationScenario.replaceAll("-", " ")}</strong></div><p>{SIMULATION_FAULTS[latest.simulationScenario] || "Injected simulator condition"}</p><span>{latest.operatingState?.toUpperCase() || "ALARM"}</span></div>}
      {loading && <Loading />}
      {loginOpen && <DidLoginDialog onClose={() => setLoginOpen(false)} onAuthenticated={(value, keypair) => { signerRef.current = keypair; setSession(value); setLoginOpen(false); setTwinPickerOpen(true); }} />}
      {session && twinPickerOpen && <TwinPicker session={session} selectedTwinId={selectedTwinId} onClose={() => setTwinPickerOpen(false)} onSelect={(twinId) => { setSelectedTwinId(twinId); setTwinPickerOpen(false); }} />}
      {session && mutationMode === "create" && <CreateTwinDialog session={session} keypair={signerRef.current} onClose={() => setMutationMode(null)} onComplete={async ({ digest, twinId: createdId, name }) => { setMutationMode(null); setTransactionNotice({ title: "DIGITAL TWIN CREATED", message: `${name} is confirmed on IOTA.`, digest }); if (createdId) { const remembered = await fetch("/api/my/twins/remember", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ twinId: createdId }) }).then(async (response) => response.ok ? response.json() : null).catch(() => null); if (remembered) setSession(remembered); else setSession((current) => ({ ...current, twins: [...current.twins, { twinId: createdId, name, description: "", revision: 1, roles: ["owner", "creator", "steward"] }] })); setSelectedTwinId(createdId); } }} />}
      {session && mutationMode === "delete" && <DeleteTwinDialog twin={session.twins.find((item) => item.twinId === selectedTwinId)} network={dashboard?.meta?.network ?? "testnet"} keypair={signerRef.current} onClose={() => setMutationMode(null)} onComplete={async ({ digest, twinId: deletedId, name }) => { setMutationMode(null); setTransactionNotice({ title: "DIGITAL TWIN DELETED", message: `${name} was deleted on IOTA.`, digest }); setSession((current) => ({ ...current, twins: current.twins.filter((twin) => twin.twinId !== deletedId) })); setSelectedTwinId(""); await fetch("/api/my/twins/forget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ twinId: deletedId }) }).catch(() => undefined); }} />}

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
              <Metric name="Temperature" metric={latest?.measurements?.temperature} accent="hot" alarm={Number(latest?.measurements?.temperature?.value) > 85} />
              <Metric name="Vibration" metric={latest?.measurements?.vibration} accent="signal" alarm={Number(latest?.measurements?.vibration?.value) > 5.5} />
              <Metric name="Rotational speed" metric={latest?.measurements?.rotationalSpeed} alarm={Number(latest?.measurements?.rotationalSpeed?.value) > 4500} />
              <Metric name="Active power" metric={latest?.measurements?.activePower} alarm={Number(latest?.measurements?.activePower?.value) > 25} />
              <Metric name="Pressure" metric={latest?.measurements?.pressure} alarm={latest?.measurements?.pressure && Number(latest.measurements.pressure.value) < 4.5} />
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

function TwinSelector({ session, selectedTwinId, signingEnabled, onOpen, onCreate, onDelete, onEnableSigning }) {
  const selected = session.twins.find((twin) => twin.twinId === selectedTwinId);
  const canDelete = selected?.roles?.some((role) => role === "owner" || role === "steward");
  return <section className="identity-console" aria-label="Authenticated DID Twins">
    <div className="identity-principal"><span>SIGNED IN WITH DID</span><strong title={session.did}>{shortId(session.did)}</strong><small>Signer {shortId(session.address)}</small></div>
    <div className="selected-twin-summary"><span>CURRENT VIEW</span><strong>{selected?.name || "Public Demo Twin"}</strong><small>{selected ? `Your relationship: ${roleLabels(selected.roles).join(", ")} · Revision ${selected.revision ?? "—"}` : "Public example · No ownership implied"}</small></div>
    <div className="twin-workspace-actions"><button type="button" onClick={onOpen}>SELECT TWIN</button>{signingEnabled ? <><button type="button" onClick={onCreate}>CREATE</button>{canDelete && <button className="danger" type="button" onClick={onDelete}>DELETE</button>}</> : <button type="button" onClick={onEnableSigning}>ENABLE SIGNING</button>}</div>
  </section>;
}

function TwinPicker({ session, selectedTwinId, onClose, onSelect }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const closeOnEscape = (event) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className="login-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="twin-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="twin-picker-title" ref={dialogRef} tabIndex={-1}>
      <button className="dialog-close" type="button" onClick={onClose} aria-label="Close">×</button>
      <span className="eyebrow">AUTHENTICATED WORKSPACE</span>
      <h2 id="twin-picker-title">Choose a Digital Twin</h2>
      <p>Select the public demonstration or one of the OIDTwins associated on-chain with your authenticated DID.</p>
      <div className="twin-choice-list">
        <button type="button" className={!selectedTwinId ? "active" : ""} onClick={() => onSelect("")}>
          <span className="choice-kind">PUBLIC DEMONSTRATION</span><strong>Demo Twin</strong><p>Shared example with simulated CNC telemetry. It is not one of your Digital Twins.</p><small>{!selectedTwinId ? "CURRENTLY OPEN" : "OPEN DEMO"}</small>
        </button>
        {session.twins.map((twin) => <button type="button" className={selectedTwinId === twin.twinId ? "active" : ""} key={twin.twinId} onClick={() => onSelect(twin.twinId)}>
          <span className="choice-kind">YOUR DIGITAL TWIN</span><strong>{twin.name || shortId(twin.twinId)}</strong><p>Your relationship to this Twin: <b>{roleLabels(twin.roles).join(", ")}</b>. Current on-chain revision: {twin.revision ?? "not available"}.</p><code>{shortId(twin.twinId)}</code><small>{selectedTwinId === twin.twinId ? "CURRENTLY OPEN" : "OPEN TWIN"}</small>
        </button>)}
      </div>
      {!session.twins.length && <div className="no-personal-twins"><b>NO PERSONAL TWINS FOUND</b><span>The DID login is valid, but no OIDTwin currently references this DID as owner, creator, steward or Twin identity.</span></div>}
    </section>
  </div>;
}

function roleLabels(roles = []) {
  const labels = { owner: "Owner", creator: "Creator", steward: "Steward", twin: "Twin identity" };
  return roles.map((role) => labels[role] || humanize(role));
}

function DidLoginDialog({ onClose, onAuthenticated }) {
  const [did, setDid] = useState("");
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const closeOnEscape = (event) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const challengeResponse = await fetch("/api/auth/challenge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ did: did.trim() }),
      });
      const challenge = await challengeResponse.json();
      if (!challengeResponse.ok) throw new Error(challenge.error || "Unable to create login challenge");
      const keypair = Ed25519Keypair.deriveKeypairFromSeed(seed.trim().replace(/^0x/i, ""));
      const signed = await keypair.signPersonalMessage(new TextEncoder().encode(challenge.message));
      setSeed("");
      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.challengeId, did: did.trim(), signature: signed.signature }),
      });
      const session = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(session.error || "DID authentication failed");
      onAuthenticated(session, keypair);
    } catch (cause) {
      setSeed("");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  return <div className="login-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <section className="did-login-dialog" role="dialog" aria-modal="true" aria-labelledby="did-login-title" ref={dialogRef} tabIndex={-1}>
      <button className="dialog-close" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
      <span className="eyebrow">LOCAL SIGNATURE / ON-CHAIN PROOF</span>
      <h2 id="did-login-title">Access your Digital Twins</h2>
      <p>Your seed signs a one-time challenge inside this browser. It is never transmitted, logged or stored by ObjectID.</p>
      <form onSubmit={submit} autoComplete="off">
        <label><span>IOTA DID</span><input value={did} onChange={(event) => setDid(event.target.value)} placeholder="did:iota:testnet:0x..." autoComplete="username" required /></label>
        <label><span>SEED</span><input value={seed} onChange={(event) => setSeed(event.target.value)} type="password" placeholder="Identity seed" autoComplete="off" spellCheck="false" data-1p-ignore required /></label>
        {error && <div className="login-error">{error}</div>}
        <div className="login-actions"><button type="button" onClick={onClose} disabled={busy}>KEEP DEMO MODE</button><button type="submit" disabled={busy}>{busy ? "VERIFYING ON IOTA…" : "SIGN & LOGIN"}</button></div>
      </form>
      <small className="login-security">Session: HttpOnly / SameSite Strict / 30 minutes</small>
    </section>
  </div>;
}

function CreateTwinDialog({ session, keypair, onClose, onComplete }) {
  const [context, setContext] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "", description: "", namespace: "objectid", twinType: "machine", targetKind: "physical-asset",
    targetObjectId: "", targetDid: "", lifecycleState: "1", fidelityLevel: "1", maturityLevel: "1",
    immutableMetadata: "{}", mutableMetadata: "{}", creditTokenId: "",
  });
  useEffect(() => {
    fetch("/api/my/mutation-context", { cache: "no-store" }).then(async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Unable to load transaction objects");
      const credits = usableCreditTokens(value);
      setContext(value);
      setForm((current) => ({ ...current, creditTokenId: credits[0]?.objectId ?? "" }));
    }).catch((cause) => setError(cause.message));
  }, []);
  const credits = usableCreditTokens(context);
  const update = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (!keypair) throw new Error("Signing is not enabled. Log in again with DID and seed.");
      if (!context || !form.creditTokenId) throw new Error("An OID Credit token with positive balance is required.");
      JSON.parse(form.immutableMetadata); JSON.parse(form.mutableMetadata);
      const transaction = buildCreateTwinTransaction(context, form);
      const result = await executeTwinTransaction({ keypair, network: context.network, transaction });
      await onComplete({ digest: result.digest, twinId: createdTwinId(result, context.packageId), name: form.name });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <MutationDialog title="Create a Digital Twin" eyebrow="ON-CHAIN MUTATION / 1 OID CREDIT" onClose={onClose} busy={busy}>
    <p>The new OIDTwin will be created on IOTA. Your authenticated DID becomes creator, owner and steward.</p>
    <form className="twin-mutation-form" onSubmit={submit}>
      <label><span>NAME *</span><input value={form.name} onChange={update("name")} placeholder="Five-axis CNC" required /></label>
      <label><span>NAMESPACE *</span><input value={form.namespace} onChange={update("namespace")} placeholder="objectid" required /></label>
      <label className="wide"><span>DESCRIPTION</span><textarea value={form.description} onChange={update("description")} placeholder="Operational Digital Twin description" /></label>
      <label><span>TWIN TYPE *</span><input value={form.twinType} onChange={update("twinType")} required /></label>
      <label><span>TARGET KIND *</span><input value={form.targetKind} onChange={update("targetKind")} required /></label>
      <label className="wide"><span>TARGET DID</span><input value={form.targetDid} onChange={update("targetDid")} placeholder="Optional DID of the represented asset" /></label>
      <label className="wide"><span>TARGET OBJECT ID</span><input value={form.targetObjectId} onChange={update("targetObjectId")} placeholder="Optional 0x… IOTA object" /></label>
      <label><span>LIFECYCLE</span><select value={form.lifecycleState} onChange={update("lifecycleState")}>{[[1,"Design"],[2,"Development"],[3,"Commissioning"],[4,"Production"],[5,"Deployment"],[6,"Operation"],[7,"Maintenance"],[8,"Decommissioning"],[9,"Retired"],[10,"Archived"]].map(([value,label])=><option value={value} key={value}>{value} · {label}</option>)}</select></label>
      <label><span>FIDELITY LEVEL</span><input type="number" min="0" max="255" value={form.fidelityLevel} onChange={update("fidelityLevel")} /></label>
      <label><span>MATURITY LEVEL</span><input type="number" min="0" max="255" value={form.maturityLevel} onChange={update("maturityLevel")} /></label>
      <label><span>OID CREDIT TOKEN</span><select value={form.creditTokenId} onChange={update("creditTokenId")} disabled={!credits.length}><option value="">{credits.length ? "Select credit token" : "No spendable credits"}</option>{credits.map((token)=><option value={token.objectId} key={token.objectId}>{shortId(token.objectId)} · balance {token.balance}</option>)}</select></label>
      {context && !credits.length && <div className="credit-warning wide"><b>OID CREDIT REQUIRED</b><span>The published Twin package requires credits from package {shortId(context.creditPackageId)}. {context.creditTokens.length ? `The compatible token balance is ${context.creditTokens.map((token) => token.balance).join(", ")}.` : "No compatible token is owned by this signer."}</span></div>}
      <label className="wide"><span>IMMUTABLE METADATA / JSON</span><textarea value={form.immutableMetadata} onChange={update("immutableMetadata")} /></label>
      <label className="wide"><span>MUTABLE METADATA / JSON</span><textarea value={form.mutableMetadata} onChange={update("mutableMetadata")} /></label>
      {context && <div className="mutation-cost wide"><b>TRANSACTION AUTHORITY</b><span>{shortId(session.did)} · 1 OID Credit · gas paid by {shortId(session.address)}</span></div>}
      {error && <div className="login-error wide">{error}</div>}
      <div className="mutation-actions wide"><button type="button" onClick={onClose} disabled={busy}>CANCEL</button><button type="submit" disabled={busy || !context || !credits.length}>{busy ? "SIGNING & CONFIRMING…" : "CREATE ON IOTA"}</button></div>
    </form>
  </MutationDialog>;
}

function DeleteTwinDialog({ twin, network, keypair, onClose, onComplete }) {
  const [context, setContext] = useState(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/my/mutation-context", { cache: "no-store" }).then(async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Unable to load transaction objects");
      setContext(value);
    }).catch((cause) => setError(cause.message));
  }, []);
  const credit = usableCreditTokens(context)[0];
  const expected = twin?.name || twin?.twinId || "";

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      if (!twin) throw new Error("No personal Digital Twin is selected.");
      if (!keypair) throw new Error("Signing is not enabled. Log in again with DID and seed.");
      if (confirmation !== expected) throw new Error("Confirmation does not match the Twin name.");
      if (!context || !credit) throw new Error("An OID Credit token with positive balance is required.");
      const transaction = buildDeleteTwinTransaction(context, twin.twinId, credit.objectId);
      const result = await executeTwinTransaction({ keypair, network, transaction });
      await onComplete({ digest: result.digest, twinId: twin.twinId, name: expected });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <MutationDialog title="Delete this Digital Twin?" eyebrow="DESTRUCTIVE ON-CHAIN MUTATION / 1 OID CREDIT" onClose={onClose} busy={busy} danger>
    <p>This consumes the shared OIDTwin object on IOTA and cannot be undone. Existing historical chain evidence is not rewritten.</p>
    <div className="delete-twin-summary"><span>TWIN</span><strong>{expected}</strong><code>{twin?.twinId}</code><span>YOUR AUTHORITY</span><strong>{roleLabels(twin?.roles).join(", ")}</strong></div>
    <form className="delete-confirm-form" onSubmit={submit}><label><span>TYPE “{expected}” TO CONFIRM</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>{context && !credit && <div className="credit-warning"><b>OID CREDIT REQUIRED</b><span>The compatible token has no spendable balance. Deletion cannot be submitted.</span></div>}{error && <div className="login-error">{error}</div>}<div className="mutation-actions"><button type="button" onClick={onClose} disabled={busy}>KEEP TWIN</button><button className="danger" type="submit" disabled={busy || confirmation !== expected || !credit}>{busy ? "DELETING…" : "DELETE ON IOTA"}</button></div></form>
  </MutationDialog>;
}

function MutationDialog({ title, eyebrow, onClose, busy, danger = false, children }) {
  return <div className="login-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section className={`mutation-dialog ${danger ? "danger" : ""}`} role="dialog" aria-modal="true"><button className="dialog-close" type="button" onClick={onClose} disabled={busy}>×</button><span className="eyebrow">{eyebrow}</span><h2>{title}</h2>{children}</section></div>;
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
    {items.length ? <div className="timeline">{items.map((event,index)=><button type="button" className="timeline-event" key={event.eventId ?? index} onClick={() => setSelectedEvent(event)} aria-haspopup="dialog"><span className="timeline-node"/><div className="timeline-rev">R{event.revisionAfter ?? index+1}</div><div><strong>{eventSummary(event)}</strong><p>{event.actorDid || 'Actor DID unavailable'}</p><code>{shortId(event.eventId)}</code></div><time>{formatChainTime(event.createdAt)}</time><span className="timeline-open">DETAILS ↗</span></button>)}</div> : dashboard?.thread?.ok ? <Empty title="Digital Thread is empty" text="No OIDTwinEvent records are currently associated with this Twin." /> : <Empty title="Digital Thread unavailable" text={dashboard?.thread?.error || "The on-chain event sequence could not be read."} />}
    <AuditEvidencePanel items={items} verification={verification} report={report} network={network} twinId={dashboard?.meta?.twinId} />
    {selectedEvent && <ThreadEventDialog event={selectedEvent} network={network} onClose={() => setSelectedEvent(null)} />}
  </section>;
}

function AuditEvidencePanel({ items, verification, report, network, twinId }) {
  const [validation, setValidation] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let active = true;
    setValidation(null);
    validateAuditEvidence(items, verification, report)
      .then((result) => active && setValidation(result))
      .catch((error) => active && setValidation({ error: error.message }));
    return () => { active = false; };
  }, [items, verification, report]);

  const rows = [
    { id: "verifier", label: "Verifier", value: report?.verifierVersion || "ObjectID incremental verifier", status: validation?.verifier?.status },
    { id: "evidence", label: "Evidence digest", value: report?.evidenceHash?.digest || verification?.eventEvidenceDigest || "Pending", status: validation?.evidence?.status },
    { id: "report", label: "Report hash", value: report?.reportHash || "Pending", status: validation?.report?.status },
  ];

  return <>
    <div className="report-panel audit-panel panel">
      <SectionTitle index="HASH" title="Audit evidence" note="RFC 8785 / SHA-256" compact />
      {rows.map((row) => <button type="button" className="audit-row" key={row.id} onClick={() => setSelected(row.id)} aria-haspopup="dialog">
        <span>{row.label}</span><strong className={row.id === "verifier" ? "" : "mono"}>{row.value}</strong>
        <b className={`audit-status ${(row.status || "checking").toLowerCase()}`}>{row.status || "CHECKING"}</b><i>DETAILS ↗</i>
      </button>)}
    </div>
    {selected && <AuditEvidenceDialog kind={selected} validation={validation} verification={verification} report={report} items={items} network={network} twinId={twinId} onClose={() => setSelected(null)} />}
  </>;
}

function AuditEvidenceDialog({ kind, validation, verification, report, items, network, twinId, onClose }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const closeOnEscape = (event) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", closeOnEscape);
    dialogRef.current?.focus();
    return () => { document.removeEventListener("keydown", closeOnEscape); previousFocus?.focus?.(); };
  }, [onClose]);

  const data = validation?.[kind];
  const content = {
    verifier: {
      title: "Incremental verifier",
      method: "Validates event ordering, revision continuity, Twin identity, event types, actors and payload-hash syntax before producing the evidence digest.",
      expected: "Verifier 1.1.0, report format 1.0, a complete event range and no structural errors.",
    },
    evidence: {
      title: "Event evidence digest",
      method: "Each canonical event is serialized with RFC 8785 JCS and hashed with SHA-256. The resulting sha256 strings are concatenated in revision order and hashed again.",
      expected: "The browser calculation must exactly match the digest returned by the independent server verifier.",
    },
    report: {
      title: "Audit report hash",
      method: "The full audit report, excluding reportHash, is serialized with RFC 8785 JCS and hashed with SHA-256 in this browser.",
      expected: "The recalculated hash must exactly match reportHash. This proves integrity of the report content, not signer identity.",
    },
  }[kind];
  const explorer = twinId ? objectExplorerUrl(twinId, network) : null;

  return <div className="check-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} tabIndex="-1" className="check-dialog audit-dialog panel" role="dialog" aria-modal="true" aria-labelledby="audit-dialog-title">
      <button type="button" className="dialog-close" onClick={onClose}>CLOSE <span aria-hidden="true">X</span></button>
      <div className="dialog-heading"><span className="check-code">HASH</span><div><small>Independent browser validation</small><h2 id="audit-dialog-title">{content.title}</h2></div><b className={`dialog-status ${(data?.status || "checking").toLowerCase()}`}>{data?.status || "CHECKING"}</b></div>
      <div className="dialog-detail-grid"><div><small>VALIDATION METHOD</small><p>{content.method}</p></div><div><small>EXPECTED CONDITION</small><p>{content.expected}</p></div></div>
      {kind === "verifier" && <div className="audit-facts"><AuditFact label="Verifier version" value={report?.verifierVersion} /><AuditFact label="Report format" value={report?.reportFormatVersion} /><AuditFact label="Events checked" value={verification?.eventCount ?? items.length} /><AuditFact label="Thread result" value={verification?.valid ? "VALID / COMPLETE" : verification?.reason || "PARTIAL"} /><AuditFact label="Transaction inclusion" value={verification?.transactionVerification?.status || "NOT_VERIFIED"} /></div>}
      {kind !== "verifier" && <div className="hash-comparison"><AuditFact label="EXPECTED" value={data?.expected || "Unavailable"} copy /><AuditFact label="RECALCULATED IN BROWSER" value={data?.calculated || "Calculating"} copy /></div>}
      {kind === "evidence" && <div className="event-hash-list"><small>CANONICAL EVENT HASHES</small>{(data?.eventHashes ?? []).map((entry, index) => <a key={entry.eventId || index} href={isIotaObjectId(entry.eventId) ? objectExplorerUrl(entry.eventId, network) : explorer} target="_blank" rel="noreferrer"><span>R{entry.revision}</span><code>{entry.digest}</code><i>VIEW EVENT ↗</i></a>)}</div>}
      <p className="dialog-disclaimer">SHA-256 validates content integrity. It is not a digital signature. Transaction inclusion is reported separately and remains NOT_VERIFIED when the IOTA provider does not expose a transaction digest.</p>
      <div className="dialog-actions">{explorer && <a href={explorer} target="_blank" rel="noreferrer">VIEW TWIN ON IOTA <span>↗</span></a>}<a href="https://www.rfc-editor.org/rfc/rfc8785" target="_blank" rel="noreferrer">OPEN RFC 8785 <span>↗</span></a></div>
    </section>
  </div>;
}

function AuditFact({ label, value, copy = false }) {
  return <div><small>{label}</small><code>{String(value ?? "Unavailable")}</code>{copy && value && <Copy value={value} />}</div>;
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
  const state = event.referencedState;
  const payload = state?.payload && typeof state.payload === "object" ? state.payload : null;
  const transition = payload?.transition;
  const measurements = payload?.measurements;
  const stateUrl = state?.objectId ? objectExplorerUrl(state.objectId, network) : "";
  return <div className="check-dialog-backdrop" role="presentation" onMouseDown={(mouseEvent) => mouseEvent.target === mouseEvent.currentTarget && onClose()}>
    <section ref={dialogRef} tabIndex="-1" className="check-dialog thread-event-dialog panel" role="dialog" aria-modal="true" aria-labelledby="thread-event-title">
      <button type="button" className="dialog-close" onClick={onClose} aria-label="Close event details">CLOSE <span aria-hidden="true">X</span></button>
      <div className="dialog-heading">
        <span className="event-type-code">E{String(event.eventType).padStart(3, "0")}</span>
        <div><small>ON-CHAIN TWIN EVENT</small><h2 id="thread-event-title">{eventLabel(event.eventType)}</h2></div>
        <b className="dialog-status">REV {event.revisionAfter}</b>
      </div>
      <div className="dialog-evidence"><small>REVISION TRANSITION</small><strong>{event.revisionBefore} → {event.revisionAfter}</strong><span>{formatChainTime(event.createdAt)}</span></div>
      {state && <div className="state-evidence">
        <div className="state-evidence-head"><div><small>REFERENCED OIDTWINSTATE</small><h3>{transitionLabel(transition, payload)}</h3></div><span>QUALITY {state.qualityScore}/100</span></div>
        {transition && <div className="state-transition"><small>STATE TRANSITION</small><strong>{transition.fromScenario} <span>→</span> {transition.toScenario}</strong><p>{transition.kind} · {transition.source}</p></div>}
        <div className="state-tags"><span>ASPECT / {state.aspectCode}</span><span>SAMPLE / {state.sampleType}</span><span>OBSERVED / {formatChainTime(state.observedAt)}</span></div>
        {measurements && <div className="state-measurements">{Object.entries(measurements).map(([name, measurement])=><div key={name}><small>{humanize(name)}</small><strong>{measurement?.value ?? '—'}</strong><span>{measurement?.unit ?? ''}</span></div>)}</div>}
        {payload && <details className="state-payload"><summary>INSPECT HASHED PAYLOAD</summary><pre>{JSON.stringify(payload,null,2)}</pre></details>}
      </div>}
      <div className="event-detail-list">
        <EventField label="EVENT OBJECT ID" value={event.eventId} copy />
        <EventField label="TWIN OBJECT ID" value={event.twinId} copy />
        <EventField label="ACTOR DID" value={event.actorDid} copy />
        <EventField label={state ? "REFERENCED STATE OBJECT ID" : "PAYLOAD REFERENCE"} value={event.payloadRef || "Not provided"} copy={Boolean(event.payloadRef)} />
        <EventField label="EVENT PAYLOAD HASH" value={event.payloadHash || "Not encoded by this package version"} copy={Boolean(event.payloadHash)} />
        {state && <EventField label="STATE PAYLOAD HASH" value={state.payloadHash ? `sha256:${state.payloadHash.replace(/^sha256:/, '')}` : "Not provided"} copy={Boolean(state.payloadHash)} />}
        {state && <EventField label="SOURCE URI" value={state.sourceUri || "Not provided"} copy={Boolean(state.sourceUri)} />}
        <EventField label="TRANSACTION DIGEST" value={event.transactionDigest || "Not exposed by the current provider"} copy={Boolean(event.transactionDigest)} />
      </div>
      <p className="dialog-disclaimer">The E030 record points to an on-chain OIDTwinState. Its payload hash verifies the referenced state body; the event-level hash remains empty in the currently published Move package.</p>
      <div className="dialog-actions">
        {isIotaObjectId(event.eventId) && <a href={objectUrl} target="_blank" rel="noreferrer">VIEW EVENT ON IOTA <span>↗</span></a>}
        {isIotaObjectId(event.twinId) && <a href={twinUrl} target="_blank" rel="noreferrer">VIEW TWIN ON IOTA <span>↗</span></a>}
        {transactionUrl && <a href={transactionUrl} target="_blank" rel="noreferrer">VIEW TRANSACTION <span>↗</span></a>}
        {stateUrl && <a href={stateUrl} target="_blank" rel="noreferrer">VIEW STATE ON IOTA <span>↗</span></a>}
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

function TwinVisual({ connected }) { return <div className="twin-visual" aria-label="Realistic digital representation of a five-axis CNC machine"><div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="scan-line"/><img className="machine-render" src="/digital-twin-cnc-5-axis-v3.png" alt="Five-axis CNC machining center represented by the Digital Twin"/><i className={`machine-link ${connected ? 'live' : ''}`}/><div className="visual-tag"><span>{connected ? 'LIVE' : 'LINK'}</span><small>5-AXIS CNC REPRESENTATION</small></div></div> }

function TelemetryChart({ samples }) {
  const values = samples.slice(-30).map(s=>Number(s.measurements?.temperature?.value)).filter(Number.isFinite);
  const vibration = samples.slice(-30).map(s=>Number(s.measurements?.vibration?.value)).filter(Number.isFinite);
  return <div className="chart-panel panel"><div className="chart-head"><span>TEMP / VIBRATION TREND</span><small>LAST {Math.max(values.length,vibration.length)} SAMPLES</small></div><svg viewBox="0 0 1000 180" preserveAspectRatio="none"><g className="grid-lines">{[30,75,120,165].map(y=><line key={y} x1="0" y1={y} x2="1000" y2={y}/>)}</g><path className="area" d={areaPath(values,45,85)}/><path className="line-temp" d={linePath(values,45,85)}/><path className="line-vibration" d={linePath(vibration,0,6)}/></svg><div className="chart-legend"><span className="temp">Temperature</span><span className="vibration">Vibration</span><small>MQTT · QoS 1 · 5 sec</small></div></div>;
}

function Metric({ name, metric, accent="", alarm=false }) { return <div className={`metric ${accent} ${alarm ? 'alarm' : ''}`}><span>{name}</span><strong>{metric?.value ?? '—'}</strong><small>{alarm ? 'ALARM / ' : ''}{metric?.unit ?? 'WAITING'}</small><i/></div> }
function Detail({ label, value, mono=false, title }) { return <div className="detail"><span>{label}</span><strong className={mono?'mono':''} title={title || value}>{value || '—'}</strong></div> }
function SectionTitle({ index, title, note, compact=false }) { return <div className={`section-title ${compact?'compact':''}`}><span>{index}</span><h2>{title}</h2><small>{note}</small></div> }
function StatusDot({ ok, label }) { return <span className={`status-dot ${ok?'ok':''}`}><i/>{label}</span> }
function Copy({ value }) { const [done,setDone]=useState(false); return <button className="copy" onClick={()=>navigator.clipboard.writeText(value).then(()=>{setDone(true);setTimeout(()=>setDone(false),1200)})}>{done?'COPIED':'COPY'}</button> }
function LiveClock() { const [now,setNow]=useState(new Date()); useEffect(()=>{const id=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(id)},[]); return <time>{now.toLocaleTimeString('en-GB')}</time> }
function Empty({title,text}) { return <div className="empty panel"><span>NO DATA</span><h3>{title}</h3><p>{text}</p></div> }
function Loading() { return <div className="loading"><i/><span>Synchronizing digital representation</span></div> }
function shortId(value="") { return value.length > 20 ? `${value.slice(0,10)}…${value.slice(-8)}` : value || '—'; }
function eventSummary(event) { const payload=event.referencedState?.payload; const transition=payload && typeof payload==='object' ? payload.transition : null; return transition ? `${humanize(transition.kind)} · ${transition.toScenario}` : eventLabel(event.eventType); }
function transitionLabel(transition,payload) { return transition ? humanize(transition.kind) : payload?.simulationScenario ? `${humanize(payload.simulationScenario)} state observation` : 'State observation'; }
function humanize(value='') { return String(value).replace(/[-_]/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase()); }
function formatChainTime(value) { const number=Number(value); if(!number)return '—'; return new Date(number < 1e12 ? number*1000:number).toLocaleString('en-GB'); }
function linePath(values,min,max) { if(!values.length)return ''; return values.map((v,i)=>`${i?'L':'M'} ${(i/Math.max(1,values.length-1))*1000} ${165-((v-min)/(max-min))*140}`).join(' '); }
function areaPath(values,min,max) { const line=linePath(values,min,max); return line ? `${line} L 1000 180 L 0 180 Z` : ''; }
