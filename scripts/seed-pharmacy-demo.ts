/** Offline evidence and fenced disposable SQL runner. Never loads dotenv or live credentials. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import {
  MIGRATIONS_SHA256,
  PHARMACY_DEMO_VERSION,
  SCHEMA_SHA256,
  isPharmacyDemoNamespace,
  type DemoGap,
  type DemoObservedRecord,
  type DemoPlannedRecord,
  type PharmacyDemoEvidence,
  type DisposablePharmacyTarget,
  type PharmacyDraftRequest,
  type PharmacyDraftOptions,
} from './pharmacy-demo-contract';

export class PharmacyDemoRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PharmacyDemoRefusal';
  }
}
function requireFact(value: unknown, code: string): asserts value {
  if (!value) throw new PharmacyDemoRefusal(code);
}
function object(value: unknown, keys: string): Record<string, unknown> {
  requireFact(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'INVALID_EVIDENCE'
  );
  const result = value as Record<string, unknown>;
  const expected = keys ? keys.split(' ') : [];
  requireFact(
    Object.keys(result).length === expected.length &&
      expected.every((key) => Object.hasOwn(result, key)),
    'INVALID_EVIDENCE_KEYS'
  );
  return result;
}
function list(value: unknown, max = 100): unknown[] {
  requireFact(Array.isArray(value) && value.length <= max, 'INVALID_EVIDENCE_LIST');
  return value;
}
function token(value: unknown): asserts value is string {
  requireFact(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value),
    'INVALID_EVIDENCE_TOKEN'
  );
}
function tokens(value: unknown): string[] {
  const values = list(value);
  values.forEach(token);
  requireFact(new Set(values).size === values.length, 'AMBIGUOUS_EVIDENCE');
  return values as string[];
}
function instant(value: unknown): number {
  requireFact(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
    'INVALID_INSTANT'
  );
  const result = Date.parse(value);
  requireFact(
    Number.isFinite(result) && new Date(result).toISOString() === value,
    'INVALID_INSTANT'
  );
  return result;
}
function hash(value: unknown): void {
  requireFact(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_DIGEST');
}
/** Validate an already observed mapping; this never establishes live provenance or writes a receipt. */
export function validateObservedMapping(
  plan: DemoPlannedRecord,
  observed: DemoObservedRecord
): DemoObservedRecord {
  requireFact(
    observed.planKey === plan.key && observed.model === plan.model,
    'OBSERVED_PLAN_MISMATCH'
  );
  token(observed.persistedId);
  token(observed.receiptReference);
  hash(observed.observedHash);
  requireFact(
    observed.observedHash === plan.expectedHash &&
      canonical(observed.observedFacts) === canonical(plan.expectedFacts),
    'OBSERVED_FACTS_MISMATCH'
  );
  return structuredClone(observed);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export function evidenceDigest(
  evidence: Pick<PharmacyDemoEvidence, 'version' | 'target' | 'observed' | 'history'>
): string {
  return createHash('sha256')
    .update(
      canonical({
        version: evidence.version,
        target: evidence.target,
        observed: evidence.observed,
        history: evidence.history,
      })
    )
    .digest('hex');
}
/** Stable across dates, owner changes and package revisions: history cannot be escaped by renaming. */
export function targetNamespace(
  target: Pick<
    PharmacyDemoEvidence['target'],
    'environment' | 'targetKey' | 'organizationId' | 'branchId'
  >
): string {
  return `phdemo_${createHash('sha256')
    .update(
      canonical([target.environment, target.targetKey, target.organizationId, target.branchId])
    )
    .digest('hex')
    .slice(0, 24)}_`;
}

export function validateEvidence(input: unknown, now: Date): PharmacyDemoEvidence {
  requireFact(Number.isFinite(now.getTime()), 'INVALID_CLOCK');
  const e = object(input, 'version target observed confirmation history');
  requireFact(e.version === PHARMACY_DEMO_VERSION, 'PACKAGE_MISMATCH');
  const t = object(
    e.target,
    'environment targetKey organizationId branchId ownerUserId vertical currency timezone businessDate scenarioAt namespace'
  );
  const o = object(
    e.observed,
    'targetKey environment observedAt organizationId vertical organizationActive branchId branchActive currency timezone owners runtimeRole schemaSha256 migrationsSha256 migrationCount actors references modules'
  );
  requireFact(
    ['lan', 'azure-staging', 'disposable'].includes(t.environment as string) &&
      o.environment === t.environment,
    'UNSAFE_ENVIRONMENT'
  );
  for (const key of [
    'targetKey',
    'organizationId',
    'branchId',
    'ownerUserId',
    'timezone',
    'namespace',
  ])
    token(t[key]);
  requireFact(
    t.vertical === 'PHARMACY' && o.vertical === 'PHARMACY' && o.organizationActive === true,
    'APPROVED_PHARMACY_REQUIRED'
  );
  for (const key of ['targetKey', 'organizationId', 'branchId', 'currency', 'timezone'])
    requireFact(t[key] === o[key], 'TARGET_OBSERVATION_MISMATCH');
  requireFact(t.currency === 'PKR', 'CURRENCY_MISMATCH');
  requireFact(o.branchActive === true, 'ACTIVE_BRANCH_REQUIRED');
  const scenario = instant(t.scenarioAt);
  requireFact(
    typeof t.businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.businessDate),
    'INVALID_BUSINESS_DATE'
  );
  let businessDate: string;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: t.timezone as string,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(scenario));
    const part = (name: string) => parts.find((p) => p.type === name)?.value;
    businessDate = `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    throw new PharmacyDemoRefusal('INVALID_TIMEZONE');
  }
  requireFact(businessDate === t.businessDate, 'BUSINESS_DATE_MISMATCH');
  const observedAt = instant(o.observedAt);
  requireFact(
    observedAt <= now.getTime() && now.getTime() - observedAt <= 3_600_000,
    'STALE_OBSERVATION'
  );
  const role = object(o.runtimeRole, 'superuser bypassRls forceRls');
  requireFact(
    role.superuser === false && role.bypassRls === false && role.forceRls === true,
    'UNSAFE_RUNTIME_ROLE'
  );
  requireFact(
    o.schemaSha256 === SCHEMA_SHA256 &&
      o.migrationsSha256 === MIGRATIONS_SHA256 &&
      o.migrationCount === 106,
    'SCHEMA_MISMATCH'
  );
  const owners = list(o.owners, 2);
  requireFact(owners.length === 1, 'OWNER_MISSING_OR_AMBIGUOUS');
  const owner = object(owners[0], 'userId email active role branchIds capabilities');
  requireFact(
    owner.userId === t.ownerUserId &&
      owner.email === 'owner@chaichowk.pk' &&
      owner.active === true &&
      owner.role === 'ADMIN',
    'EXISTING_OWNER_REQUIRED'
  );
  requireFact(tokens(owner.branchIds).includes(t.branchId as string), 'OWNER_BRANCH_UNASSIGNED');
  const capabilities = tokens(owner.capabilities);
  requireFact(
    ['reports:operational', 'reports:financial'].every((c) => capabilities.includes(c)),
    'OWNER_CAPABILITY_MISSING'
  );
  const actors = list(o.actors, 10).map((value) => {
    const actor = object(
      value,
      'userId actorId organizationId branchId active synthetic capabilities'
    );
    token(actor.userId);
    token(actor.actorId);
    tokens(actor.capabilities);
    requireFact(
      actor.organizationId === t.organizationId &&
        actor.branchId === t.branchId &&
        actor.active === true &&
        actor.synthetic === true &&
        actor.userId !== t.ownerUserId,
      'SYNTHETIC_ACTOR_PREREQUISITE'
    );
    return actor;
  });
  requireFact(
    new Set(actors.map((a) => a.actorId)).size === actors.length &&
      new Set(actors.map((a) => a.userId)).size === actors.length,
    'AMBIGUOUS_ACTORS'
  );
  const refs = list(o.references).map((value) => {
    const ref = object(value, 'kind id organizationId branchId approved observedHash');
    token(ref.id);
    hash(ref.observedHash);
    requireFact(
      ['medicine', 'presentation', 'pack', 'location', 'supplier'].includes(ref.kind as string) &&
        ref.organizationId === t.organizationId &&
        ref.branchId === t.branchId &&
        ref.approved === true,
      'REFERENCE_PREREQUISITE'
    );
    return `${ref.kind}:${ref.id}`;
  });
  requireFact(new Set(refs).size === refs.length, 'AMBIGUOUS_REFERENCES');
  const modules = list(o.modules).map((value) => {
    const module = object(value, 'key enabled');
    token(module.key);
    requireFact(typeof module.enabled === 'boolean', 'INVALID_MODULE_FACT');
    return module;
  });
  requireFact(new Set(modules.map((m) => m.key)).size === modules.length, 'AMBIGUOUS_MODULES');
  const h = object(e.history, 'namespace receiptPresent tombstonePresent namespaceRecordCount');
  requireFact(
    h.namespace === t.namespace &&
      typeof h.receiptPresent === 'boolean' &&
      typeof h.tombstonePresent === 'boolean' &&
      Number.isSafeInteger(h.namespaceRecordCount) &&
      (h.namespaceRecordCount as number) >= 0,
    'INVALID_HISTORY'
  );
  const c = object(e.confirmation, 'workspaceConfirmed approvalReference evidenceDigest expiresAt');
  requireFact(c.workspaceConfirmed === true, 'WORKSPACE_UNCONFIRMED');
  token(c.approvalReference);
  hash(c.evidenceDigest);
  const expiry = instant(c.expiresAt);
  requireFact(
    expiry > now.getTime() && expiry > observedAt && expiry - observedAt <= 3_600_000,
    'EXPIRED_OR_UNBOUNDED_CONFIRMATION'
  );
  const evidence = input as PharmacyDemoEvidence;
  requireFact(isPharmacyDemoNamespace(t.namespace), 'NAMESPACE_MISMATCH');
  requireFact(t.namespace === targetNamespace(evidence.target), 'NAMESPACE_MISMATCH');
  requireFact(c.evidenceDigest === evidenceDigest(evidence), 'CONFIRMATION_DIGEST_MISMATCH');
  return evidence;
}

/** Always precedes coverage planning. Existing history cannot be re-seeded by this package. */
export function reconcileHistory(history: PharmacyDemoEvidence['history']): void {
  requireFact(history.receiptPresent === history.tombstonePresent, 'RECEIPT_TOMBSTONE_INCOMPLETE');
  requireFact(!history.receiptPresent, 'EXISTING_RECEIPT_RECONCILIATION_REQUIRED');
  requireFact(history.namespaceRecordCount === 0, 'NAMESPACE_COLLISION');
}

const COVERAGE: DemoGap[] = [
  {
    function: 'catalog/presentations/packs',
    status: 'OWNER-INPUT',
    reason: 'Existing pre-approved references required; no fabricated registered medicines.',
  },
  {
    function: 'purchasing/receiving/stock/transfers/counts',
    status: 'UNSEEDED',
    reason: 'Reviewed inventory helper not integrated; no stock ledger mutation.',
  },
  {
    function: 'sales/returns/payments/khata',
    status: 'UNSEEDED',
    reason: 'Reviewed finance helper and approved fiscal facts required.',
  },
  {
    function: 'bookkeeping/settlements/bank-reconciliation',
    status: 'UNSEEDED',
    reason: 'No posted journals, balances or settlement fixtures.',
  },
  {
    function: 'operational/financial/growth reports',
    status: 'UNSEEDED',
    reason: 'No observed report results; draft records cannot prove revenue.',
  },
  {
    function: 'retention/loyalty/refills/campaigns',
    status: 'UNSEEDED',
    reason: 'Reviewed retention helper not integrated; no patient data or deliveries.',
  },
  {
    function: 'prescriptions/dispensing/controlled-drugs',
    status: 'OWNER-INPUT',
    reason: 'Real authorized clinical prerequisites required; no approver impersonation.',
  },
  {
    function: 'safety/recalls/temperature/regulatory',
    status: 'OWNER-INPUT',
    reason: 'Real approved safety evidence required; no simulated clinical approval.',
  },
  {
    function: 'providers/catalog-crawl/fiscal/email/SMS',
    status: 'OWNER-INPUT',
    reason: 'External effects disabled; D07/D08/D11 remain owner-gated.',
  },
  {
    function: 'hardware/printing/branch-receipt permissions/first-sale',
    status: 'OWNER-INPUT',
    reason: '1354/1364 and real-input acceptance remain separately owner-gated.',
  },
];

export function dryRun(input: unknown, now = new Date()) {
  const evidence = validateEvidence(input, now);
  reconcileHistory(evidence.history);
  const referenceKinds = ['medicine', 'presentation', 'pack', 'location', 'supplier'] as const;
  const requiredModules = ['pharmacy-inventory', 'pharmacy-reports'];
  return {
    mode: 'offline-evidence-dry-run' as const,
    evidenceDigest: evidenceDigest(evidence),
    liveTargetVerified: false,
    applyEnabled: false,
    writes: 0,
    plannedRecords: 0,
    unmetPrerequisites: {
      references: referenceKinds.filter(
        (kind) => !evidence.observed.references.some((ref) => ref.kind === kind)
      ),
      modules: requiredModules.filter(
        (key) => !evidence.observed.modules.some((module) => module.key === key && module.enabled)
      ),
      syntheticActors:
        evidence.observed.actors.length === 0
          ? 'OWNER-INPUT'
          : 'SERVICE_CAPABILITIES_NOT_YET_VERIFIED',
    },
    coverage: structuredClone(COVERAGE),
    applyBlockers: [
      'LIVE_OBSERVATION_ADAPTER_REQUIRED',
      'REVIEWED_HELPERS_REQUIRED',
      'DURABLE_RECEIPT_AND_TOMBSTONE_RECONCILIATION_REQUIRED',
      'SERVICE_CONCURRENCY_AND_RESUMPTION_PROOF_REQUIRED',
      'EXACT_PACKAGE_REVIEW_AND_SEPARATE_TARGET_APPROVAL_REQUIRED',
    ],
    receipt: { kind: 'dry-run-report', seedReceipt: false, retainWithReviewedEvidence: true },
  };
}

const RECEIPT_ACTION = 'pharmacy.demo.draft.receipt.v1';
const TOMBSTONE_ACTION = 'pharmacy.demo.draft.tombstone.v1';
const SQL_VERSION = 'pharmacy-demo-draft-sql-v1';
const RUNTIME_ROLE = 'wha1388_runtime';
const SQL_TABLES = [
  'organizations',
  'users',
  'organization_modules',
  'pharmacy_branches',
  'pharmacy_central_purchasing_access',
  'pharmacy_suppliers',
  'pharmacy_supplier_licences',
  'pharmacy_medicines',
  'pharmacy_presentations',
  'pharmacy_pack_levels',
  'pharmacy_purchase_orders',
  'pharmacy_purchase_order_lines',
  'audit_logs',
];

/** Includes every scalar returned by Prisma, including generated IDs and timestamps. */
export function pharmacyScalarHash(value: unknown): string {
  return createHash('sha256')
    .update(canonical(JSON.parse(JSON.stringify(value))))
    .digest('hex');
}

export async function pharmacySourceDigest(): Promise<string> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const files = [
    'scripts/pharmacy-demo-contract.ts',
    'scripts/seed-pharmacy-demo.ts',
    'scripts/seed-pharmacy-demo.test.ts',
    'scripts/verify-pharmacy-demo.ts',
    'docs/demo/pharmacy-seed-manifest.md',
  ];
  const digest = createHash('sha256');
  for (const file of files) digest.update(file + '\n').update(await readFile(join(root, file)));
  return digest.digest('hex');
}

export async function pharmacyMigrationManifest() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const names = (await readdir(join(root, 'prisma/migrations')))
    .filter((n) => /^\d/.test(n))
    .sort();
  const digest = createHash('sha256');
  const migrations = [];
  for (const name of names) {
    const path = `prisma/migrations/${name}/migration.sql`;
    const sql = await readFile(join(root, path));
    digest.update(path + '\n').update(sql);
    migrations.push({ name, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  requireFact(
    migrations.length === 106 &&
      digest.digest('hex') === MIGRATIONS_SHA256 &&
      createHash('sha256')
        .update(await readFile(join(root, 'prisma/schema.prisma')))
        .digest('hex') === SCHEMA_SHA256,
    'SCHEMA_SOURCE_MISMATCH'
  );
  return migrations;
}

let boundDisposable: string | undefined;
/** No arbitrary URL input. Private Unix socket + actual cluster/database/role checks below.
 * Only the fresh verifier provisions this TEST identity. LAN/Azure are unsupported. */
async function bindDisposable(target: DisposablePharmacyTarget) {
  object(target, 'directory database');
  requireFact(/^wha1388_[a-f0-9]{24}$/.test(target.database), 'DISPOSABLE_ID_REQUIRED');
  const directory = await realpath(target.directory);
  const parent = await realpath('/tmp');
  const info = await stat(directory);
  requireFact(
    directory === target.directory &&
      dirname(directory) === parent &&
      basename(directory).startsWith('wha1388-pg-') &&
      info.isDirectory() &&
      info.uid === process.getuid?.() &&
      (info.mode & 0o077) === 0,
    'PRIVATE_DISPOSABLE_REQUIRED'
  );
  requireFact(
    (await readFile(join(directory, 'cluster-id'), 'utf8')) === target.database,
    'DISPOSABLE_ID_MISMATCH'
  );
  const socket = join(directory, 'socket');
  requireFact((await realpath(socket)) === socket, 'PRIVATE_SOCKET_REQUIRED');
  const key = pharmacyScalarHash(target);
  if (boundDisposable) requireFact(boundDisposable === key, 'PROCESS_TARGET_ALREADY_BOUND');
  else {
    requireFact(
      !Object.hasOwn(process.env, 'DATABASE_URL') && !(globalThis as { prisma?: unknown }).prisma,
      'CLEAN_PROCESS_REQUIRED'
    );
    process.env.DATABASE_URL = `postgresql://${RUNTIME_ROLE}@localhost/${target.database}?host=${encodeURIComponent(socket)}`;
    boundDisposable = key;
  }
  return import('../src/lib/tenancy/scoped-db');
}

