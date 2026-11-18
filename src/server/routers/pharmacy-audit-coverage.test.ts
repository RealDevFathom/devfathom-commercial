import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEV-913 guard: every pharmacy action leaves an audit entry naming the person.
 *
 * 1. Every tRPC mutation in a pharmacy namespace runs the audit middleware, and
 *    calling it really records an entry, even when it is refused. A new pharmacy
 *    mutation built on `publicProcedure` (or any base without the middleware)
 *    fails here unless it is added to MUTATION_EXEMPTIONS with a reason.
 * 2. Every pharmacy mutation's entry names the branch it was taken at: its
 *    request carries the branch the recorder reads, or its handler tags the
 *    branch of the record it loads (`annotateAuditBranch`). A new pharmacy
 *    mutation with neither fails here unless WORKSPACE_WIDE says why it has no
 *    branch. Without a branch, a branch-limited administrator never sees it.
 * 3. Every pharmacy REST route that accepts a write is classified below: how it
 *    records its entry, or why it has no workspace person to record. A new route
 *    fails here until it is classified.
 */

const recorded = vi.hoisted(() => ({ calls: [] as Array<{ path: string; outcome: string }> }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn((args: { path: string; outcome: string }) => {
    recorded.calls.push({ path: args.path, outcome: args.outcome });
  }),
}));

/**
 * Pharmacy mutations that record no workspace person, each with its reason.
 * Keep this list short: anything a staff member does must be audited.
 */
const MUTATION_EXEMPTIONS: Readonly<Record<string, string>> = {
  'pharmacySupplierLinks.submit':
    'An outside supplier answering a signed one-time link: there is no workspace user to name. The submission row records it, and staff accept or reject it through audited procedures.',
  'pharmacySupplierLinks.uploadDocument':
    'An outside supplier uploading to a signed one-time link: no workspace user. The document row records it; staff review is audited.',
};

/**
 * Pharmacy mutations whose entry carries no branch, grouped by why. Each one
 * acts on something the whole pharmacy shares, so only the owner sees its
 * entry. Anything done at one branch must carry that branch instead.
 */
