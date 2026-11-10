import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const abacCan = vi.fn();
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: (...args: unknown[]) => abacCan(...args),
}));
vi.mock('@/lib/pharmacy/cash-close-check-operations', () => ({
  readPharmacyCashCloseCheck: vi.fn(),
}));

import { createAssistantHelpers } from '@/lib/ai/context';
import { readPharmacyCashCloseCheck } from '@/lib/pharmacy/cash-close-check-operations';
import { buildPharmacyReportTools } from './pharmacy-reports';

const branchFindMany = vi.fn();
const organizationFindUnique = vi.fn();
const check = {
  policyVersion: 'CC01-2026-11-01',
  businessDate: '2026-10-30',
  currency: 'USD',
  closed: true,
  closeId: 'close_1',
  readOnly: true as const,
  branchName: 'Main Pharmacy',
  timezone: 'Asia/Karachi',
  totals: {
    grossSalesMinor: 4_000_000,
    completedSales: 2,
    refundCount: 2,
    refundTotalMinor: 3_000,
    unmatchedRefundCount: 2,
    voidCount: 0,
    voidValueMinor: 0,
    cashExpectedMinor: 5_000_000,
    cashCountedMinor: 4_700_000,
    cashVarianceMinor: -300_000,
  },
  findings: [
    {
      kind: 'CLOSE_VARIANCE' as const,
      severity: 'URGENT' as const,
      subject: { businessDate: '2026-10-30' },
      exactNumbers: { varianceMinor: -300_000 },
      explanation: 'Cash counted USD 47000.00 against USD 50000.00 expected.',
    },
  ],
  narrative: 'Cash-close check for 2026-10-30 (closed). 1 item to review, 1 urgent:',
};

function execute(role = 'ADMIN', enabledModules = ['pharmacy-reports']) {
  const tools = buildPharmacyReportTools(
    createAssistantHelpers({ organizationId: 'org_1', userId: 'user_1', role, enabledModules }, {
      pharmacyBranch: { findMany: branchFindMany },
      organization: { findUnique: organizationFindUnique },
    } as never)
  );
  return tools.askPharmacyCashCloseCheck?.execute as
    ((input: unknown) => Promise<Record<string, unknown>>) | undefined;
}

const input = { branch: 'Main Pharmacy', businessDate: '2026-10-30' };

beforeEach(() => {
  vi.clearAllMocks();
  abacCan.mockResolvedValue(true);
  branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main Pharmacy' }]);
  organizationFindUnique.mockResolvedValue({ timezone: 'Asia/Karachi' });
  vi.mocked(readPharmacyCashCloseCheck).mockResolvedValue(check);
});

