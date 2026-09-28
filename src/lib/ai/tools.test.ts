import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import { MODULE_CATALOG } from '@/lib/module-catalog';
import type { LeakageRow, ValuationRow } from '@/lib/pharmacy/finance-reports';
import { createTenantDb } from '@/lib/tenancy/scoped-db';
import { buildAssistantTools, type AssistantContext } from './tools';

const { branchFindMany, queryRaw } = vi.hoisted(() => ({
  branchFindMany: vi.fn(),
  queryRaw: vi.fn<(sql: Prisma.Sql) => Promise<unknown[]>>(),
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({
    pharmacyBranch: { findMany: branchFindMany },
    $queryRaw: queryRaw,
  })),
}));

vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(),
}));

const owner: AssistantContext = {
  organizationId: 'org_1',
  userId: 'owner_1',
  role: 'ADMIN',
  vertical: 'PHARMACY',
  enabledModules: ['pharmacy-reports'],
};
const financeTool = 'askPharmacyFinanceInsights';
const pharmacyTools = ['askPharmacyBusinessInsights', financeTool, 'askPharmacyReports'].sort();
const callOptions = { toolCallId: 'finance-routing-test', messages: [] };
const inventoryInput = {
  report: 'inventory_capital',
  branch: 'branch_1',
  at: '2026-09-01T00:00:00Z',
} as const;
const leakageInput = {
  report: 'leakage',
  branch: 'branch_1',
  from: '2026-08-01',
  to: '2026-09-01',
} as const;
const valuationRow: ValuationRow = {
  branchId: 'branch_1',
  lotId: 'lot_1',
  locationId: 'location_1',
  medicineId: 'medicine_1',
  manufacturingBatchId: 'batch_1',
  unitCostMinor: null,
  valueMinor: 12345,
};
const leakageRow: LeakageRow = {
  branchId: 'branch_1',
  medicineId: 'medicine_1',
  discountMinor: 100,
  writeOffMinor: 50,
  shrinkageMinor: -25,
  totalMinor: 125,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(can).mockResolvedValue(true);
  branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main Pharmacy' }]);
  queryRaw.mockResolvedValue([]);
});

