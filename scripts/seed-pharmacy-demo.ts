/** Offline evidence dry-run only. No dotenv, Prisma, service imports or network. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  MIGRATIONS_SHA256,
  PHARMACY_DEMO_VERSION,
  SCHEMA_SHA256,
  isPharmacyDemoNamespace,
  type DemoGap,
  type DemoObservedRecord,
  type DemoPlannedRecord,
  type PharmacyDemoEvidence,
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
  const expected = keys.split(' ');
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

/** Errors never include the input, paths, identifiers, or underlying exception text. */
export async function main(
  args: string[],
  output: (text: string) => void = console.log
): Promise<number> {
  try {
    requireFact(!args.includes('--apply'), 'APPLY_DISABLED');
    requireFact(args.length === 2 && args[0] === '--evidence', 'EVIDENCE_REQUIRED');
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
    output(JSON.stringify(dryRun(JSON.parse(text)), null, 2));
    return 0;
  } catch (error) {
    output(
      JSON.stringify({
        mode: 'refused',
        code: error instanceof PharmacyDemoRefusal ? error.code : 'EVIDENCE_READ_OR_PARSE_FAILED',
        writes: 0,
        applyEnabled: false,
      })
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