function draftNamespace(target: DisposablePharmacyTarget, request: PharmacyDraftRequest) {
  return targetNamespace({
    environment: 'disposable',
    targetKey: target.database,
    organizationId: request.organizationId,
    branchId: request.branchId,
  });
}

export function pharmacyHistoryPath(
  target: DisposablePharmacyTarget,
  request: PharmacyDraftRequest
) {
  return join(target.directory, `${draftNamespace(target, request)}operator-history.jsonl`);
}

export function pharmacyHistoryGenesis(
  target: DisposablePharmacyTarget,
  request: PharmacyDraftRequest
) {
  return { kind: 'genesis', database: target.database, namespace: draftNamespace(target, request) };
}

type RetainedRow = { model: string; id: string; hash: string };
type DraftReceipt = {
  version: string;
  namespace: string;
  sourceDigest: string;
  requestHash: string;
  planDigest: string;
  references: RetainedRow[];
  rows: RetainedRow[];
};

async function openHistory(
  target: DisposablePharmacyTarget,
  request: PharmacyDraftRequest,
  writable: boolean
) {
  const file = await open(
    pharmacyHistoryPath(target, request),
    (writable ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK
  );
  try {
    const info = await file.stat();
    requireFact(
      info.isFile() &&
        info.uid === process.getuid?.() &&
        (info.mode & 0o077) === 0 &&
        info.nlink === 1 &&
        info.size <= 65_536,
      'UNSAFE_OPERATOR_HISTORY'
    );
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireFact(
      bytesRead === info.size && bytesRead < buffer.length,
      'HISTORY_CHANGED_DURING_READ'
    );
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    requireFact(text.endsWith('\n'), 'PARTIAL_OPERATOR_HISTORY');
    const entries = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    requireFact(
      entries.length >= 1 &&
        entries.length <= 3 &&
        canonical(entries[0]) === canonical(pharmacyHistoryGenesis(target, request)),
      'FOREIGN_OPERATOR_HISTORY'
    );
    return { file, entries };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function assertSqlRuntime(
  tx: ScopedDb,
  target: DisposablePharmacyTarget,
  request: PharmacyDraftRequest
) {
  const [runtime] = await tx.$queryRawUnsafe<
    Array<{
      database: string;
      role: string;
      superuser: boolean;
      bypass: boolean;
      address: string | null;
      cluster: string;
      tenant: string;
      actor: string;
      platform: string;
      rowSecurity: string;
    }>
  >(`SELECT current_database() AS database, current_user AS role, r.rolsuper AS superuser,
      r.rolbypassrls AS bypass, inet_server_addr()::text AS address,
      current_setting('cluster_name') AS cluster,
      current_setting('app.current_organization_id') AS tenant,
      current_setting('app.current_user_id') AS actor,
      current_setting('app.is_platform_admin') AS platform,
      current_setting('row_security') AS "rowSecurity"
    FROM pg_roles r WHERE r.rolname=current_user`);
  requireFact(
    runtime &&
      runtime.database === target.database &&
      runtime.cluster === target.database &&
      runtime.role === RUNTIME_ROLE &&
      !runtime.superuser &&
      !runtime.bypass &&
      runtime.address === null &&
      runtime.tenant === request.organizationId &&
      runtime.actor === request.actorUserId &&
      runtime.platform === 'false' &&
      runtime.rowSecurity === 'on',
    'UNSAFE_ACTUAL_RUNTIME'
  );
  const tables = await tx.$queryRawUnsafe<
    Array<{ name: string; forced: boolean; enabled: boolean }>
  >(
    `SELECT relname AS name, relforcerowsecurity AS forced, relrowsecurity AS enabled
       FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])`,
    SQL_TABLES
  );
  requireFact(
    tables.length === SQL_TABLES.length && tables.every((t) => t.forced && t.enabled),
    'FORCED_RLS_REQUIRED'
  );
  const expected = await pharmacyMigrationManifest();
  const actual = await tx.$queryRawUnsafe<Array<{ name: string; checksum: string }>>(
    `SELECT migration_name AS name, checksum FROM _prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  );
  requireFact(canonical(actual) === canonical(expected), 'ACTUAL_MIGRATIONS_MISMATCH');
  return {
    role: runtime.role,
    superuser: runtime.superuser,
    bypassRls: runtime.bypass,
    forceRls: true,
  };
}

async function draftReferences(tx: ScopedDb, request: PharmacyDraftRequest) {
  const organizationId = request.organizationId;
  const userSelect = {
    id: true,
    organizationId: true,
    status: true,
    role: true,
    department: true,
    organizationRoleId: true,
  } as const;
  const organization = await tx.organization.findFirst({
    where: { id: organizationId },
    select: {
      id: true,
      vertical: true,
      status: true,
      currency: true,
      timezone: true,
    },
  });
  requireFact(
    organization?.vertical === 'PHARMACY' &&
      organization.status === 'ACTIVE' &&
      organization.currency === request.currency &&
      organization.timezone === request.timezone,
    'ACTUAL_PHARMACY_TARGET_REQUIRED'
  );
  // This TEST-only executable does not impersonate a live web session or owner email.
  const owners = await tx.user.findMany({
    where: { organizationId, role: 'ADMIN', status: 'ACTIVE' },
    select: userSelect,
  });
  requireFact(
    owners.length === 1 && owners[0].id === request.ownerUserId,
    'ACTUAL_OWNER_MISSING_OR_AMBIGUOUS'
  );
  const actor = await tx.user.findFirst({
    where: { id: request.actorUserId, organizationId },
    select: userSelect,
  });
  requireFact(
    actor?.status === 'ACTIVE' &&
      actor.id !== request.ownerUserId &&
      actor.department === 'wha1388-test-fixtures',
    'EXISTING_TEST_ACTOR_REQUIRED'
  );
  const grants = await tx.pharmacyCentralPurchasingAccess.findMany({
    where: { organizationId, userId: { in: [request.actorUserId, request.ownerUserId] } },
    orderBy: { id: 'asc' },
  });
  requireFact(
    [request.actorUserId, request.ownerUserId].every((id) =>
      grants.some((g) => g.userId === id && g.branchId === null)
    ),
    'ACTUAL_PURCHASING_CAPABILITY_REQUIRED'
  );
  const { resolveOrganizationEntitlements, hasModule } = await import('../src/lib/entitlements');
  const entitlements = await resolveOrganizationEntitlements(organizationId, tx);
  requireFact(
    hasModule(entitlements, 'pharmacy-procurement'),
    'ACTUAL_PROCUREMENT_ENTITLEMENT_REQUIRED'
  );
  const branch = await tx.pharmacyBranch.findFirst({
    where: { id: request.branchId, organizationId, active: true },
  });
  const supplier = await tx.pharmacySupplier.findFirst({
    where: { id: request.supplierId, organizationId, authorized: true, active: true },
  });
  const licences = await tx.pharmacySupplierLicence.findMany({
    where: {
      supplierId: request.supplierId,
      organizationId,
      verifiedAt: { not: null },
      expiresAt: { gt: new Date() },
    },
    orderBy: { id: 'asc' },
  });
  const medicine = await tx.medicine.findFirst({
    where: { id: request.medicineId, organizationId, saleable: true },
  });
  const presentation = await tx.presentation.findFirst({
    where: {
      id: request.presentationId,
      organizationId,
      medicineId: request.medicineId,
    },
  });
  const pack = await tx.packLevel.findFirst({
    where: {
      id: request.packLevelId,
      organizationId,
      presentationId: request.presentationId,
    },
  });
  requireFact(
    branch && supplier && licences.length && medicine && presentation && pack,
    'MISSING_OR_FOREIGN_REFERENCE'
  );
  // Single canonical-unit pack keeps this one-line draft bounded; no invented conversion tree.
  requireFact(
    pack.parentPackLevelId === null &&
      pack.unitsPerParent === 1 &&
      pack.effectiveFrom <= new Date(request.scenarioAt) &&
      (!pack.effectiveTo || pack.effectiveTo > new Date(request.scenarioAt)),
    'UNSUPPORTED_PACK_CONVERSION'
  );
  return [
    ['Organization', organization],
    ['Owner', owners[0]],
    ['Actor', actor],
    ['PharmacyBranch', branch],
    ['PharmacySupplier', supplier],
    ['Medicine', medicine],
    ['Presentation', presentation],
    ['PackLevel', pack],
    ...grants.map((g) => ['PharmacyCentralPurchasingAccess', g] as const),
    ...licences.map((l) => ['PharmacySupplierLicence', l] as const),
  ].map(([model, row]) => ({
    model: model as string,
    id: (row as { id: string }).id,
    hash: pharmacyScalarHash(row),
  }));
}

async function reconcileDraft(
  tx: ScopedDb,
  namespace: string,
  organizationId: string,
  entries: unknown[],
  requestHash: string,
  sourceDigest: string
) {
  const audit = await tx.auditLog.findMany({
    where: { organizationId, targetId: namespace },
    orderBy: { id: 'asc' },
  });
  const orders = await tx.pharmacyPurchaseOrder.findMany({
    where: { organizationId, reference: { startsWith: namespace } },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
  if (entries.length === 1) {
    requireFact(audit.length === 0 && orders.length === 0, 'UNRETAINED_NAMESPACE_COLLISION');
    return null;
  }
  requireFact(
    entries.length === 3 && audit.length === 2 && orders.length === 1,
    'PARTIAL_OR_REMOVED_HISTORY'
  );
  const intent = object(entries[1], 'kind requestHash sourceDigest planDigest');
  const prepared = object(entries[2], 'kind receipt audit');
  requireFact(
    intent.kind === 'intent' &&
      prepared.kind === 'prepared' &&
      intent.requestHash === requestHash &&
      intent.sourceDigest === sourceDigest,
    'PRIOR_PACKAGE_OR_CHANGED_REQUEST'
  );
  const receipt = prepared.receipt as DraftReceipt;
  requireFact(
    receipt.version === SQL_VERSION &&
      receipt.namespace === namespace &&
      receipt.requestHash === requestHash &&
      receipt.sourceDigest === sourceDigest &&
      intent.planDigest === receipt.planDigest,
    'FOREIGN_RECEIPT'
  );
  const actualAudit = audit.map((row) => ({
    model: 'AuditLog',
    id: row.id,
    hash: pharmacyScalarHash(row),
  }));
  requireFact(canonical(actualAudit) === canonical(prepared.audit), 'CHANGED_RECEIPT_OR_TOMBSTONE');
  const receiptRow = audit.find((row) => row.action === RECEIPT_ACTION);
  const tombstone = audit.find((row) => row.action === TOMBSTONE_ACTION);
  requireFact(
    receiptRow &&
      tombstone &&
      canonical(receiptRow.metadata) === canonical(receipt) &&
      canonical(tombstone.metadata) ===
        canonical({ receiptId: receiptRow.id, receiptHash: pharmacyScalarHash(receipt) }),
    'FOREIGN_RECEIPT'
  );
  const { lines, ...order } = orders[0];
  const rows = [
    { model: 'PharmacyPurchaseOrder', id: order.id, hash: pharmacyScalarHash(order) },
    ...lines.map((row) => ({
      model: 'PharmacyPurchaseOrderLine',
      id: row.id,
      hash: pharmacyScalarHash(row),
    })),
  ];
  requireFact(
    order.status === 'DRAFT' && lines.length === 1 && canonical(rows) === canonical(receipt.rows),
    'CHANGED_OR_REMOVED_DRAFT'
  );
  return receipt;
}

/** Genuine owning transaction, actual RLS observations, one service-created draft.
 * Exported only for the runnable disposable verifier; no helper integration or live apply. */
export async function runDisposablePharmacyDraft(
  target: DisposablePharmacyTarget,
  request: PharmacyDraftRequest,
  options: PharmacyDraftOptions = {}
) {
  object(
    request,
    'organizationId branchId ownerUserId actorUserId supplierId medicineId presentationId packLevelId businessDate scenarioAt timezone currency'
  );
  for (const value of Object.values(request)) token(value);
  requireFact(request.currency === 'PKR', 'CURRENCY_MISMATCH');
  const scenario = instant(request.scenarioAt);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: request.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(scenario));
  requireFact(date === request.businessDate, 'BUSINESS_DATE_MISMATCH');
  object(options, options.apply ? 'apply' : '');
  if (options.apply) {
    object(options.apply, 'reviewedDigest expiresAt');
    hash(options.apply.reviewedDigest);
    const expiry = instant(options.apply.expiresAt);
    requireFact(
      expiry > Date.now() && expiry <= Date.now() + 3_600_000,
      'EXPIRED_OR_UNBOUNDED_CONFIRMATION'
    );
  }
  const { withTenantDb } = await bindDisposable(target);
  const sourceDigest = await pharmacySourceDigest();
  const requestHash = pharmacyScalarHash(request);
  const namespace = draftNamespace(target, request);
  return withTenantDb(
    request.organizationId,
    async (tx) => {
      if (!options.apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const runtimeRole = await assertSqlRuntime(tx, target, request);
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', namespace);
      // Prevent concurrent prerequisite edits while the service and receipt execute.
      if (options.apply)
        await tx.$executeRawUnsafe(
          `LOCK TABLE ${SQL_TABLES.filter(
            (t) =>
              !['pharmacy_purchase_orders', 'pharmacy_purchase_order_lines', 'audit_logs'].includes(
                t
              )
          )
            .map((t) => `"${t}"`)
            .join(', ')} IN SHARE MODE`
        );
      const history = await openHistory(target, request, Boolean(options.apply));
      try {
        // Retained IDs and original hashes are checked BEFORE any dynamic reference planning.
        const prior = await reconcileDraft(
          tx,
          namespace,
          request.organizationId,
          history.entries,
          requestHash,
          sourceDigest
        );
        const references = await draftReferences(tx, request);
        if (prior)
          requireFact(canonical(prior.references) === canonical(references), 'CHANGED_REFERENCE');
        const planDigest = pharmacyScalarHash({
          version: SQL_VERSION,
          namespace,
          sourceDigest,
          requestHash,
          references,
        });
        if (options.apply)
          requireFact(options.apply.reviewedDigest === planDigest, 'REVIEWED_DIGEST_MISMATCH');
        const coverage = [
          {
            function: 'central purchase order',
            status: 'DRAFT-ONLY',
            reason: 'One synthetic draft, one line; no approval, sending, stock or revenue.',
          },
          ...COVERAGE,
        ];
        if (!options.apply || prior)
          return {
            mode: prior ? 'replayed' : 'database-dry-run',
            writes: 0,
            planDigest,
            namespace,
            sourceDigest,
            runtimeRole,
            receipt: prior,
            coverage,
            liveApplyEnabled: false,
          };
        const append = async (entry: unknown) => {
          await history.file.writeFile(JSON.stringify(entry) + '\n');
          await history.file.sync();
        };
        await append({ kind: 'intent', requestHash, sourceDigest, planDigest });
        const { createCentralPurchaseOrder } =
          await import('../src/lib/pharmacy/central-purchasing');
        const { lines, ...order } = await createCentralPurchaseOrder(
          tx,
          { organizationId: request.organizationId, actorId: request.actorUserId },
          {
            reference: `${namespace}draft-po`,
            supplierId: request.supplierId,
            receivingBranchId: request.branchId,
            lines: [
              {
                medicineId: request.medicineId,
                packLevelId: request.packLevelId,
                orderedPacks: 1,
                canonicalUnitsPerPack: 1,
                listPricePerPackMinor: 0,
              },
            ],
          }
        );
        requireFact(order.status === 'DRAFT' && lines.length === 1, 'UNEXPECTED_SERVICE_RESULT');
        const receipt: DraftReceipt = {
          version: SQL_VERSION,
          namespace,
          sourceDigest,
          requestHash,
          planDigest,
          references,
          rows: [
            { model: 'PharmacyPurchaseOrder', id: order.id, hash: pharmacyScalarHash(order) },
            ...lines.map((row) => ({
              model: 'PharmacyPurchaseOrderLine',
              id: row.id,
              hash: pharmacyScalarHash(row),
            })),
          ],
        };
        const data = {
          organizationId: request.organizationId,
          actorId: request.actorUserId,
          actorType: 'USER' as const,
          source: 'SYSTEM' as const,
          category: 'SYSTEM',
          targetType: 'PharmacyDemoDraft',
          targetId: namespace,
          description:
            'Synthetic disposable TEST draft only; no clinical, stock, financial or external action.',
        };
        const receiptRow = await tx.auditLog.create({
          data: { ...data, action: RECEIPT_ACTION, metadata: JSON.parse(JSON.stringify(receipt)) },
        });
        const tombstone = await tx.auditLog.create({
          data: {
            ...data,
            action: TOMBSTONE_ACTION,
            metadata: { receiptId: receiptRow.id, receiptHash: pharmacyScalarHash(receipt) },
          },
        });
        await append({
          kind: 'prepared',
          receipt,
          audit: [receiptRow, tombstone]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((row) => ({ model: 'AuditLog', id: row.id, hash: pharmacyScalarHash(row) })),
        });
        // A crash/rollback after this fsync remains detectable; never erase the retained history.
        return {
          mode: 'applied',
          writes: 4,
          planDigest,
          namespace,
          sourceDigest,
          runtimeRole,
          receipt,
          coverage,
          liveApplyEnabled: false,
        };
      } finally {
        await history.file.close();
      }
    },
    { userId: request.actorUserId, timeout: 30_000, maxWait: 10_000 }
  );
}

/** Errors never include the input, paths, identifiers, or underlying exception text. */
export async function main(
  args: string[],
  output: (text: string) => void = console.log
): Promise<number> {
  try {
    requireFact(!args.includes('--apply'), 'APPLY_DISABLED');
    requireFact(
      args.length === 2 && ['--evidence', '--disposable'].includes(args[0]),
      'EVIDENCE_REQUIRED'
    );
    requireFact(args[1].endsWith('.pharmacy-demo.json'), 'NONSECRET_EVIDENCE_FILE_REQUIRED');
    const file = await open(
      args[1],
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    let text: string;
    try {
      const stat = await file.stat();
      requireFact(stat.isFile() && stat.size <= 65_536, 'INVALID_EVIDENCE_FILE');
      const buffer = Buffer.alloc(65_537);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      requireFact(length <= 65_536, 'INVALID_EVIDENCE_FILE');
      text = buffer.subarray(0, length).toString('utf8');
    } finally {
      await file.close();
    }
    if (args[0] === '--disposable') {
      const input = object(JSON.parse(text), 'target request options');
      output(
        JSON.stringify(
          await runDisposablePharmacyDraft(
            input.target as DisposablePharmacyTarget,
            input.request as PharmacyDraftRequest,
            input.options as PharmacyDraftOptions
          ),
          null,
          2
        )
      );
    } else output(JSON.stringify(dryRun(JSON.parse(text)), null, 2));
    return 0;
  } catch (error) {
    output(
      JSON.stringify({
        mode: 'refused',
        code: error instanceof PharmacyDemoRefusal ? error.code : 'EVIDENCE_READ_OR_PARSE_FAILED',
        ...(args[0] === '--disposable' ? { transactionOutcome: 'not-confirmed' } : { writes: 0 }),
        applyEnabled: false,
      })
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } finally {
    if (boundDisposable) await (await import('../src/lib/db')).db.$disconnect();
  }
}
