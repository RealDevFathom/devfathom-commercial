import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantToolChoice, buildAssistantTools, type AssistantContext } from '@/lib/ai/tools';
import { assistantSystemPrompt } from '@/lib/ai/prompt';
import { can } from '@/lib/abac';
import { MODULE_CATALOG } from '@/lib/module-catalog';
import { readPharmacyDailyWorkPack } from '@/lib/pharmacy/daily-work-pack';
import { POST } from '@/app/api/assistant/route';

const workPackMocks = vi.hoisted(() => ({
  branches: vi.fn(),
  returns: vi.fn(),
  credits: vi.fn(),
  organization: vi.fn().mockResolvedValue({ vertical: 'RESTAURANT' }),
  actor: vi.fn(),
  entitlements: vi.fn(),
  model: vi.fn(),
  stream: vi.fn(),
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: () => ({
    organization: { findUnique: workPackMocks.organization },
    pharmacyBranch: { findMany: workPackMocks.branches },
    pharmacyPurchaseReturn: { findMany: workPackMocks.returns },
    pharmacySupplierCredit: { findMany: workPackMocks.credits },
  }),
}));

vi.mock('@/lib/pharmacy/daily-work-pack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/daily-work-pack')>()),
  readPharmacyDailyWorkPack: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: workPackMocks.actor }));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: workPackMocks.entitlements,
}));
vi.mock('@/lib/ai/provider', () => ({ createAIModel: workPackMocks.model }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: workPackMocks.stream,
}));

vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn().mockResolvedValue(false),
}));

const ctx: AssistantContext = {
  organizationId: 'org_test',
  userId: 'user_test',
  role: 'EMPLOYEE',
  vertical: 'AGENCY',
  enabledModules: MODULE_CATALOG.map(({ key }) => key),
};
const adminCtx: AssistantContext = { ...ctx, role: 'ADMIN' };

