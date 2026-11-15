import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-31: reconciling and closing a day is a manager or owner action. The owner
// (session ADMIN), a holder of the day-close grant, or a manager assigned to the
// branch may preview and close; a cashier holding only the counter grant is
// refused before any read or write, an explicit `pharmacy:close` DENY still beats
// a manager's grant, and a manager cannot close a branch they are not assigned to.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/day-close', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/day-close')>()),
  readPharmacyClose: vi.fn(async () => ({ sourceHash: 'a'.repeat(64) })),
  closePharmacyDay: vi.fn(async () => ({ id: 'close-1' })),
}));

vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  cutPharmacyDailyClose: vi.fn(async () => ({ id: 'cut-1' })),
}));

import { closePharmacyDay, readPharmacyClose } from '@/lib/pharmacy/day-close';
import { cutPharmacyDailyClose } from '@/lib/pharmacy/settlement';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const BRANCH = 'branch-1';
const businessDate = new Date('2026-10-20T00:00:00.000Z');
const REFUSED = {
  code: 'FORBIDDEN',
  message: 'Day-close permission is required to reconcile and close a day.',
};

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });

function fixture(
  roleRules: Rule[],
  overrides: Rule[] = [],
  role: 'ADMIN' | 'EMPLOYEE' = 'EMPLOYEE',
  assigned: string[] = [BRANCH],
  member: { status?: string; organizationId?: string } = {}
) {
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(
        async ({ where }: { where: { branchId: string; userId: string; active: boolean } }) =>
          where.userId === 'user-1' && where.active && assigned.includes(where.branchId)
            ? { branchId: where.branchId }
            : null
      ),
    },
    user: {
      findUnique: vi.fn(async () => ({
        status: member.status ?? 'ACTIVE',
        organizationId: member.organizationId ?? 'org-1',
        organizationRole: { permissions: roleRules },
        permissionOverrides: overrides,
      })),
    },
  };
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user-1', role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
  return { db, caller };
}

type Caller = ReturnType<typeof fixture>['caller'];

const paths: { name: string; run: (caller: Caller) => Promise<unknown>; command: unknown }[] = [
  {
    name: 'closePreview',
    run: (caller) => caller.closePreview({ branchId: BRANCH, businessDate }),
    command: readPharmacyClose,
  },
  {
    name: 'closeDay',
    run: (caller) =>
      caller.closeDay({
        branchId: BRANCH,
        businessDate,
        sourceHash: 'a'.repeat(64),
        counts: [{ drawerSessionId: 'drawer-1', countedCashMinor: 500 }],
        varianceNote: '',
      }),
    command: closePharmacyDay,
  },
  {
    name: 'dailyClose',
    run: (caller) => caller.dailyClose({ branchId: BRANCH, businessDate }),
    command: cutPharmacyDailyClose,
  },
];

const admitted: { name: string; role: Rule[]; overrides?: Rule[]; session?: 'ADMIN' }[] = [
  { name: 'a manager', role: [allow('pharmacy:manage'), allow('pharmacy:orders')] },
  {
    name: 'a manager grant held as a user override',
    role: [],
    overrides: [allow('pharmacy:manage')],
  },
  { name: 'the owner template', role: [allow('pharmacy:*')] },
  { name: 'a day-close holder', role: [allow('pharmacy:close')] },
  { name: 'a session owner', role: [], session: 'ADMIN' },
];

const refused: {
  name: string;
  role: Rule[];
  overrides?: Rule[];
  assigned?: string[];
  member?: { status?: string; organizationId?: string };
}[] = [
  {
    name: 'a manager whose stored membership is suspended',
    role: [allow('pharmacy:manage')],
    member: { status: 'SUSPENDED' },
  },
  {
    name: 'a manager whose stored membership is in another organization',
    role: [allow('pharmacy:manage')],
    member: { organizationId: 'org-2' },
  },
  {
    name: 'a manager assigned only to another branch',
    role: [allow('pharmacy:manage')],
    assigned: ['branch-2'],
  },
  { name: 'a manager with no branch assignment', role: [allow('pharmacy:manage')], assigned: [] },
  { name: 'a cashier', role: [allow('pharmacy:counter'), allow('pharmacy:orders')] },
  { name: 'a member with no grant', role: [] },
  {
    name: 'a manager whose role denies day close',
    role: [allow('pharmacy:manage'), deny('pharmacy:close')],
  },
  {
    name: 'a manager with a user DENY on day close',
    role: [allow('pharmacy:manage')],
    overrides: [deny('pharmacy:close')],
  },
  {
    name: 'a manager with a wildcard DENY',
    role: [allow('pharmacy:manage')],
    overrides: [deny('pharmacy:*')],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('day close is manager or owner only (DEV-31)', () => {
  it.each(paths.flatMap((path) => admitted.map((who) => ({ ...path, who }))))(
    '$name admits $who.name',
    async ({ run, command, who }) => {
      const f = fixture(who.role, who.overrides, who.session);
      await expect(run(f.caller)).resolves.toBeDefined();
      expect(command).toHaveBeenCalledTimes(1);
    }
  );

  it.each(paths.flatMap((path) => refused.map((who) => ({ ...path, who }))))(
    '$name refuses $who.name before any read or write',
    async ({ run, who }) => {
      const f = fixture(who.role, who.overrides, 'EMPLOYEE', who.assigned, who.member);
      await expect(run(f.caller)).rejects.toMatchObject(REFUSED);
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(readPharmacyClose).not.toHaveBeenCalled();
      expect(closePharmacyDay).not.toHaveBeenCalled();
      expect(cutPharmacyDailyClose).not.toHaveBeenCalled();
    }
  );
});
