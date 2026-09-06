/** WHA-1388: data-only contract. No connections, accounts, grants or executable entrypoint. */
export const PHARMACY_DEMO_VERSION = 'pharmacy-demo-v1' as const;
export const PRODUCT_BASE = '37906386a59700ce4a168e410ca68594baa97c75';
export const SCHEMA_SHA256 = 'ea8f40a29b95fcba8abfe7a41344402765f1efde5fff9e60f8faccb6a28608a5';
export const MIGRATIONS_SHA256 = 'c500a70d3ef973afe9a2192421ac0335a1436695f02cc41ab3caab74f28d5024';

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
  key: string;
  model: string;
  id: string;
  expectedHash: string;
  expectedFacts: Record<string, DemoFact>;
};
/** Helpers export their own planner/executor with genuine service/transaction types.
 * This contract deliberately does not invent a transaction or an execution adapter.
 * Plans are bounded to <=100 records/lane and use namespace-prefixed IDs/keys.
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
  | { status: 'applied' | 'replayed'; records: DemoPlannedRecord[]; gaps: DemoGap[] };

/** Non-secret, manually supplied observations. NOT a live authorization credential. */
export type PharmacyDemoEvidence = {
  version: typeof PHARMACY_DEMO_VERSION;
  target: {
    environment: 'lan' | 'azure-staging' | 'disposable';
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
    environment: 'lan' | 'azure-staging' | 'disposable';
    observedAt: string;
    organizationId: string;
    vertical: 'PHARMACY';
    organizationActive: true;
    branchId: string;
    branchActive: true;
    currency: 'PKR';
    timezone: string;
    owners: { userId: string; email: 'owner@chaichowk.pk'; active: true; role: 'ADMIN'; branchIds: string[]; capabilities: string[] }[];
    runtimeRole: { superuser: false; bypassRls: false; forceRls: true };
    schemaSha256: string;
    migrationsSha256: string;
    migrationCount: 106;
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
