import type { IdentifierLookupResult, ObjectIdAdapter, TwinEvent, TwinRoleGrant } from "../../src/objectid/types.js";

export class FakeObjectIdAdapter implements ObjectIdAdapter {
  readonly twins = new Map<string, any>();
  readonly children = new Map<string, unknown[]>();
  readonly calls: Array<{ method: string; twinId?: string; input: unknown }> = [];
  readonly identifierIndex = new Map<string, IdentifierLookupResult>();
  readonly mutationReferences = new Set<string>();
  getDigitalThreadCalls = 0;
  private sequence = 0;
  async isReady() { return true; }
  async getTwin(id: string) { return this.twins.get(id) ?? null; }
  async createTwin(input: any) { const id = input.id ?? `0xtwin${++this.sequence}`; const twin = { id, ...input }; this.twins.set(id, twin); this.calls.push({ method: "createTwin", input }); return twin; }
  async updateTwin(id: string, input: any) { const twin = { ...(this.twins.get(id) ?? { id }), ...input }; this.twins.set(id, twin); this.calls.push({ method: "updateTwin", twinId: id, input }); return twin; }
  async publishState(twinId: string, input: unknown) { return this.record("publishState", twinId, input); }
  async addDataset(twinId: string, input: unknown) { return this.record("addDataset", twinId, input); }
  async addAspect(twinId: string, input: any) {
    const result = await this.record("addAspect", twinId, input);
    const key = `${twinId}:OIDTwinAspect`;
    this.children.set(key, [...(this.children.get(key) ?? []), { objectId: result.id, fields: snakeFields(input) }]);
    return result;
  }
  async addInterface(twinId: string, input: unknown) { return this.record("addInterface", twinId, input); }
  async addModel(twinId: string, input: unknown) { return this.record("addModel", twinId, input); }
  async addIdentifier(twinId: string, input: unknown) { return this.record("addIdentifier", twinId, input); }
  async addIdentifierMapping(twinId: string, input: unknown) { return this.record("addIdentifierMapping", twinId, input); }
  async addRelation(twinId: string, input: unknown) { return this.record("addRelation", twinId, input); }
  async createComposition(twinId: string, input: unknown) { return this.record("createComposition", twinId, input); }
  async emitTwinEvent(twinId: string, input: unknown) { return this.record("emitTwinEvent", twinId, input); }
  async createMaturityAssessment(twinId: string, input: unknown) { return this.record("createMaturityAssessment", twinId, input); }
  async getTwinEvents(twinId: string) { return this.getTwinChildren(twinId, "OIDTwinEvent") as Promise<TwinEvent[]>; }
  async getDigitalThread(twinId: string) { this.getDigitalThreadCalls += 1; return (await this.getTwinEvents(twinId)).sort((a, b) => a.revisionAfter - b.revisionAfter); }
  async findIndexedTwinEvents(twinId: string, options: any = {}) {
    const source = (await this.getTwinEvents(twinId)).filter((event) =>
      (options.fromRevision === undefined || event.revisionAfter >= options.fromRevision)
      && (options.toRevision === undefined || event.revisionAfter <= options.toRevision)
      && (!options.eventTypes?.length || options.eventTypes.includes(event.eventType))
      && (options.fromTimestamp === undefined || event.createdAt >= options.fromTimestamp)
      && (options.toTimestamp === undefined || event.createdAt <= options.toTimestamp));
    const offset = options.cursor ? Number(Buffer.from(options.cursor, "base64url").toString()) : 0;
    const limit = Math.min(Number(options.limit ?? 100), 500);
    const items = source.slice(offset, offset + limit);
    const hasMore = offset + items.length < source.length;
    return { items, hasMore, nextCursor: hasMore ? Buffer.from(String(offset + items.length)).toString("base64url") : undefined, complete: true };
  }
  async getTwinChildren(twinId: string, moveType: string) { return this.children.get(`${twinId}:${moveType}`) ?? []; }
  async getTwinRoleGrants(twinId: string): Promise<TwinRoleGrant[]> {
    const configured = this.children.get(`${twinId}:OIDTwinRoleGrant`) as TwinRoleGrant[] | undefined;
    return configured ?? [{ twinId, subjectDid: "local-development", roleType: "OWNER" }];
  }
  async findTwinByIdentifier(scheme: string, value: string) { return this.identifierIndex.get(`${scheme.toLowerCase()}:${value}`) ?? null; }
  async findMutationByIdempotencyKey(twinId: string, key: string) { return this.mutationReferences.has(`${twinId}:${key}`); }
  setChildren(twinId: string, moveType: string, values: unknown[]) { this.children.set(`${twinId}:${moveType}`, values); }
  private async record(method: string, twinId: string, input: unknown) {
    const record = asRecord(input);
    if (record.externalReference) this.mutationReferences.add(`${twinId}:${record.externalReference}`);
    const result = { id: `0xchild${++this.sequence}`, twinId, ...record };
    this.calls.push({ method, twinId, input });
    return result;
  }
}

function asRecord(value: unknown) { return value && typeof value === "object" ? value as Record<string, unknown> : { value }; }
function snakeFields(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), item]));
}