const WORKSPACE_WIDE: ReadonlyArray<{ reason: string; actions: readonly string[] }> = [
  {
    reason:
      'The medicine register, DRAP reference data, manufacturer batches and recalls: one register for the whole pharmacy, not held per branch. Branch stock acting on them (counts, recall acknowledgement) carries its branch.',
    actions: [
      'pharmacyInventory.closeRecall',
      'pharmacyInventory.confirmDrapPrice',
      'pharmacyInventory.confirmDrapRecall',
      'pharmacyInventory.createRecall',
      'pharmacyInventory.dismissDrapRecall',
      'pharmacyInventory.ingestDrapFile',
      'pharmacyInventory.ingestDrapManual',
      'pharmacyInventory.registerBatch',
      'pharmacyInventory.reverseDrapRecall',
      'pharmacyInventory.setBatchState',
      'pharmacyMedicine.addAlias',
      'pharmacyMedicine.addBarcode',
      'pharmacyMedicine.addMedicineDraft',
      'pharmacyMedicine.configureReferenceConnector',
      'pharmacyMedicine.confirmPrices',
      'pharmacyMedicine.createIngredient',
      'pharmacyMedicine.createMedicine',
      'pharmacyMedicine.createPackLevel',
      'pharmacyMedicine.decideCatalogueEdit',
      'pharmacyMedicine.decideReferenceConnectorProposal',
      'pharmacyMedicine.dismissDrapPriceAlert',
      'pharmacyMedicine.ingestPriceNotices',
      'pharmacyMedicine.proposeCatalogueEdit',
      'pharmacyMedicine.publishAssertions',
      'pharmacyMedicine.recordPrintedMrp',
      'pharmacyMedicine.recordReviewDecision',
      'pharmacyMedicine.revisePackLevel',
      'pharmacyMedicine.runReferenceConnectorNow',
      'pharmacyMedicine.runStagedMedicineCreation',
      'pharmacyMedicine.setPackBarcode',
      'pharmacyMedicine.setRetailDetails',
      'pharmacyMedicine.supersedePublication',
    ],
  },
  {
    reason:
      'Supplier records, licences, authorisation and supplier price lists are shared by every branch; the orders and goods-in that use them carry their branch.',
    actions: [
      'pharmacyPurchasing.createSupplier',
      'pharmacyPurchasing.recordSupplierLicence',
      'pharmacyPurchasing.setSupplierAuthorization',
      'pharmacyPurchasing.verifySupplierLicence',
      'pharmacySupplierPriceLists.decide',
      'pharmacySupplierPriceLists.import',
    ],
  },
  {
    reason:
      'Patients, prescribers, consent, prescriptions and their scans are workspace records with no branch in the data model; the counter sale that dispenses one carries its branch.',
    actions: [
      'pharmacyPrescriptions.capture',
      'pharmacyPrescriptions.createPatient',
      'pharmacyPrescriptions.createPrescriber',
      'pharmacyPrescriptions.draftCartFromSource',
      'pharmacyPrescriptions.extractSource',
      'pharmacyPrescriptions.fill',
      'pharmacyPrescriptions.recordConsent',
      'pharmacyPrescriptions.uploadSource',
    ],
  },
  {
    reason:
      'Workspace settings and policies the owner sets once for every branch: transfers between branches, pharmacist checks, supplier checks, set-up steps, the procedure library, record retention and legal holds.',
    actions: [
      'pharmacyBranchAssignments.setOtherBranchAvailability',
      'pharmacyInventory.setBranchTransfersEnabled',
      'pharmacyOnboarding.recordFbrTier1Check',
      'pharmacyOnboarding.recordGate',
      'pharmacyPharmacistCheck.setPolicy',
      'pharmacySafety.installSopLibrary',
      'pharmacySafety.recordLegalHold',
      'pharmacySafety.setRetentionClass',
      'pharmacySop.installLibrary',
      'pharmacySupplierCompliance.setPolicy',
    ],
  },
  {
    reason:
      'Reads an uploaded stock file only to suggest its column mapping and writes nothing; the preview and import that follow name their branch.',
    actions: ['pharmacyOwnerImport.upload'],
  },
  {
    reason:
      "The person's own counter keys, dashboard layout and purchase approval PIN: they follow the person to every branch.",
    actions: [
      'pharmacyPurchasing.provisionMyPurchasePin',
      'pharmacyReports.updatePreferences',
      'pharmacySales.counterSaveKeymap',
    ],
  },
];

const WORKSPACE_WIDE_ACTIONS = new Map(
  WORKSPACE_WIDE.flatMap(({ reason, actions }) => actions.map((key) => [key, reason] as const))
);

/**
 * Router helpers that tag the audit entry with a loaded record's branch, so a
 * procedure calling one tags it too. Each is checked below to really do so.
 */
const BRANCH_TAGGING_HELPERS: Readonly<Record<string, readonly string[]>> = {
  'pharmacy-dispensing.ts': ['tagSaleLineBranch'],
  'pharmacy-purchasing.ts': ['purchasingRecordScope'],
};

type AnyProcedure = {
  _def: { type: string; middlewares: readonly unknown[]; inputs?: readonly unknown[] };
};

let appProcedures: Record<string, AnyProcedure>;
let stagedProcedures: Record<string, AnyProcedure>;
let procedureWritesAudit: (procedure: AnyProcedure) => boolean;
let auditBranchId: (input: unknown) => string | null;
let appRouter: { createCaller: (ctx: unknown) => unknown };
let stagedRouter: { createCaller: (ctx: unknown) => unknown };

beforeAll(async () => {
  const app = await import('./_app');
  const staged = await import('./pharmacy-staged-review');
  const trpc = await import('../trpc');
  appRouter = app.appRouter as never;
  stagedRouter = staged.pharmacyStagedReviewRouter as never;
  appProcedures = app.appRouter._def.procedures as never;
  stagedProcedures = staged.pharmacyStagedReviewRouter._def.procedures as never;
  procedureWritesAudit = trpc.procedureWritesAudit as never;
  auditBranchId = (await import('@/server/audit')).auditBranchId;
}, 120_000);

beforeEach(() => {
  recorded.calls = [];
});

