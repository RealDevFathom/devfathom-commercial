import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), generate: vi.fn() }));
vi.mock('@/lib/abac', async (original) => ({
  ...(await original<typeof import('@/lib/abac')>()),
  can: mocks.can,
}));
vi.mock('ai', async (original) => ({
  ...(await original<typeof import('ai')>()),
  generateText: mocks.generate,
  Output: { object: vi.fn((input) => input) },
}));

import {
  AI_DISCOUNT_LABEL,
  pakistanDiscountCalendar,
  scheduleDiscountDrafts,
  type DiscountSchedulerDependencies,
} from './scheduler';

const actor = { id: 'user-1', role: 'ADMIN', department: null, status: 'ACTIVE' };
const input = { organizationId: 'org-1', actor, db: {} as never, year: 2026 };

function dependencies(
  overrides: Partial<DiscountSchedulerDependencies> = {}
): DiscountSchedulerDependencies {
  return {
    loadConfig: vi.fn(async () => ({ aiEnabled: true, providerSecretConfigured: true })),
    loadItems: vi.fn(async () => [
      {
        category: 'Personal care',
        sellingPriceMinor: 1000,
        costMinor: 800,
        mrpMinor: 1100,
        isPrescription: false,
        isControlled: false,
      },
      {
        category: 'Rx',
        sellingPriceMinor: 1000,
        costMinor: 100,
        mrpMinor: 1000,
        isPrescription: true,
        isControlled: false,
      },
      {
        category: 'Controlled',
        sellingPriceMinor: 1000,
        costMinor: 100,
        mrpMinor: 1000,
        isPrescription: false,
        isControlled: true,
      },
      {
        category: 'Above MRP',
        sellingPriceMinor: 1200,
        costMinor: 500,
        mrpMinor: 1100,
        isPrescription: false,
        isControlled: false,
      },
      {
        category: 'Malformed money',
        sellingPriceMinor: 1000.5,
        costMinor: 500,
        mrpMinor: 1100,
        isPrescription: false,
        isControlled: false,
      },
    ]),
    savePendingDraft: vi.fn(async () => ({ id: 'draft-1' })),
    audit: vi.fn(),
    route: vi.fn(async (options) =>
      options.execute({ model: {} as never, provider: 'anthropic', modelId: 'smart-model' })
    ),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.generate.mockResolvedValue({
    output: { proposals: [{ eventId: '2026:fitr', category: 'Personal care', percent: 75 }] },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
});

describe('Pakistan discount calendar', () => {
  it('uses configured religious dates, payday windows and all seasons without network access', () => {
    const calendar = pakistanDiscountCalendar(2026, 26, {
      2026: {
        ramadanStart: '2026-02-20',
        ramadanEnd: '2026-03-20',
        eidUlFitr: '2026-03-21',
        eidUlAdha: '2026-05-28',
      },
    });
    expect(calendar).toContainEqual(
      expect.objectContaining({ kind: 'RAMADAN', from: '2026-02-20', to: '2026-03-20' })
    );
    expect(calendar).toContainEqual({
      id: '2026:payday:1:window',
      kind: 'PAYDAY',
      from: '2025-12-26',
      to: '2026-01-01',
    });
    expect(calendar.filter((event) => event.kind === 'PAYDAY')).toHaveLength(24);
    expect(calendar.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['SUMMER', 'WINTER', 'MONSOON', 'EID_UL_FITR', 'EID_UL_ADHA'])
    );
  });
});

describe('AI discount scheduler', () => {
  it('creates only PENDING drafts, excludes regulated categories, and clamps prices above cost', async () => {
    const deps = dependencies();
    const drafts = await scheduleDiscountDrafts(input, deps);

    expect(drafts).toEqual([
      expect.objectContaining({
        status: 'PENDING',
        sourceLabel: AI_DISCOUNT_LABEL,
        category: 'Personal care',
        percent: 20,
        model: 'smart-model',
        tier: 'standard',
      }),
    ]);
    expect(mocks.generate.mock.calls[0][0].prompt).not.toContain('Rx');
    expect(mocks.generate.mock.calls[0][0].prompt).not.toContain('Controlled');
    expect(mocks.generate.mock.calls[0][0].prompt).not.toContain('Above MRP');
    expect(mocks.generate.mock.calls[0][0].prompt).not.toContain('Malformed money');
    expect(deps.loadConfig).toHaveBeenCalledWith('org-1');
    expect(deps.loadItems).toHaveBeenCalledWith('org-1');
    expect(deps.savePendingDraft).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ status: 'PENDING' })
    );
    expect(deps.audit).toHaveBeenCalledTimes(2);
    expect(deps.audit).toHaveBeenLastCalledWith(
      'org-1',
      actor,
      'draftCreated',
      expect.objectContaining({ model: 'smart-model', tier: 'standard', old: null })
    );
  });

  it('checks central permission before tenant reads and honors denial', async () => {
    mocks.can.mockResolvedValue(false);
    const deps = dependencies();
    await expect(scheduleDiscountDrafts(input, deps)).rejects.toThrow('FORBIDDEN');
    expect(mocks.can).toHaveBeenCalledWith(
      actor,
      'pharmacy:manage',
      undefined,
      expect.objectContaining({ db: input.db })
    );
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledOnce();
  });

  it.each([
    { aiEnabled: false, providerSecretConfigured: true },
    { aiEnabled: true, providerSecretConfigured: false },
  ])('keeps AI off until both org enablement and a provider secret exist: %j', async (config) => {
    const deps = dependencies({ loadConfig: vi.fn(async () => config) });
    await expect(scheduleDiscountDrafts(input, deps)).rejects.toThrow('AI_NOT_CONFIGURED');
    expect(deps.loadItems).not.toHaveBeenCalled();
    expect(deps.route).not.toHaveBeenCalled();
  });

  it('rejects AI-invented categories and event windows', async () => {
    mocks.generate.mockResolvedValue({
      output: { proposals: [{ eventId: 'invented', category: 'Rx', percent: 50 }] },
      usage: {},
    });
    const deps = dependencies();
    expect(await scheduleDiscountDrafts(input, deps)).toEqual([]);
    expect(deps.savePendingDraft).not.toHaveBeenCalled();
  });
});
