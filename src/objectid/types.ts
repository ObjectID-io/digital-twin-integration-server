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
  referencedState?: TwinStateEvidence;
}

export interface TwinStateEvidence {
  objectId: string;
  aspectCode: string;
  sampleType: string;
  sourceUri: string;
  payloadHash: string;
  payloadUri: string;
  payloadInline: string;
  payload?: unknown;
  observedAt: number;
  validFrom: number;
  validTo: number;
  qualityScore: number;
  creatorDid: string;
  superseded: boolean;
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

export interface DidTwinSummary {
  twinId: string;
  name: string;
  description: string;
  lifecycleState?: number;
  revision?: number;
  roles: Array<"owner" | "creator" | "steward" | "twin">;
}

export interface SubscriptionStatus {
  objectId: string;
  customerId: string;
  ownerControllerId?: string;
  controllerId: string;
  plan: { code: number; name: "base" | "advanced" | "pro" | "enterprise" | "unknown" };
  status: { code: number; name: "active" | "suspended" | "cancelled" | "unknown" };
  periodStart: string;
  periodEnd: string;
  twinLimit: string;
  activeTwinCount: string;
  remainingTwins: string;
  creditLimit: string;
  creditsUsed: string;
  remainingCredits: string;
  current: boolean;
  updatedAt: string;
}

export interface AccountingContext {
  tenantId: string;
  customerId: string;
  ownerDid: string;
  subscriptionId: string;
}

export interface ObjectIdAdapter {
  provisionFreeTestnetSubscription?(ownerDid: string, customerId: string, periodDays: number): Promise<{ subscriptionId: string; digest: string }>;
  renewFreeTestnetSubscription?(subscriptionId: string, periodDays: number): Promise<{ digest: string }>;
  initialize?(): Promise<void>;
  getSubscription?(accounting?: AccountingContext): Promise<SubscriptionStatus>;
  isReady(): Promise<boolean>;
  getTwin(id: string): Promise<unknown>;
  findTwinsByDid(did: string): Promise<DidTwinSummary[]>;
  createTwin(input: unknown, accounting?: AccountingContext): Promise<unknown>;
  deleteTwin?(id: string, accounting?: AccountingContext): Promise<unknown>;
  updateTwin(id: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  publishState(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  addDataset(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  addAspect(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  addInterface(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  addModel(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  addIdentifier(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  addIdentifierMapping(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  addRelation(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  createComposition(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  emitTwinEvent(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
  getTwinEvents(twinId: string): Promise<TwinEvent[]>;
  getDigitalThread(twinId: string): Promise<TwinEvent[]>;
  createMaturityAssessment(twinId: string, input: unknown, accounting?: AccountingContext): Promise<unknown>;
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
