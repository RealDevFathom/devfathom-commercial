import { describe, expect, it } from 'vitest';
import { assistantToolChoice, buildAssistantTools, type AssistantContext } from '@/lib/ai/tools';

const ctx = {
  organizationId: 'org_test',
  userId: 'user_test',
  role: 'EMPLOYEE',
} as AssistantContext;
const adminCtx = { ...ctx, role: 'ADMIN' } as AssistantContext;
const pharmacyCtx = { ...ctx, enabledModules: ['pharmacy-reports'] } as AssistantContext;

describe('assistant tool routing', () => {
  it('suppresses unsupported tools and forces clear self-leave requests', () => {
    expect(Object.keys(buildAssistantTools(ctx, { hint: 'change the company logo' }))).toEqual([]);
    expect(assistantToolChoice('I want to take leave next Monday')).toEqual({
      type: 'tool',
      toolName: 'requestLeave',
    });
    expect(buildAssistantTools(ctx, { hint: 'I want to take leave next Monday' })).toHaveProperty(
      'requestLeave'
    );
    expect(assistantToolChoice('show my leave balance')).toBe('auto');
    expect(Object.keys(buildAssistantTools(ctx, { hint: 'show revenue and profit' }))).toEqual([]);
    expect(buildAssistantTools(adminCtx, { hint: 'show revenue and profit' })).toHaveProperty(
      'getFinanceSummary'
    );
    expect(
      buildAssistantTools(pharmacyCtx, { hint: 'show pharmacy sales and margin' })
    ).toHaveProperty('askPharmacyReports');
  });
});
