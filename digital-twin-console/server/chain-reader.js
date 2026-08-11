import { getFullnodeUrl, IotaClient } from "@iota/iota-sdk/client";

export class ChainReader {
  constructor({ network, rpcUrl, graphqlUrl, packageId }) {
    this.network = network;
    this.graphqlUrl = graphqlUrl;
    this.packageId = packageId;
    this.client = new IotaClient({ url: rpcUrl || getFullnodeUrl(network) });
  }

  async listTwinsByDid(did) {
    const addresses = await this.addressesByType(`${this.packageId}::oid_twin::OIDTwin`);
    const objects = await mapLimited(addresses, 8, (id) => this.object(id));
    return objects.flatMap((raw) => summaryForDid(raw, did) ?? []);
  }

  async twinSummaryForDid(twinId, did) {
    return summaryForDid(await this.object(twinId), did);
  }

  async dashboard(twinId) {
    const twin = await this.object(twinId);
    const [events, identifiers] = await Promise.all([
      this.children(twinId, "OIDTwinEvent", eventOf),
      this.children(twinId, "OIDTwinIdentifier", (value) => value),
    ]);
    events.sort((a, b) => a.revisionAfter - b.revisionAfter || a.createdAt - b.createdAt);
    await mapLimited(events, 6, async (event) => {
      if (event.eventType !== 30 || !isObjectId(event.payloadRef)) return;
      try {
        const state = await this.object(event.payloadRef);
        if (String(state.data.type ?? "").endsWith("::oid_twin::OIDTwinState")) event.referencedState = stateOf(state);
      } catch { /* The event is still valid evidence when its reference is unavailable. */ }
    });
    return { twin, events, identifiers };
  }

  async children(owner, moveType, transform) {
    const addresses = await this.addressesByType(`${this.packageId}::oid_twin::${moveType}`, owner);
    const objects = await mapLimited(addresses, 8, (id) => this.object(id));
    return objects.map(transform);
  }

  async object(id) {
    const response = await this.client.getObject({ id, options: { showContent: true, showType: true, showPreviousTransaction: true } });
    if (!response.data || response.error) throw new Error(`IOTA object ${id} is unavailable`);
    return response;
  }

  async ownedObjects(owner) {
    const objects = [];
    let cursor;
    do {
      const page = await this.client.getOwnedObjects({ owner, cursor, limit: 50, options: { showType: true, showContent: true } });
      objects.push(...page.data);
      cursor = page.hasNextPage ? page.nextCursor : undefined;
    } while (cursor);
    return objects;
  }

  async addressesByType(type, owner) {
    if (!this.graphqlUrl) throw new Error("IOTA_GRAPHQL_URL is required for chain-only discovery");
    const query = `query ($type: String!, $after: String, $owner: IotaAddress) {
      objects(filter: { type: $type, owner: $owner }, first: 50, after: $after) {
        edges { node { address } }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const addresses = [];
    let after = null;
    do {
      const response = await fetch(this.graphqlUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { type, owner: owner || null, after } }),
        signal: AbortSignal.timeout(12_000),
      });
      const body = await response.json();
      if (!response.ok || body.errors) throw new Error(body.errors?.[0]?.message || `IOTA GraphQL returned ${response.status}`);
      const page = body.data?.objects;
      addresses.push(...(page?.edges ?? []).map((edge) => String(edge.node?.address ?? "")).filter(Boolean));
      after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return addresses;
  }
}

function fieldsOf(value) { return value?.data?.content?.dataType === "moveObject" ? value.data.content.fields : {}; }

function eventOf(raw) {
  const fields = fieldsOf(raw);
  return {
    eventId: raw.data.objectId, twinId: String(fields.twin_id ?? ""), eventType: Number(fields.event_type ?? 0),
    revisionBefore: Number(fields.revision_before ?? 0), revisionAfter: Number(fields.revision_after ?? 0),
    actorDid: String(fields.actor_did ?? ""), payloadRef: String(fields.payload_ref ?? ""),
    payloadHash: String(fields.payload_hash ?? ""), createdAt: Number(fields.created_at ?? 0),
    transactionDigest: raw.data.previousTransaction ?? undefined,
  };
}

function stateOf(raw) {
  const fields = fieldsOf(raw);
  const payloadInline = String(fields.payload_inline ?? "");
  let payload;
  try { payload = payloadInline ? JSON.parse(payloadInline) : undefined; } catch { payload = payloadInline || undefined; }
  return {
    objectId: raw.data.objectId, aspectCode: String(fields.aspect_code ?? ""), sampleType: String(fields.sample_type ?? ""),
    sourceUri: String(fields.source_uri ?? ""), payloadHash: String(fields.payload_hash ?? ""), payloadUri: String(fields.payload_uri ?? ""),
    payloadInline, payload, observedAt: Number(fields.observed_at ?? 0), validFrom: Number(fields.valid_from ?? 0),
    validTo: Number(fields.valid_to ?? 0), qualityScore: Number(fields.quality_score ?? 0), creatorDid: String(fields.creator_did ?? ""),
    superseded: Boolean(fields.superseded),
  };
}

async function mapLimited(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor++; results[index] = await mapper(values[index], index); }
  }));
  return results;
}

function optionalNumber(value) { const number = Number(value); return value === undefined || !Number.isFinite(number) ? undefined : number; }
function isObjectId(value) { return /^0x[0-9a-f]{64}$/i.test(value); }

function summaryForDid(raw, did) {
  const fields = fieldsOf(raw);
  const roles = [
    ["owner", fields.owner_did], ["creator", fields.creator_did],
    ["steward", fields.steward_did], ["twin", fields.twin_did],
  ].filter(([, value]) => String(value ?? "").trim() === did).map(([role]) => role);
  return roles.length ? {
    twinId: raw.data.objectId, name: String(fields.name ?? ""), description: String(fields.description ?? ""),
    lifecycleState: optionalNumber(fields.lifecycle_state), revision: optionalNumber(fields.revision), roles,
  } : null;
}
