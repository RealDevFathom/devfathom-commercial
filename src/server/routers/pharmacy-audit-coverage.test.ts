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
 * 2. Every pharmacy REST route that accepts a write is classified below: how it
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

type AnyProcedure = {
  _def: { type: string; middlewares: readonly unknown[] };
};

let appProcedures: Record<string, AnyProcedure>;
let stagedProcedures: Record<string, AnyProcedure>;
let procedureWritesAudit: (procedure: AnyProcedure) => boolean;
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
