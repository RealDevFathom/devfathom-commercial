/** WHA-1388: data-only contract. No connections, accounts, grants or executable entrypoint. */
export const PHARMACY_DEMO_VERSION = 'pharmacy-demo-v1' as const;
export const PRODUCT_BASE = '37906386a59700ce4a168e410ca68594baa97c75';
export const SCHEMA_SHA256 = 'a1b54cecbe2a34b292496d13a669ef96382c7ec9bdb677e06e2b5084e595a4c0';
export const MIGRATIONS_SHA256 = '48e8e0d45eda22277fe7fe74c6e9283a9bed78721713a0db5b3dae3ab7a539da';
export const MIGRATION_COUNT = 150 as const;

/** Real SQL execution is confined to a newly created, private TEST cluster.
 * These identifiers select existing fixtures; they never grant authority. */
export type DisposablePharmacyTarget = {
  directory: string;
  database: string;
};
export type PharmacyDraftRequest = {
  organizationId: string;
  branchId: string;
  ownerUserId: string;
  actorUserId: string;
  supplierId: string;
  medicineId: string;
  presentationId: string;
  packLevelId: string;
  businessDate: string;
  scenarioAt: string;
  timezone: string;
  currency: 'PKR';
  /** Existing, namespaced TEST prerequisites; never provisioned by the runner. */
  integration?: {
    goodsReceiptId: string;
    stockLocationId: string;
    deviceId: string;
    drawerSessionId: string;
    cashReceivedMinor: number;
  };
};
export type PharmacyDraftOptions = {
  /** Omission means a real read-only database observation. */
  apply?: { reviewedDigest: string; expiresAt: string };
};

/** Canonical target namespace. Every lane consumes it unchanged; no lane-local prefix rewrite. */
export function isPharmacyDemoNamespace(value: unknown): value is string {
  return typeof value === 'string' && /^phdemo_[a-f0-9]{24}_$/.test(value);
}

export type DemoLane = 'inventory' | 'finance' | 'retention';
export type DemoFact = string | number | boolean | null;
export type DemoReference = {
  kind: 'medicine' | 'presentation' | 'pack' | 'location' | 'supplier';
  id: string;
  organizationId: string;
  branchId: string;
  approved: true;
  observedHash: string;
};
export type DemoActor = {
  userId: string;
  actorId: string;
  organizationId: string;
  branchId: string;
  active: true;
  synthetic: true;
  capabilities: string[];
};
export type PharmacyDemoContext = {
  organizationId: string;
  branchId: string;
  ownerUserId: string;
  namespace: string;
  businessDate: string;
  scenarioAt: string;
  timezone: string;
  currency: 'PKR';
  actors: DemoActor[];
  references: DemoReference[];
  /** Observed effective entitlement facts; never requested grants. */
  modules: { key: string; enabled: boolean }[];
};
export type DemoGap = {
  function: string;
  status: 'UNSEEDED' | 'OWNER-INPUT' | 'DRAFT-ONLY';
  reason: string;
};
export type DemoPlannedRecord = {
  /** Deterministic namespaced logical key, never a database ID. */
  key: string;
  model: string;
  /** Namespaced business reference supported by the owning service. */
  reference: string;
  expectedHash: string;
  expectedFacts: Record<string, DemoFact>;
};
/** Populated only from persisted service results and retained receipt observation. */
export type DemoObservedRecord = {
  planKey: string;
  model: string;
  persistedId: string;
  receiptReference: string;
  observedHash: string;
  observedFacts: Record<string, DemoFact>;
};
/** Helpers export their own planner/executor with genuine service/transaction types.
 * This contract deliberately does not invent a transaction or an execution adapter.
 * Plans are bounded to <=100 records/lane and use namespace-prefixed keys/references.
 * Service-generated IDs are observed after execution; plans never prescribe them.
 * Helpers must independently validate their actual service prerequisites.
 */
export type PharmacyDemoPlan = {
  lane: DemoLane;
  namespace: string;
  digest: string;
  records: DemoPlannedRecord[];
  gaps: DemoGap[];
};
export type PharmacyDemoResult =
  | { status: 'refused'; unmetPrerequisites: string[] }
  | { status: 'applied' | 'replayed'; records: DemoObservedRecord[]; gaps: DemoGap[] };

/** Non-secret, manually supplied observations. NOT a live authorization credential. */
export type PharmacyDemoEvidence = {
  version: typeof PHARMACY_DEMO_VERSION;
  target: {
    environment: 'lan' | 'staging' | 'disposable';
    targetKey: string;
    organizationId: string;
    branchId: string;
    ownerUserId: string;
    vertical: 'PHARMACY';
    currency: 'PKR';
    timezone: string;
    businessDate: string;
    scenarioAt: string;
    namespace: string;
  };
  observed: {
    targetKey: string;
    environment: 'lan' | 'staging' | 'disposable';
    observedAt: string;
    organizationId: string;
    vertical: 'PHARMACY';
    organizationActive: true;
    branchId: string;
    branchActive: true;
    currency: 'PKR';
    timezone: string;
    owners: {
      userId: string;
      email: 'owner@chaichowk.pk';
      active: true;
      role: 'ADMIN';
      branchIds: string[];
      capabilities: string[];
    }[];
    runtimeRole: { superuser: false; bypassRls: false; forceRls: true };
    schemaSha256: string;
    migrationsSha256: string;
    migrationCount: typeof MIGRATION_COUNT;
    actors: DemoActor[];
    references: DemoReference[];
    modules: { key: string; enabled: boolean }[];
  };
  confirmation: {
    workspaceConfirmed: true;
    approvalReference: string;
    /** SHA256 of canonical {version,target,observed,history}; no self-hashing. */
    evidenceDigest: string;
    expiresAt: string;
  };
  /** Absence is evidence only, never authority to recreate a namespace. */
  history: {
    namespace: string;
    receiptPresent: boolean;
    tombstonePresent: boolean;
    namespaceRecordCount: number;
  };
};