describe('Ask Fathom cash-close anomaly check (#728)', () => {
  it('narrates the rule findings for the owner within one tenant branch', async () => {
    const result = await execute()!(input);
    expect(readPharmacyCashCloseCheck).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org_1', branchId: 'branch_1' },
      new Date('2026-10-30T00:00:00.000Z'),
      { anonymizeStaff: true }
    );
    expect(result).toMatchObject({
      kind: 'answer',
      scope: { organizationId: 'org_1', branchIds: ['branch_1'] },
      closed: true,
      policyVersion: 'CC01-2026-11-01',
      moneyUnit: 'integer_minor',
      // #487: the organization's currency, never a hard-coded PKR.
      currency: 'USD',
      narrative: check.narrative,
      findings: [
        {
          kind: 'CLOSE_VARIANCE',
          severity: 'URGENT',
          exactNumbers: { varianceMinor: -300_000 },
          explanation: check.findings[0].explanation,
        },
      ],
    });
    const url = new URL(String(result.drillThrough), 'https://test.invalid');
    expect(url.pathname).toBe('/pharmacy/counter/close');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      branch: 'branch_1',
      date: '2026-10-30',
    });
    expect(String(result.instruction)).toContain('not proof of theft or misconduct');
    expect(String(result.instruction)).toContain('Do not offer to post, reopen');
  });

  it('keeps staff names and actor IDs out of real reader output before provider masking', async () => {
    const { readPharmacyCashCloseCheck: readActual } = await vi.importActual<
      typeof import('@/lib/pharmacy/cash-close-check-operations')
    >('@/lib/pharmacy/cash-close-check-operations');
    const userFindMany = vi.fn().mockResolvedValue([
      { id: 'user_1', name: 'Ayesha Noor' },
      { id: 'user_2', name: 'Bilal Khan' },
    ]);
    const evidenceDb = {
      pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ name: 'Main Pharmacy' }) },
      organization: {
        findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi', currency: 'USD' }),
      },
      pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacyDrawerSession: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'drawer_1',
            openedByActorId: 'user_1',
            openedAt: new Date('2026-10-30T04:00:00Z'),
            countedCashMinor: 2_350_000,
            movements: [{ kind: 'OPENING_FLOAT', amountMinor: 2_500_000 }],
          },
          {
            id: 'drawer_2',
            openedByActorId: 'user_2',
            openedAt: new Date('2026-10-30T05:00:00Z'),
            countedCashMinor: 2_650_000,
            movements: [{ kind: 'OPENING_FLOAT', amountMinor: 2_500_000 }],
          },
        ]),
      },
      pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyRefund: {
        findMany: vi.fn().mockResolvedValue(
          [1, 2, 3, 4].map((n) => ({
            id: `refund_${n}`,
            saleId: 'sale_1',
            actorId: 'user_2',
            amountMinor: 1_000,
          }))
        ),
      },
      pharmacySaleReturn: {
        findMany: vi.fn().mockResolvedValue([{ originalSaleId: 'sale_1' }]),
      },
      pharmacySaleEvent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'void_event_1',
            saleId: 'void_1',
            actorId: 'user_1',
            occurredAt: new Date('2026-10-30T06:00:00Z'),
            sale: { lines: [] },
          },
        ]),
      },
      user: { findMany: userFindMany },
    };
    vi.mocked(readPharmacyCashCloseCheck).mockImplementation((_, scope, date, options) =>
      readActual(evidenceDb as never, scope, date, options)
    );

    const result = await execute()!(input);
    expect(result).toMatchObject({ kind: 'answer', currency: 'USD', closed: false });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'DRAWER_VARIANCE',
          explanation: expect.stringContaining('opened by team member 1 at 10:00'),
        }),
        expect.objectContaining({
          kind: 'ACTOR_CONCENTRATION',
          exactNumbers: expect.objectContaining({ actorEvents: 4, totalEvents: 5, shareBps: 8_000 }),
          explanation: '4 of 5 refunds and voids (80.00%) were recorded by team member 1.',
        }),
      ])
    );
    expect(String(result.narrative)).toContain('recorded by team member 1');
    expect(JSON.stringify(result)).not.toMatch(/Ayesha Noor|Bilal Khan|user_1|user_2|"subject"/);
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it('refuses non-owners, missing financial permission and a disabled module', async () => {
    expect(await execute('EMPLOYEE')!(input)).toMatchObject({ kind: 'refusal' });
    abacCan.mockResolvedValue(false);
    expect(await execute()!(input)).toMatchObject({ kind: 'refusal' });
    expect(execute('ADMIN', [])).toBeUndefined();
    expect(readPharmacyCashCloseCheck).not.toHaveBeenCalled();
  });

  it.each(['foreign_branch', 'main'])(
    'refuses a branch that is not exactly one active tenant branch (%s)',
    async (branch) => {
      branchFindMany.mockResolvedValue([
        { id: 'branch_1', name: 'Main' },
        { id: 'branch_2', name: 'MAIN' },
      ]);
      expect(await execute()!({ ...input, branch })).toMatchObject({ kind: 'refusal' });
      expect(readPharmacyCashCloseCheck).not.toHaveBeenCalled();
    }
  );

  it('rejects malformed and future business dates without reading', async () => {
    expect(await execute()!({ ...input, businessDate: '30/10/2026' })).toMatchObject({
      kind: 'invalid_input',
    });
    expect(await execute()!({ ...input, businessDate: '2999-01-01' })).toMatchObject({
      kind: 'invalid_input',
    });
    expect(readPharmacyCashCloseCheck).not.toHaveBeenCalled();
  });

  it("accepts the workspace's current day before UTC reaches it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 01:00 on the 31st in Karachi is still the 30th in UTC.
      vi.setSystemTime(new Date('2026-10-30T20:00:00.000Z'));
      const result = await execute()!({ ...input, businessDate: '2026-10-31' });
      expect(result).toMatchObject({ kind: 'answer' });
      expect(readPharmacyCashCloseCheck).toHaveBeenCalledWith(
        expect.anything(),
        { organizationId: 'org_1', branchId: 'branch_1' },
        new Date('2026-10-31T00:00:00.000Z'),
        { anonymizeStaff: true }
      );
      expect(await execute()!({ ...input, businessDate: '2026-11-01' })).toMatchObject({
        kind: 'invalid_input',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports unavailable rather than leaking a reader failure', async () => {
    vi.mocked(readPharmacyCashCloseCheck).mockRejectedValue(new Error('db down'));
    expect(await execute()!(input)).toEqual({
      kind: 'unavailable',
      message: 'Pharmacy report data is currently unavailable. No stale figures were used.',
    });
  });

  it('uses no provider or network capability', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider'));
    try {
      expect((await execute()!(input)).kind).toBe('answer');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
