export interface TwinEvent {
  eventId: string;
  twinId: string;
  eventType: number;
  revisionBefore: number;
  revisionAfter: number;
  actorDid: string;
  payloadRef: string;
  payloadHash: string;
  createdAt: number;
  transactionDigest?: string;
}

export interface TwinRoleGrant {
  twinId?: string;
  subjectDid: string;
  roleType: string | number;
  validFrom?: number;
  validTo?: number;
}

export interface IdentifierLookupResult {
  twinId: string;
  identifier: unknown;
}

export interface ObjectIdAdapter {
  initialize?(): Promise<void>;
  isReady(): Promise<boolean>;
  getTwin(id: string): Promise<unknown>;
  createTwin(input: unknown): Promise<unknown>;
  updateTwin(id: string, input: unknown): Promise<unknown>;
  publishState(twinId: string, input: unknown): Promise<unknown>;
  addDataset(twinId: string, input: unknown): Promise<unknown>;
  addAspect(twinId: string, input: unknown): Promise<unknown>;
  addInterface(twinId: string, input: unknown): Promise<unknown>;
  addModel(twinId: string, input: unknown): Promise<unknown>;
  addIdentifier(twinId: string, input: unknown): Promise<unknown>;
  addIdentifierMapping(twinId: string, input: unknown): Promise<unknown>;
  addRelation(twinId: string, input: unknown): Promise<unknown>;
  createComposition(twinId: string, input: unknown): Promise<unknown>;
  emitTwinEvent(twinId: string, input: unknown): Promise<unknown>;
  getTwinEvents(twinId: string): Promise<TwinEvent[]>;
  getDigitalThread(twinId: string): Promise<TwinEvent[]>;
  createMaturityAssessment(twinId: string, input: unknown): Promise<unknown>;
  getTwinChildren(twinId: string, moveType: string): Promise<unknown[]>;
  getTwinRoleGrants(twinId: string): Promise<TwinRoleGrant[]>;
  findTwinByIdentifier(scheme: string, value: string): Promise<IdentifierLookupResult | null>;
  findMutationByIdempotencyKey(twinId: string, key: string): Promise<boolean | undefined>;
  findIdentifierMappings?(identifierId: string): Promise<unknown[]>;
  transactionExists?(digest: string): Promise<boolean | undefined>;
  getIndexerCheckpoint?(): Promise<{ checkpoint: string | number; updatedAt?: string } | null>;
  resumeIndexer?(): Promise<void>;
  rebuildIndexer?(): Promise<void>;
  findIndexedTwinEvents?(twinId: string, options: {
    cursor?: string; limit?: number; fromRevision?: number; toRevision?: number;
    eventTypes?: number[]; fromTimestamp?: number; toTimestamp?: number;
  }): Promise<{ items: TwinEvent[]; nextCursor?: string; hasMore: boolean; complete?: boolean; reason?: string }>;
}