function pharmacyMutations(procedures: Record<string, AnyProcedure>, all = false): string[] {
  return Object.entries(procedures)
    .filter(
      ([key, procedure]) =>
        (all || key.startsWith('pharmacy')) && procedure._def.type === 'mutation'
    )
    .map(([key]) => key)
    .sort();
}

/** A request with no signed-in person: every audited mutation refuses it. */
function anonymousContext() {
  return {
    db: {},
    entitlements: {
      organizationId: 'org_guard',
      vertical: 'PHARMACY',
      enabledModules: [],
      modules: [],
      limits: {},
      seatLimit: 1,
      activeSeats: 1,
    },
    session: null,
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
}

async function callPath(router: { createCaller: (ctx: unknown) => unknown }, key: string) {
  let target: unknown = router.createCaller(anonymousContext());
  for (const segment of key.split('.')) target = (target as Record<string, unknown>)[segment];
  await (target as (input: unknown) => Promise<unknown>)({}).catch(() => undefined);
}

describe('DEV-913 pharmacy audit coverage guard', () => {
  it('finds the pharmacy mutations it guards', () => {
    const mutations = pharmacyMutations(appProcedures);
    expect(mutations.length).toBeGreaterThan(200);
    expect(mutations).toEqual(
      expect.arrayContaining([
        'pharmacySales.returnAndRefund',
        'pharmacySales.refundTender',
        'pharmacyBranchAssignments.assign',
      ])
    );
    expect(pharmacyMutations(stagedProcedures, true).length).toBeGreaterThan(0);
  });

  it('runs the audit middleware on every pharmacy mutation, or names why not', () => {
    const missing = [
      ...pharmacyMutations(appProcedures).filter(
        (key) => !procedureWritesAudit(appProcedures[key]!)
      ),
      ...pharmacyMutations(stagedProcedures, true)
        .filter((key) => !procedureWritesAudit(stagedProcedures[key]!))
        .map((key) => `pharmacyStagedReview:${key}`),
    ];
    expect(missing.filter((key) => !MUTATION_EXEMPTIONS[key])).toEqual([]);
  });

  it('keeps every exemption current and reasoned', () => {
    for (const [key, reason] of Object.entries(MUTATION_EXEMPTIONS)) {
      expect(appProcedures[key], key).toBeDefined();
      expect(procedureWritesAudit(appProcedures[key]!), key).toBe(false);
      expect(reason.length, key).toBeGreaterThan(40);
    }
  });

  it('records an entry for every pharmacy mutation, even when it is refused', async () => {
    const guarded = pharmacyMutations(appProcedures).filter((key) => !MUTATION_EXEMPTIONS[key]);
    for (const key of guarded) await callPath(appRouter, key);
    for (const key of pharmacyMutations(stagedProcedures, true)) await callPath(stagedRouter, key);
    const paths = new Set(recorded.calls.map((call) => call.path));
    expect(guarded.filter((key) => !paths.has(key))).toEqual([]);
    expect(pharmacyMutations(stagedProcedures, true).filter((key) => !paths.has(key))).toEqual([]);
    // Nobody was signed in, so every one of them was refused and recorded as a failure.
    expect(recorded.calls.every((call) => call.outcome === 'FAILURE')).toBe(true);
  }, 120_000);

  it('fails when a mutation is built without the audit middleware', async () => {
    const { publicProcedure, protectedProcedure, router } = await import('../trpc');
    const probe = router({
      bare: publicProcedure.mutation(() => 'ok'),
      audited: protectedProcedure.mutation(() => 'ok'),
    });
    const procedures = probe._def.procedures as unknown as Record<string, AnyProcedure>;
    expect(procedureWritesAudit(procedures.bare!)).toBe(false);
    expect(procedureWritesAudit(procedures.audited!)).toBe(true);
  });
});

// ── Branch on every entry ───────────────────────────────────────────────────

/** Request fields the recorder takes the branch from (`auditBranchId`). */
const BRANCH_FIELDS = ['branchId', 'pharmacyBranchId', 'scope.branchId'] as const;

type ZodLike = { _zod?: { def?: Record<string, unknown> } };

function zodDef(schema: unknown): Record<string, unknown> | undefined {
  return (schema as ZodLike | undefined)?._zod?.def;
}

/** Unwraps optional, default, pipe and similar wrappers down to the shape. */
function unwrapSchema(schema: unknown): unknown {
  let current = schema;
  for (let depth = 0; depth < 20; depth += 1) {
    const def = zodDef(current);
    if (!def) return current;
    if (
      ['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch', 'nonoptional'].includes(
        def.type as string
      )
    )
      current = def.innerType;
    else if (def.type === 'pipe') current = def.in;
    else if (def.type === 'lazy') current = (def.getter as () => unknown)();
    else return current;
  }
  return current;
}

/** Top-level field names, plus one level of nesting as `outer.inner`. */
function schemaFields(schema: unknown, nested = true): string[] {
  const def = zodDef(unwrapSchema(schema));
  if (!def) return [];
  if (def.type === 'object')
    return Object.entries(def.shape as Record<string, unknown>).flatMap(([key, value]) => [
      key,
      ...(nested ? schemaFields(value, false).map((inner) => `${key}.${inner}`) : []),
    ]);
  if (def.type === 'union')
    return (def.options as unknown[]).flatMap((option) => schemaFields(option, nested));
  if (def.type === 'intersection')
    return [...schemaFields(def.left, nested), ...schemaFields(def.right, nested)];
  return [];
}

function requestCarriesBranch(procedure: AnyProcedure): boolean {
  const fields = (procedure._def.inputs ?? []).flatMap((schema) => schemaFields(schema));
  return BRANCH_FIELDS.some((field) => fields.includes(field));
}

const ROUTERS_DIR = path.join(process.cwd(), 'src/server/routers');

/** `pharmacyCameras` -> `pharmacy-cameras.ts`, read from the app router's imports. */
function namespaceFiles(): Map<string, string> {
  const app = readFileSync(path.join(ROUTERS_DIR, '_app.ts'), 'utf8');
  const imports = new Map(
    [...app.matchAll(/import \{ (\w+) \} from '\.\/([\w-]+)'/g)].map((m) => [m[1]!, m[2]!])
  );
  return new Map(
    [...app.matchAll(/^\s+(pharmacy\w+): (\w+),$/gm)].map((m) => [
      m[1]!,
      `${imports.get(m[2]!)}.ts`,
    ])
  );
}

/** The source of one top-level procedure in its router file, or null. */
function procedureSource(file: string, name: string): string | null {
  const source = readFileSync(path.join(ROUTERS_DIR, file), 'utf8');
  const start = new RegExp(`^  ${name}: `, 'm').exec(source);
  if (!start) return null;
  const rest = source.slice(start.index + 2);
  const end = /^ {2}[A-Za-z_]\w*: |^\}\);?$/m.exec(rest.slice(name.length + 2));
  return end ? rest.slice(0, end.index + name.length + 2) : rest;
}