describe('Pharmacy finance through the full assistant tool builder', () => {
  it.each([
    'explain leakage',
    'inventory capital',
    'inventory-capital',
    'show finance insights',
    'money tied up in stock',
    'discounts and write-offs',
    'show pharmacy leakage',
    'what about that?',
    'compare it with last month',
    'continue',
    '',
    '   ',
    undefined,
  ])('retains the adapter and existing reports for hint %j without an AI entitlement', (hint) => {
    const tools = buildAssistantTools(owner, { hint });
    expect(Object.keys(tools).sort()).toEqual(pharmacyTools);
    expect(tools[financeTool].execute).toEqual(expect.any(Function));
    expect(tools[financeTool].needsApproval).not.toBe(true);
    expect(can).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it.each(['EMPLOYEE', 'HR', 'MANAGER', 'admin'])(
    'does not offer the owner finance adapter to role %s',
    (role) => {
      for (const hint of ['leakage', 'pharmacy finance', 'what about that?', '']) {
        const tools = buildAssistantTools({ ...owner, role }, { hint });
        expect(Object.keys(tools).sort()).toEqual([
          'askPharmacyBusinessInsights',
          'askPharmacyReports',
        ]);
      }
      expect(queryRaw).not.toHaveBeenCalled();
    }
  );

  it.each([
    { enabledModules: [] },
    { enabledModules: ['ai'] },
    { enabledModules: ['finance'] },
    { enabledModules: ['pharmacy-finance'] },
    { enabledModules: ['restaurant-core'] },
  ])(
    'cannot restore disabled Pharmacy reports with modules $enabledModules',
    ({ enabledModules }) => {
      for (const hint of ['leakage inventory capital finance', 'pharmacy', 'continue', '']) {
        expect(buildAssistantTools({ ...owner, enabledModules }, { hint })).toEqual({});
      }
    }
  );

  it.each(['AGENCY', 'RESTAURANT', undefined, null] as const)(
    'does not expose the Pharmacy adapter to vertical %j',
    (vertical) => {
      for (const hint of ['pharmacy leakage finance', 'continue', '']) {
        const tools = buildAssistantTools(
          { ...owner, vertical, enabledModules: MODULE_CATALOG.map(({ key }) => key) },
          { hint }
        );
        expect(tools).not.toHaveProperty(financeTool);
      }
    }
  );

  it.each([inventoryInput, leakageInput])(
    'executes the selected $report tool with tenant, period and money evidence intact',
    async (input) => {
      queryRaw.mockResolvedValue([input.report === 'leakage' ? leakageRow : valuationRow]);
      const tools = buildAssistantTools(owner, { hint: 'finance' });
      const result = await tools[financeTool].execute!(input, callOptions);

      expect(result).toMatchObject({
        kind: 'answer',
        scope: { organizationId: 'org_1', branchIds: ['branch_1'] },
        moneyUnit: 'integer_minor',
        currency: null,
        definition: expect.any(String),
        source: expect.stringContaining(
          input.report === 'leakage' ? 'leakageReport:' : 'perpetualValuation:'
        ),
        coverage: { observedRows: 1 },
        freshness: { retrievedAt: expect.any(String), sourceUpdatedAt: null },
        period:
          input.report === 'leakage'
            ? { from: input.from, to: input.to, endExclusive: true, timezone: 'UTC' }
            : { at: new Date(input.at).toISOString(), endInclusive: true, timezone: 'UTC' },
        facts:
          input.report === 'leakage'
            ? [{ discountMinor: 100, writeOffMinor: 50, shrinkageMinor: -25, totalMinor: 125 }]
            : [{ bookValueMinor: 12345, unitCostMinor: null }],
      });
      expect(createTenantDb).toHaveBeenCalledWith('org_1');
      expect(vi.mocked(can).mock.calls.map((call) => call[1])).toEqual([
        'reports:operational',
        'reports:financial',
      ]);
      expect(branchFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org_1', active: true } })
      );
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const sql = queryRaw.mock.calls[0][0];
      expect(sql.values).toEqual(expect.arrayContaining(['org_1', 'branch_1']));
      expect(sql.values.filter((value) => value instanceof Date)).toEqual(
        input.report === 'leakage'
          ? [new Date(input.from), new Date(input.to)]
          : [new Date(input.at)]
      );
    }
  );

  it.each(['reports:financial', 'reports:operational'] as const)(
    'rechecks denied %s after selection and before any report read',
    async (deniedPermission) => {
      const tools = buildAssistantTools(owner, { hint: 'what about that?' });
      vi.mocked(can).mockImplementation(async (_subject, action) => action !== deniedPermission);
      for (const input of [inventoryInput, leakageInput]) {
        expect(await tools[financeTool].execute!(input, callOptions)).toMatchObject({
          kind: 'refusal',
        });
      }
      expect(branchFindMany).not.toHaveBeenCalled();
      expect(queryRaw).not.toHaveBeenCalled();
    }
  );

  it.each([inventoryInput, leakageInput])(
    'rejects another company branch for $report before reading figures',
    async (input) => {
      const tools = buildAssistantTools(owner, { hint: 'inventory capital leakage' });
      expect(
        await tools[financeTool].execute!({ ...input, branch: 'org_2_branch' }, callOptions)
      ).toMatchObject({ kind: 'refusal' });
      expect(branchFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org_1', active: true } })
      );
      expect(queryRaw).not.toHaveBeenCalled();
    }
  );

  it('rejects injected company scope instead of replacing the acting tenant', async () => {
    const tools = buildAssistantTools(owner, { hint: 'finance' });
    expect(
      await tools[financeTool].execute!({ ...inventoryInput, organizationId: 'org_2' }, callOptions)
    ).toMatchObject({ kind: 'invalid_input' });
    expect(branchFindMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('preserves Agency finance restrictions, shared tools and Restaurant reports', () => {
    const modules = MODULE_CATALOG.map(({ key }) => key);
    const agency: AssistantContext = { ...owner, vertical: 'AGENCY', enabledModules: modules };
    expect(buildAssistantTools(agency, { hint: 'finance' })).toHaveProperty('getFinanceSummary');
    expect(buildAssistantTools({ ...agency, role: 'EMPLOYEE' }, { hint: 'finance' })).toEqual({});
    const shared = buildAssistantTools({ ...owner, enabledModules: modules }, { hint: 'leave' });
    expect(shared).toHaveProperty('requestLeave');
    expect(shared).toHaveProperty('listChannels');
    expect(shared).not.toHaveProperty('getFinanceSummary');
    expect(shared).not.toHaveProperty('listProjects');
    expect(shared).not.toHaveProperty('createTask');
    expect(
      Object.keys(
        buildAssistantTools(
          { ...owner, vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
          { hint: 'what about that?' }
        )
      )
    ).toEqual(['askRestaurantReports']);
    expect(buildAssistantTools(owner, { hint: 'change company branding' })).toEqual({});
  });
});
