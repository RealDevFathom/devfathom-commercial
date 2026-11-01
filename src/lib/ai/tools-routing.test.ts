import { describe, expect, it, vi } from 'vitest';
import { assistantToolChoice, buildAssistantTools, type AssistantContext } from '@/lib/ai/tools';
import { assistantSystemPrompt } from '@/lib/ai/prompt';
import { can } from '@/lib/abac';
import { MODULE_CATALOG } from '@/lib/module-catalog';

vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: () => ({
    organization: { findUnique: vi.fn().mockResolvedValue({ vertical: 'RESTAURANT' }) },
  }),
}));

vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn().mockResolvedValue(false),
}));

const ctx = {
  organizationId: 'org_test',
  userId: 'user_test',
  role: 'EMPLOYEE',
  vertical: 'AGENCY',
  enabledModules: MODULE_CATALOG.map(({ key }) => key),
} satisfies AssistantContext;
const adminCtx: AssistantContext = { ...ctx, role: 'ADMIN' };

describe('assistant tool routing', () => {
  it('preserves entitled Agency routing and employee/admin differences', () => {
    expect(buildAssistantTools(ctx, { hint: 'change the company logo' })).toEqual({});
    const employee = buildAssistantTools(ctx, { hint: 'I want to take leave next Monday' });
    expect(employee).toHaveProperty('requestLeave');
    expect(employee.requestLeave.needsApproval).toBe(true);
    // requestLeave stays offered for the leave hint, but the model chooses it.
    expect(assistantToolChoice()).toBe('auto');
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
        'searchNotes',
        'getNote',
        'createNote',
        'updateNote',
        'deleteNote',
        'setNoteShares',
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

  it('removes disabled modules from core and full continuation', () => {
    for (const vertical of ['AGENCY', 'RESTAURANT', 'PHARMACY'] as const) {
      const scope = { ...adminCtx, vertical, enabledModules: [] };
      expect(buildAssistantTools(scope)).toEqual({});
      expect(buildAssistantTools(scope, { hint: 'tasks staff chat pharmacy leave' })).toEqual({});
    }
    expect(buildAssistantTools({ ...adminCtx, enabledModules: ['hr'] })).not.toHaveProperty(
      'getTeamMember'
    );
  });

  const noteToolNames = [
    'searchNotes',
    'getNote',
    'createNote',
    'updateNote',
    'deleteNote',
    'setNoteShares',
  ];

  it.each<[string, string, string[]]>([
    ['full-set routing', '', noteToolNames],
    ['client-aware Notes routing', 'find the Acme note', noteToolNames],
    ['core-tool routing', 'show my tasks', ['searchNotes']],
  ])('requires every Notes dependency through %s', (_route, hint, expectedNoteTools) => {
    const noteDependencies = ['notes', 'projects', 'clients'];

    for (const missingModule of noteDependencies) {
      const tools = buildAssistantTools(
        { ...ctx, enabledModules: ctx.enabledModules.filter((module) => module !== missingModule) },
        { hint }
      );
      for (const name of noteToolNames) expect(tools).not.toHaveProperty(name);
    }

    const entitledTools = buildAssistantTools(ctx, { hint });
    expect(Object.keys(entitledTools).filter((name) => noteToolNames.includes(name))).toEqual(
      expectedNoteTools
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
      { toolCallId: 'test', messages: [], context: {} }
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
      { toolCallId: 'test', messages: [], context: {} }
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
      'askPharmacyOwnerQuestion',
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
    const options = { toolCallId: 'test', messages: [], context: {} };
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

describe('composed Pharmacy selection guards', () => {
  it.each(['ADMIN', 'EMPLOYEE'] as const)(
    'restricts finance and explicit work-pack selection for %s',
    (role) => {
      const subject: AssistantContext = { ...ctx, role, vertical: 'PHARMACY' };
      for (const hint of ['', 'pharmacy', 'finance']) {
        const tools = buildAssistantTools(subject, { hint });
        expect(tools).not.toHaveProperty('askPharmacyWorkPacks');
        expect('askPharmacyFinanceInsights' in tools).toBe(role === 'ADMIN');
        expect('askPharmacyOwnerQuestion' in tools).toBe(role === 'ADMIN');
      }
      for (const hint of ['work packs', 'supplier credit follow-up']) {
        expect(buildAssistantTools(subject, { hint })).toHaveProperty('askPharmacyWorkPacks');
      }
      expect(
        buildAssistantTools({ ...subject, enabledModules: [] }, { hint: 'work packs' })
      ).not.toHaveProperty('askPharmacyWorkPacks');
    }
  );
});