const TAGS_BRANCH = /annotateAuditBranch\(|metadata:\s*\{[^}]*\bbranchId\b/;

function handlerTagsBranch(file: string, name: string): boolean {
  const body = procedureSource(file, name);
  if (!body) return false;
  if (TAGS_BRANCH.test(body)) return true;
  return (BRANCH_TAGGING_HELPERS[file] ?? []).some((helper) =>
    new RegExp(`\\b${helper}\\(`).test(body)
  );
}

describe('DEV-913 pharmacy audit branch guard', () => {
  it('reads the branch from every request field the guard accepts', () => {
    expect(auditBranchId({ branchId: 'branch_a' })).toBe('branch_a');
    expect(auditBranchId({ pharmacyBranchId: 'branch_a' })).toBe('branch_a');
    expect(auditBranchId({ scope: { branchId: 'branch_a' } })).toBe('branch_a');
  });

  it('puts the branch on the entry of every pharmacy mutation, or names why it has none', () => {
    const files = namespaceFiles();
    const missing = pharmacyMutations(appProcedures).filter((key) => {
      if (MUTATION_EXEMPTIONS[key] || WORKSPACE_WIDE_ACTIONS.has(key)) return false;
      if (requestCarriesBranch(appProcedures[key]!)) return false;
      const [namespace, name] = key.split('.') as [string, string];
      return !handlerTagsBranch(files.get(namespace) ?? '', name);
    });
    const staged = pharmacyMutations(stagedProcedures, true).filter(
      (key) => !requestCarriesBranch(stagedProcedures[key]!)
    );
    expect(missing).toEqual([]);
    expect(staged).toEqual([]);
  });

  it('fails a mutation whose request and handler name no branch', () => {
    const files = namespaceFiles();
    // A workspace-wide action, judged without its listed reason, is caught.
    expect(requestCarriesBranch(appProcedures['pharmacyMedicine.createIngredient']!)).toBe(false);
    expect(handlerTagsBranch(files.get('pharmacyMedicine')!, 'createIngredient')).toBe(false);
    // Newly tagged from the record they load.
    for (const key of [
      'pharmacyCameras.configure',
      'pharmacyCameras.capturePending',
      'pharmacyCameras.revokeViewerGrant',
      'pharmacyDispensing.decideReview',
      'pharmacyPurchasing.approvePurchaseOrder',
      'pharmacyPurchasing.submitRequisition',
      'pharmacySafety.approveRegisterIncident',
      'pharmacySupplierLinks.revoke',
      'pharmacySales.discardTenderAttempt',
    ]) {
      const [namespace, name] = key.split('.') as [string, string];
      expect(handlerTagsBranch(files.get(namespace)!, name), key).toBe(true);
    }
  });

  it('checks that each branch-tagging helper really tags the entry', () => {
    for (const [file, helpers] of Object.entries(BRANCH_TAGGING_HELPERS)) {
      const source = readFileSync(path.join(ROUTERS_DIR, file), 'utf8');
      for (const helper of helpers) {
        const body = new RegExp(`function ${helper}\\([\\s\\S]*?\\n\\}`).exec(source)?.[0];
        expect(body, `${file} ${helper}`).toBeDefined();
        expect(body, `${file} ${helper}`).toMatch(/annotateAuditBranch\(/);
      }
    }
  });

  it('keeps every workspace-wide action current, reasoned and truly branchless', () => {
    const files = namespaceFiles();
    const seen = new Set<string>();
    for (const { reason, actions } of WORKSPACE_WIDE) {
      expect(reason.length, actions.join()).toBeGreaterThan(40);
      for (const key of actions) {
        expect(seen.has(key), `${key} listed twice`).toBe(false);
        seen.add(key);
        expect(appProcedures[key]?._def.type, key).toBe('mutation');
        expect(MUTATION_EXEMPTIONS[key], key).toBeUndefined();
        // Once an action carries a branch it leaves this list.
        expect(requestCarriesBranch(appProcedures[key]!), key).toBe(false);
        const [namespace, name] = key.split('.') as [string, string];
        expect(handlerTagsBranch(files.get(namespace)!, name), key).toBe(false);
      }
    }
  });
});

// ── REST routes ─────────────────────────────────────────────────────────────

const API_ROOT = path.join(process.cwd(), 'src/app/api/pharmacy');

/**
 * Every pharmacy route file that accepts a write, and how it is audited. An
 * `audited` entry names the code that writes its entry (checked below); an
 * `exempt` entry says why no workspace person acts there.
 */
const OFFLINE_ROUTER = 'src/server/routers/pharmacy-offline.ts';

const REST_ROUTES: Readonly<
  Record<
    string,
    | { audited: RegExp; how: string; delegate?: { file: string; writes: RegExp } }
    | { exempt: string }
  >
> = {
  'counter/establish/route.ts': {
    audited: /pharmacyCounterRoute\('establish'\)/,
    delegate: { file: OFFLINE_ROUTER, writes: /'openCounterSession'/ },
    how: 'pharmacyCounterRoute writes pharmacyOffline.openCounterSession with person, branch and terminal.',
  },
  'counter/lease/route.ts': {
    audited: /pharmacyCounterRoute\('lease'\)/,
    delegate: { file: OFFLINE_ROUTER, writes: /'reserveReceiptNumbers'/ },
    how: 'pharmacyCounterRoute writes pharmacyOffline.reserveReceiptNumbers.',
  },
  'counter/quota/route.ts': {
    audited: /pharmacyCounterRoute\('quota'\)/,
    delegate: { file: OFFLINE_ROUTER, writes: /'grantOfflineLotQuota'/ },
    how: 'pharmacyCounterRoute writes pharmacyOffline.grantOfflineLotQuota.',
  },
  'counter/reject/route.ts': {
    audited: /pharmacyCounterRoute\('reject'\)/,
    delegate: { file: OFFLINE_ROUTER, writes: /'pharmacyOffline.rejectCommand'/ },
    how: 'pharmacyCounterRoute writes pharmacyOffline.rejectCommand in the recovery transaction.',
  },
  'counter/replay/route.ts': {
    audited: /pharmacyCounterRoute\('replay'\)/,
    delegate: { file: OFFLINE_ROUTER, writes: /'replayOfflineSale'/ },
    how: 'pharmacyCounterRoute writes pharmacyOffline.replayOfflineSale for each posted offline sale.',
  },
  'counter/snapshot/route.ts': {
    audited: /pharmacyCounterRoute\('snapshot'\)/,
    delegate: { file: OFFLINE_ROUTER, writes: /'issueOfflineSnapshot'/ },
    how: 'pharmacyCounterRoute writes pharmacyOffline.issueOfflineSnapshot.',
  },
  'data-export/route.ts': {
    audited: /OwnerDataExportAuditAction|recordOwnerDataExport|auditOwnerDataExport/,
    how: 'Owner data export audits every list, request and download before releasing it.',
  },
  'print/route.ts': {
    audited: /createCaller\(ctx\)\.pharmacySales\./,
    how: 'Calls the audited pharmacySales procedure through the tRPC caller.',
  },
  'sop/evidence/route.ts': {
    audited: /createCaller\(ctx\)\.pharmacySop\.evidenceTarget/,
    how: 'Authorizes through pharmacySop.evidenceTarget, an audited read naming the person; the evidence receipt row records the file.',
  },
  'print-bridge/route.ts': {
    exempt:
      'The enrolled print bridge device fetching and acknowledging queued receipts; the person who printed is audited on the pharmacySales print procedure.',
  },
  'cold-chain/readings/route.ts': {
    exempt: 'A fridge sensor pushing temperature readings with its device secret; no person acts.',
  },
  'portal/[action]/route.ts': {
    exempt:
      'The patient portal: a customer, not a workspace member, acting on their own records; consent changes are stored on the patient record.',
  },
  'sms/webhook/route.ts': {
    exempt: 'Signed delivery receipts and replies from the SMS provider; no person acts.',
  },
  'whatsapp/webhook/route.ts': {
    exempt: 'Signed delivery receipts and replies from the WhatsApp provider; no person acts.',
  },
  'whatsapp/reminders/route.ts': {
    exempt: 'The scheduler sending due refill reminders with the cron secret; no person acts.',
  },
  'whatsapp/back-in-stock/route.ts': {
    exempt: 'The scheduler sending back-in-stock notices with the cron secret; no person acts.',
  },
  'whatsapp/khata-reminders/route.ts': {
    exempt: 'The scheduler sending khata reminders with the cron secret; no person acts.',
  },
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('DEV-913 pharmacy REST audit coverage guard', () => {
  const writing = routeFiles(API_ROOT)
    .filter((file) =>
      /export (async function|const) (POST|PUT|PATCH|DELETE)\b/.test(readFileSync(file, 'utf8'))
    )
    .map((file) => path.relative(API_ROOT, file).split(path.sep).join('/'))
    .sort();

  it('classifies every pharmacy route that accepts a write', () => {
    expect(writing.length).toBeGreaterThan(10);
    expect(writing.filter((file) => !REST_ROUTES[file])).toEqual([]);
    expect(Object.keys(REST_ROUTES).filter((file) => !writing.includes(file))).toEqual([]);
  });

  it.each(Object.entries(REST_ROUTES))('%s records its entry or says why not', (file, entry) => {
    if ('exempt' in entry) {
      expect(entry.exempt.length).toBeGreaterThan(40);
      return;
    }
    expect(readFileSync(path.join(API_ROOT, file), 'utf8')).toMatch(entry.audited);
    if (entry.delegate)
      expect(readFileSync(path.join(process.cwd(), entry.delegate.file), 'utf8')).toMatch(
        entry.delegate.writes
      );
  });
});