describe('assistant tool routing', () => {
  it('preserves entitled Agency routing and employee/admin differences', () => {
    expect(buildAssistantTools(ctx, { hint: 'change the company logo' })).toEqual({});
    const employee = buildAssistantTools(ctx, { hint: 'I want to take leave next Monday' });
    expect(employee).toHaveProperty('requestLeave');
    expect(employee.requestLeave.needsApproval).toBe(true);
    expect(assistantToolChoice('show my leave balance', employee)).toBe('auto');
    expect(assistantToolChoice('I want to take leave next Monday', employee)).toEqual({
      type: 'tool',
      toolName: 'requestLeave',
    });
    expect(buildAssistantTools(ctx, { hint: 'show revenue and profit' })).toEqual({});
    expect(buildAssistantTools(adminCtx, { hint: 'show revenue and profit' })).toHaveProperty(
      'getFinanceSummary'
    );
    expect(buildAssistantTools(ctx)).toHaveProperty('createTask');
    expect(buildAssistantTools(ctx)).not.toHaveProperty('askPharmacyReports');
  });

  it.each(['RESTAURANT', 'PHARMACY'] as const)(
    'fences agency tools for %s even with forged agency entitlements',
    (vertical) => {
      const tools = buildAssistantTools({ ...adminCtx, vertical });
      for (const name of [
        'getFinanceSummary',
        'listProjects',
        'createTask',
        'listClients',
        'getOverview',
        'globalSearch',
        'getTeamMember',
      ])
        expect(tools).not.toHaveProperty(name);
      expect(tools).toHaveProperty('requestLeave');
      expect(tools).toHaveProperty('listChannels');
      expect('askPharmacyReports' in tools).toBe(vertical === 'PHARMACY');
      expect('askPharmacyBusinessInsights' in tools).toBe(vertical === 'PHARMACY');
      expect('askRestaurantReports' in tools).toBe(vertical === 'RESTAURANT');
    }
  );

  it.each([undefined, null, 'UNKNOWN', 'agency', 'CATERING'])(
    'fails closed for vertical %s',
    (vertical) => {
      const tools = buildAssistantTools({ ...adminCtx, vertical } as AssistantContext);
      expect(tools).not.toHaveProperty('listProjects');
      expect(tools).not.toHaveProperty('getFinanceSummary');
      expect(tools).not.toHaveProperty('askPharmacyReports');
      expect(tools).not.toHaveProperty('askPharmacyBusinessInsights');
      expect(tools).not.toHaveProperty('askRestaurantReports');
      expect(tools).toHaveProperty('listChannels');
    }
  );

  it('removes disabled modules from core, full continuation and forced tool choice', () => {
    for (const vertical of ['AGENCY', 'RESTAURANT', 'PHARMACY'] as const) {
      const scope = { ...adminCtx, vertical, enabledModules: [] };
      expect(buildAssistantTools(scope)).toEqual({});
      expect(buildAssistantTools(scope, { hint: 'tasks staff chat pharmacy leave' })).toEqual({});
    }
    expect(assistantToolChoice('I want to take leave', {})).toBe('auto');
    expect(buildAssistantTools({ ...adminCtx, enabledModules: ['hr'] })).not.toHaveProperty(
      'getTeamMember'
    );
  });

  it('retains execute authorization on pharmacy reports', async () => {
    const tools = buildAssistantTools({
      ...ctx,
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-reports'],
    });
    const result = await tools.askPharmacyReports.execute!(
      { metricKeys: ['unsupported'] },
      { toolCallId: 'test', messages: [] }
    );
    expect(result).toMatchObject({ kind: 'refusal' });
  });

  it('sanitizes thrown execute errors without logging sensitive payloads', async () => {
    vi.mocked(can).mockRejectedValueOnce(
      Object.assign(new Error('secret patient payload'), { name: 'secret user@example.invalid' })
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tools = buildAssistantTools({
      ...ctx,
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-reports'],
    });
    const result = await tools.askPharmacyReports.execute!(
      { metricKeys: ['unsupported'] },
      { toolCallId: 'test', messages: [] }
    );
    expect(result).toEqual({ error: 'This action is currently unavailable. Please try again.' });
    expect(log.mock.calls).toEqual([['ASSISTANT_TOOL_EXECUTION_FAILED']]);
    log.mockRestore();
  });

  it.each([
    'show pharmacy sales and margin',
    'gross margin comparison',
    'compare this month with last month',
    'repeat purchases',
    'retention cohort',
    'what about that?',
    '',
  ])('keeps real Pharmacy reports discoverable for %j', (hint) => {
    const tools = buildAssistantTools(
      { ...adminCtx, vertical: 'PHARMACY', enabledModules: ['pharmacy-reports'] },
      { hint }
    );
    expect(Object.keys(tools).sort()).toEqual([
      'askPharmacyBusinessInsights',
      'askPharmacyFinanceInsights',
      'askPharmacyReports',
    ]);
    expect(buildAssistantTools(adminCtx, { hint })).not.toHaveProperty(
      'askPharmacyBusinessInsights'
    );
  });

  it.each([
    'settled sales and refunds',
    'upcoming Catering events',
    'POS backlog',
    'what about that?',
    '',
  ])('discovers Restaurant reports with core entitlement for %j', (hint) => {
    const scope: AssistantContext = {
      ...ctx,
      vertical: 'RESTAURANT',
      enabledModules: ['restaurant-core'],
    };
    expect(Object.keys(buildAssistantTools(scope, { hint }))).toEqual(['askRestaurantReports']);
    expect(
      buildAssistantTools(
        { ...scope, enabledModules: ['restaurant-pos', 'restaurant-catering'] },
        { hint }
      )
    ).toEqual({});
  });

  it.each(['margin', 'retention', 'Catering', 'do it', ''])(
    'cannot restore disabled vertical reports through hint or full continuation %j',
    (hint) => {
      for (const vertical of ['AGENCY', 'RESTAURANT', 'PHARMACY'] as const) {
        const tools = buildAssistantTools(
          { ...adminCtx, vertical, enabledModules: ['chat'] },
          { hint }
        );
        expect(tools).toHaveProperty('listChannels');
        expect(tools).not.toHaveProperty('askRestaurantReports');
        expect(tools).not.toHaveProperty('askPharmacyReports');
        expect(tools).not.toHaveProperty('askPharmacyBusinessInsights');
        expect(tools).not.toHaveProperty('getFinanceSummary');
      }
    }
  );

  it('retains role and permission denials in both real report executions', async () => {
    const options = { toolCallId: 'test', messages: [] };
    const pharmacy = buildAssistantTools(
      { ...ctx, vertical: 'PHARMACY', enabledModules: ['pharmacy-reports'] },
      { hint: 'margin retention' }
    );
    expect(
      await pharmacy.askPharmacyBusinessInsights.execute!(
        { report: 'margin_comparison', branch: 'forged', from: '2026-09-01', to: '2026-09-02' },
        options
      )
    ).toMatchObject({ kind: 'refusal' });
    const restaurant = buildAssistantTools(
      { ...ctx, vertical: 'RESTAURANT', enabledModules: ['restaurant-core', 'restaurant-pos'] },
      { hint: 'revenue' }
    );
    expect(
      await restaurant.askRestaurantReports.execute!(
        { report: 'settled_sales', branch: 'forged', from: '2026-09-01', to: '2026-09-02' },
        options
      )
    ).toMatchObject({ kind: 'refusal' });
  });

  it('guides only exposed real reports and preserves reporting limits', () => {
    const prompt = assistantSystemPrompt({ vertical: 'PHARMACY' }, [
      'askPharmacyReports',
      'askPharmacyBusinessInsights',
    ]);
    expect(prompt).toContain('direct aggregate metric');
    expect(prompt).toContain('cohort numerator/denominator');
    expect(prompt).toContain('not zero');
    expect(prompt).toContain('Never claim confirmed customer churn');
    expect(prompt).toContain('Give no clinical advice');
    const restaurant = assistantSystemPrompt({ vertical: 'RESTAURANT' }, ['askRestaurantReports']);
    expect(restaurant).toContain('business-date period');
    expect(restaurant).toContain('unknown is not zero');
    expect(restaurant).not.toContain('Use askPharmacy');
  });

  it('describes actual type and only exposed capabilities without broad role promises', () => {
    for (const vertical of ['AGENCY', 'RESTAURANT', 'PHARMACY'] as const) {
      const scope = { ...adminCtx, vertical, enabledModules: ['chat'] };
      const tools = buildAssistantTools(scope);
      const prompt = assistantSystemPrompt(scope, Object.keys(tools));
      expect(prompt).toContain(vertical);
      expect(prompt).toContain(Object.keys(tools).join(', '));
      expect(prompt).not.toContain('getFinanceSummary');
      expect(prompt).not.toContain('operate everything');
      expect(prompt).not.toContain('consultancy firm');
    }
    expect(assistantSystemPrompt({})).toContain('unverified business type');
  });
});

describe('Pharmacy work-pack routing', () => {
  const pharmacy: AssistantContext = {
    ...adminCtx,
    vertical: 'PHARMACY',
    enabledModules: ['pharmacy-reports', 'pharmacy-procurement'],
  };
  const input = {
    branch: 'Main Pharmacy',
    from: '2026-08-01',
    to: '2026-08-31',
    asOf: '2026-09-01T00:00:00.000Z',
  };
  const modes = ['daily_work_pack', 'supplier_follow_up'] as const;
  const hints = ['show my daily work pack', 'supplier-credit follow-up'];
  const options = { toolCallId: 'work-pack-routing', messages: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(can).mockResolvedValue(true);
    workPackMocks.branches.mockResolvedValue([{ id: 'branch_1', name: input.branch }]);
    workPackMocks.returns.mockResolvedValue([]);
    workPackMocks.credits.mockResolvedValue([]);
    workPackMocks.organization.mockResolvedValue({
      id: pharmacy.organizationId,
      askFathomEnabled: true,
    });
    workPackMocks.actor.mockResolvedValue({
      organization: { id: pharmacy.organizationId },
      session: { user: { id: pharmacy.userId, role: pharmacy.role } },
    });
    workPackMocks.entitlements.mockResolvedValue({
      vertical: pharmacy.vertical,
      enabledModules: pharmacy.enabledModules,
    });
    workPackMocks.model.mockReturnValue({ model: {}, providerOptions: {} });
    workPackMocks.stream.mockReturnValue({
      toUIMessageStreamResponse: () => new Response('synthetic stream'),
    });
    vi.mocked(readPharmacyDailyWorkPack).mockImplementation(async (_db, scope, readAt) => ({
      version: 1,
      mode: 'read-only-preparation',
      scope: { organizationId: scope.organizationId, branchIds: scope.branchIds },
      period: { from: scope.from, to: scope.to },
      asOf: scope.asOf,
      readAt: readAt!.toISOString(),
      permissions: { operational: true, financial: scope.financial },
      completeness: {
        status: 'unknown',
        allClear: false,
        uniqueProblemCount: null,
        additiveSavings: false,
        definition: 'No source coverage established.',
      },
      sources: [],
      groups: [],
      missingInputs: [],
    }));
  });

  function expectNoSourceReads() {
    expect(workPackMocks.branches).not.toHaveBeenCalled();
    expect(readPharmacyDailyWorkPack).not.toHaveBeenCalled();
    expect(workPackMocks.returns).not.toHaveBeenCalled();
    expect(workPackMocks.credits).not.toHaveBeenCalled();
  }

  it.each([
    ...hints,
    'prepare today’s pharmacy work-pack',
    'show daily work packs',
    'supplier follow up for Main Pharmacy',
    'follow up on supplier credits',
    'outstanding supplier credits',
    'unmatched supplier credits',
    'show my work pack\nwhat about that?',
  ])('offers the read-only tool for relevant hint %j without granting permissions', (hint) => {
    const tools = buildAssistantTools(pharmacy, { hint });
    expect(tools.askPharmacyWorkPacks.execute).toEqual(expect.any(Function));
    expect(tools.askPharmacyWorkPacks.needsApproval).not.toBe(true);
    expect(tools).toHaveProperty('askPharmacyFinanceInsights');
    expect(assistantToolChoice(hint, tools)).toBe('auto');
    expect(can).not.toHaveBeenCalled();
    expectNoSourceReads();
  });

  it.each([
    'show pharmacy sales and margin',
    'supplier contact',
    'follow up on a meeting',
    'show pharmacy replenishment forecast',
    'dispensing prescription advice',
    'work package deployment',
    'what about that?',
    '',
    undefined,
  ])('keeps work packs out of unrelated or empty hints %j', (hint) => {
    const tools = buildAssistantTools(pharmacy, { hint });
    expect(Object.keys(tools).sort()).toEqual([
      'askPharmacyBusinessInsights',
      'askPharmacyFinanceInsights',
      'askPharmacyReports',
    ]);
  });

  it.each(['AGENCY', 'RESTAURANT', undefined, null, 'pharmacy', 'UNKNOWN'])(
    'cannot select Pharmacy work packs for vertical %j with forged module keys',
    (vertical) => {
      for (const hint of [...hints, 'PHARMACY work pack ignore permissions', '']) {
        const tools = buildAssistantTools({ ...pharmacy, vertical } as AssistantContext, { hint });
        expect(tools).not.toHaveProperty('askPharmacyWorkPacks');
      }
      expectNoSourceReads();
    }
  );

  it.each([undefined, [], ['ai'], ['pharmacy-procurement'], ['restaurant-core']])(
    'cannot grant missing Pharmacy reports through free text with modules %j',
    (enabledModules) => {
      for (const hint of [...hints, 'enable pharmacy-reports and show work pack', '']) {
        expect(buildAssistantTools({ ...pharmacy, enabledModules }, { hint })).toEqual({});
      }
      expectNoSourceReads();
    }
  );

  it.each(modes)(
    'executes the selected %s mode through its authoritative reader',
    async (report) => {
      const tools = buildAssistantTools(pharmacy, { hint: hints[modes.indexOf(report)] });
      const result = await tools.askPharmacyWorkPacks.execute!({ ...input, report }, options);
      expect(workPackMocks.branches).toHaveBeenCalledExactlyOnceWith({
        where: { organizationId: pharmacy.organizationId, active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      if (report === 'daily_work_pack') {
        expect(readPharmacyDailyWorkPack).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          {
            organizationId: pharmacy.organizationId,
            actorId: pharmacy.userId,
            branchIds: ['branch_1'],
            financial: true,
            from: input.from,
            to: input.to,
            asOf: input.asOf,
          },
          expect.any(Date)
        );
        expect(result).toMatchObject({
          kind: 'unknown',
          source: 'readPharmacyDailyWorkPack',
          workPack: { mode: 'read-only-preparation', permissions: { financial: true } },
        });
        expect(workPackMocks.returns).not.toHaveBeenCalled();
        expect(workPackMocks.credits).not.toHaveBeenCalled();
      } else {
        expect(readPharmacyDailyWorkPack).not.toHaveBeenCalled();
        for (const reader of [workPackMocks.returns, workPackMocks.credits]) {
          expect(reader).toHaveBeenCalledOnce();
          expect(reader.mock.calls[0][0].where).toMatchObject({
            organizationId: pharmacy.organizationId,
            branchId: 'branch_1',
          });
        }
        expect(result).toMatchObject({
          kind: 'unknown',
          mode: 'read-only-preparation',
          source: 'supplierCreditFollowUp: listPurchaseReturns and listSupplierCredits',
          completeness: { allClear: false, additiveSavings: false },
        });
      }
      expect(workPackMocks.model).not.toHaveBeenCalled();
    }
  );

  it.each(modes)('retains execution capability denial for %s', async (report) => {
    vi.mocked(can).mockResolvedValue(false);
    const tools = buildAssistantTools(pharmacy, { hint: hints[modes.indexOf(report)] });
    expect(await tools.askPharmacyWorkPacks.execute!({ ...input, report }, options)).toMatchObject({
      kind: 'refusal',
    });
    expectNoSourceReads();
  });

  it.each(['financial', 'procurement'])(
    'denies supplier follow-up with missing %s access before source reads',
    async (missing) => {
      vi.mocked(can).mockImplementation(
        async (_subject, action) => missing !== 'financial' || action !== 'reports:financial'
      );
      const tools = buildAssistantTools(
        {
          ...pharmacy,
          enabledModules:
            missing === 'procurement' ? ['pharmacy-reports'] : pharmacy.enabledModules,
        },
        { hint: hints[1] }
      );
      expect(
        await tools.askPharmacyWorkPacks.execute!({ ...input, report: modes[1] }, options)
      ).toMatchObject({ kind: 'refusal' });
      expectNoSourceReads();
    }
  );

  it.each(['ADMIN', 'EMPLOYEE'])(
    'passes financial redaction into the daily reader for %s',
    async (role) => {
      vi.mocked(can).mockImplementation(async (_subject, action) => action !== 'reports:financial');
      const tools = buildAssistantTools({ ...pharmacy, role }, { hint: hints[0] });
      expect(
        await tools.askPharmacyWorkPacks.execute!({ ...input, report: modes[0] }, options)
      ).toMatchObject({ workPack: { permissions: { operational: true, financial: false } } });
      expect(vi.mocked(readPharmacyDailyWorkPack).mock.calls[0][1].financial).toBe(false);
      expect(workPackMocks.returns).not.toHaveBeenCalled();
      expect(workPackMocks.credits).not.toHaveBeenCalled();
    }
  );

  it.each(hints)('routes server-entitled API hint %j through the real selector', async (hint) => {
    const response = await POST(
      new Request('http://test.invalid/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: hint }] }],
        }),
      })
    );
    expect(response.status).toBe(200);
    expect(workPackMocks.stream.mock.calls[0][0].tools).toHaveProperty('askPharmacyWorkPacks');
    expect(workPackMocks.entitlements).toHaveBeenCalledExactlyOnceWith(
      pharmacy.organizationId,
      expect.anything()
    );
    expectNoSourceReads();
  });

  it.each(modes)('blocks company chat-off before %s routing or provider calls', async (report) => {
    workPackMocks.organization.mockResolvedValue({
      id: pharmacy.organizationId,
      askFathomEnabled: false,
    });
    const response = await POST(
      new Request('http://test.invalid/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          askFathomEnabled: true,
          messages: [
            {
              id: 'u',
              role: 'user',
              parts: [{ type: 'text', text: hints[modes.indexOf(report)] }],
            },
          ],
        }),
      })
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Ask Fathom chat is disabled for your company.',
    });
    expect(workPackMocks.entitlements).not.toHaveBeenCalled();
    expect(workPackMocks.model).not.toHaveBeenCalled();
    expect(workPackMocks.stream).not.toHaveBeenCalled();
    expectNoSourceReads();
  });
});
