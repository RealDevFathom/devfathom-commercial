import { beforeEach, describe, expect, it, vi } from 'vitest';

// Loyalty settings are owner policy: both mutations are gated by central can() on
// `pharmacy:loyalty-manage`, which reads the persisted role grants and user overrides.
// These cases drive the real router and the real can() over a mocked tenant client.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

const POINTS = {
  medicineEarnPoints: 2,
  nonDrugEarnPoints: 4,
  earnBlockMinor: 10_000,
  pointValueMinor: 100,
  minimumRedemptionPoints: 250,
  pointsExpiryMonths: 9,
  goldTierEnabled: true,
  goldTierThresholdMinor: 4_000_000,
  goldTierMultiplier: 3,
};
const VOUCHERS = {
  voucherScope: 'NON_DRUG_ONLY' as const,
  voucherValidityDays: 45,
  maxIssuedPerCustomerPerPeriod: 4,
  maxIssuedPerPhonePerPeriod: 4,
  maxRedeemedPerCustomerPerPeriod: 4,
  maxRedeemedPerPhonePerPeriod: 4,
  abusePeriodDays: 30,
  expiryOverrideGraceDays: 0,
};

function sqlOf(query: unknown) {
  return String((query as { sql?: string }).sql ?? query).replace(/\s+/g, ' ');
}

function fixture(role: Rule[], overrides: Rule[] = []) {
  const statements: string[] = [];
  let saved: Record<string, unknown> | null = null;
  const tx = {
    $executeRaw: vi.fn(async (query: unknown) => {
      const sql = sqlOf(query);
      statements.push(sql.includes('pg_advisory_xact_lock') ? 'lock' : sql.split(' (')[0]!.trim());
      if (sql.includes('INSERT INTO pharmacy_loyalty_settings ')) saved = { ...POINTS };
      return 1;
    }),
    $queryRaw: vi.fn(async (query: unknown) => {
      statements.push('read');
      return sqlOf(query).includes('pharmacy_loyalty_settings') && saved ? [saved] : [];
    }),
  };
  const db = {
    $transaction: vi.fn(async (work: (inner: unknown) => unknown) => work(tx)),
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: { permissions: role },
        permissionOverrides: overrides,
      })),
    },
  };
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
  return { caller, db, tx, statements };
}

const template = (key: string): Rule[] =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities.map((capability) => ({
    capability,
    effect: 'ALLOW',
  }));
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });

const mutations = [
  [
    'updateLoyaltyPointsSettings',
    (f: ReturnType<typeof fixture>) => f.caller.updateLoyaltyPointsSettings(POINTS),
  ],
  [
    'updateLoyaltySettings',
    (f: ReturnType<typeof fixture>) => f.caller.updateLoyaltySettings(VOUCHERS),
  ],
] as const;

describe.each(mutations)('%s authorization (pharmacy:loyalty-manage)', (_name, call) => {
  it('allows an exact role grant', async () => {
    const f = fixture([allow('pharmacy:loyalty-manage')]);
    await expect(call(f)).resolves.toBeTruthy();
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('allows the Owner as provisioned now and as migrated Owner roles hold it (pharmacy:*)', async () => {
    await expect(call(fixture(template('owner')))).resolves.toBeTruthy();
    await expect(
      call(fixture([allow('pharmacy:*'), allow('reports:operational'), allow('reports:financial')]))
    ).resolves.toBeTruthy();
  });

  it.each(['manager', 'cashier', 'pharmacist', 'owner-operator'])(
    'refuses the %s template, writing nothing',
    async (key) => {
      const f = fixture(template(key));
      await expect(call(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it('refuses a user DENY over a role ALLOW, writing nothing', async () => {
    for (const denied of ['pharmacy:loyalty-manage', 'pharmacy:*']) {
      const f = fixture(template('owner'), [deny(denied)]);
      await expect(call(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  });

  // Needs the central DENY-precedence fix, fix/abac-deny-precedence 6b120a50 ("any explicit
  // DENY, role or user override, beats any ALLOW"), which is not on main: today's
  // customDecision lets a user-override ALLOW return before the role's DENY is read. This
  // branch must not touch src/lib/abac/index.ts. Verified passing on a local merge with
  // 6b120a50; flip to `it` when that lands.
  it.fails('refuses a role DENY over a user ALLOW, writing nothing (needs 6b120a50)', async () => {
    const f = fixture(
      [allow('pharmacy:*'), deny('pharmacy:loyalty-manage')],
      [allow('pharmacy:loyalty-manage')]
    );
    await expect(call(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('updateLoyaltyPointsSettings writes under the tenant settings lock', () => {
  beforeEach(() => vi.clearAllMocks());

  it('locks before it reads, then audits the defaults it replaced and the saved row', async () => {
    const f = fixture([allow('pharmacy:loyalty-manage')]);
    await expect(f.caller.updateLoyaltyPointsSettings(POINTS)).resolves.toEqual(POINTS);
    expect(f.statements).toEqual([
      'lock',
      'read',
      'INSERT INTO pharmacy_loyalty_settings',
      'read',
      'INSERT INTO pharmacy_loyalty_settings_audits',
    ]);
    // The same tenant key the voucher settings mutation takes.
    expect(sqlOf(f.tx.$executeRaw.mock.calls[0]![0])).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\((\?|\$1), 1280266068\)\)/
    );
    const audit = f.tx.$executeRaw.mock.calls[2]![0] as { values: unknown[] };
    const [oldValue, newValue] = audit.values
      .filter((value): value is string => typeof value === 'string' && value.startsWith('{'))
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(oldValue).toMatchObject({
      voucherScope: 'WHOLE_BASKET',
      minimumRedemptionPoints: 200,
      pointsExpiryMonths: 6,
      goldTierEnabled: false,
    });
    expect(newValue).toEqual(POINTS);
  });

  it('refuses a configured value above the INTEGER column before any write', async () => {
    const f = fixture([allow('pharmacy:loyalty-manage')]);
    await expect(
      f.caller.updateLoyaltyPointsSettings({ ...POINTS, goldTierThresholdMinor: 2 ** 31 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
});
