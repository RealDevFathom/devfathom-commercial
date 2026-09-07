import { describe, expect, it, vi } from 'vitest';
import { assistantToolChoice, buildAssistantTools, type AssistantContext } from '@/lib/ai/tools';
import { assistantSystemPrompt } from '@/lib/ai/prompt';
import { can } from '@/lib/abac';
import { MODULE_CATALOG } from '@/lib/module-catalog';

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
    }
  );

  it.each([undefined, null, 'UNKNOWN', 'agency', 'CATERING'])(
    'fails closed for vertical %s',
    (vertical) => {
      const tools = buildAssistantTools({ ...adminCtx, vertical } as AssistantContext);
      expect(tools).not.toHaveProperty('listProjects');
      expect(tools).not.toHaveProperty('getFinanceSummary');
      expect(tools).not.toHaveProperty('askPharmacyReports');
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
    vi.mocked(can).mockRejectedValueOnce(new Error('secret patient payload'));
    const log = vi.spyOn(console, 'error');
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
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
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
