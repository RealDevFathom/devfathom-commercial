import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../../../../tests/fixtures/ai/discount-scheduler/representative-pharmacy-cases.json';

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
    findPendingDraft: vi.fn(async () => null),
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

  it.each([1, 29, 25.5])('rejects an invalid payday boundary (%s)', (day) => {
    expect(() => pakistanDiscountCalendar(2026, day)).toThrow(
      'Invalid discount calendar configuration.'
    );
  });

  it('rejects years whose locally confirmed holiday table is unavailable', () => {
    expect(() => pakistanDiscountCalendar(2030)).toThrow(
      'No Pakistan holiday dates configured for 2030.'
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
    expect(deps.findPendingDraft).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ status: 'PENDING' })
    );
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

  it('matches the representative Abbasi Pharmacie happy-path eval fixture', async () => {
    const fixture = fixtures.happyPath;
    mocks.generate.mockResolvedValue({ output: { proposals: fixture.proposals }, usage: {} });
    const deps = dependencies({ loadItems: vi.fn(async () => fixture.items) });

    await expect(
      scheduleDiscountDrafts(
        { ...input, organizationId: fixture.organizationId, year: fixture.year },
        deps
      )
    ).resolves.toEqual(fixture.expectedDrafts);
    expect(deps.savePendingDraft).toHaveBeenCalledTimes(2);
    expect(deps.audit).toHaveBeenCalledTimes(3);
  });

  it('never sends regulated or malformed fixture inventory to the model', async () => {
    const fixture = fixtures.regulatedAndInvalidInputs;
    const deps = dependencies({ loadItems: vi.fn(async () => fixture.items) });

    await expect(scheduleDiscountDrafts(input, deps)).resolves.toEqual(fixture.expectedDrafts);
    expect(deps.route).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(deps.savePendingDraft).not.toHaveBeenCalled();
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

  it('honors a central explicit DENY even when the actor also has an ALLOW', async () => {
    mocks.can.mockImplementation(async (_actor, _action, _resource, options) => {
      const rules = (options?.db as unknown as { rules: { effect: string }[] }).rules;
      return rules.some((rule) => rule.effect === 'DENY')
        ? false
        : rules.some((rule) => rule.effect === 'ALLOW');
    });
    const deps = dependencies();
    const db = { rules: [{ effect: 'ALLOW' }, { effect: 'DENY' }] } as never;

    await expect(scheduleDiscountDrafts({ ...input, db }, deps)).rejects.toThrow('FORBIDDEN');
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(
      'org-1',
      actor,
      'proposalDenied',
      expect.objectContaining({ new: { status: 'DENIED', reason: 'FORBIDDEN' } })
    );
  });

  it.each([
    { aiEnabled: false, providerSecretConfigured: false },
    { aiEnabled: false, providerSecretConfigured: true },
    { aiEnabled: true, providerSecretConfigured: false },
  ])('keeps AI off until both org enablement and a provider secret exist: %j', async (config) => {
    const deps = dependencies({ loadConfig: vi.fn(async () => config) });
    await expect(scheduleDiscountDrafts(input, deps)).rejects.toThrow('AI_NOT_CONFIGURED');
    expect(deps.loadItems).not.toHaveBeenCalled();
    expect(deps.route).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(
      'org-1',
      actor,
      'proposalDenied',
      expect.objectContaining({
        new: { status: 'DENIED', reason: 'AI_NOT_CONFIGURED' },
        model: 'unconfigured',
      })
    );
  });

  it('keeps each configuration, inventory, lookup, write and audit tenant-scoped', async () => {
    const rows = new Map<string, Map<string, unknown>>([
      ['org-a', new Map()],
      ['org-b', new Map([['private', { category: 'org-b-only' }]])],
    ]);
    const touched: string[] = [];
    const deps = dependencies({
      loadConfig: vi.fn(async (organizationId) => {
        touched.push(`config:${organizationId}`);
        return { aiEnabled: true, providerSecretConfigured: true };
      }),
      loadItems: vi.fn(async (organizationId) => {
        touched.push(`items:${organizationId}`);
        expect(rows.get(organizationId)?.get('private')).toBeUndefined();
        return [
          {
            category: 'Tenant A toiletries',
            sellingPriceMinor: 1000,
            costMinor: 800,
            mrpMinor: 1000,
            isPrescription: false,
            isControlled: false,
          },
        ];
      }),
      findPendingDraft: vi.fn(async (organizationId) => {
        touched.push(`find:${organizationId}`);
        return null;
      }),
      savePendingDraft: vi.fn(async (organizationId) => {
        touched.push(`save:${organizationId}`);
        return { id: 'org-a-draft' };
      }),
      audit: vi.fn(async (organizationId) => {
        touched.push(`audit:${organizationId}`);
      }),
    });
    mocks.generate.mockResolvedValue({
      output: {
        proposals: [{ eventId: '2026:fitr', category: 'Tenant A toiletries', percent: 10 }],
      },
      usage: {},
    });

    await scheduleDiscountDrafts({ ...input, organizationId: 'org-a' }, deps);

    expect(touched.every((entry) => !entry.includes('org-b'))).toBe(true);
    expect(touched).toEqual([
      'config:org-a',
      'items:org-a',
      'audit:org-a',
      'find:org-a',
      'save:org-a',
      'audit:org-a',
    ]);
  });

  it('is idempotent across retries and duplicate model proposals', async () => {
    const stored = new Map<string, { id: string; draft: unknown }>();
    const deps = dependencies({
      findPendingDraft: vi.fn(async (organizationId, draft) => {
        const row = stored.get(`${organizationId}:${JSON.stringify(draft)}`);
        return row ? { id: row.id } : null;
      }),
      savePendingDraft: vi.fn(async (organizationId, draft) => {
        const id = 'stable-draft-id';
        stored.set(`${organizationId}:${JSON.stringify(draft)}`, { id, draft });
        return { id };
      }),
    });
    mocks.generate.mockResolvedValue({
      output: {
        proposals: [
          { eventId: '2026:fitr', category: 'Personal care', percent: 15 },
          { eventId: '2026:fitr', category: 'Personal care', percent: 15 },
        ],
      },
      usage: {},
    });

    const first = await scheduleDiscountDrafts(input, deps);
    const retry = await scheduleDiscountDrafts(input, deps);

    expect(retry).toEqual(first);
    expect(stored.size).toBe(1);
    expect(deps.savePendingDraft).toHaveBeenCalledOnce();
    expect(deps.audit).toHaveBeenCalledWith(
      'org-1',
      actor,
      'draftReused',
      expect.objectContaining({
        old: expect.objectContaining({ id: 'stable-draft-id' }),
        new: expect.objectContaining({ id: 'stable-draft-id' }),
      })
    );
  });

  it('audits failed model actions and does not persist a draft', async () => {
    const failure = new Error('provider unavailable');
    const deps = dependencies({ route: vi.fn(async () => Promise.reject(failure)) });

    await expect(scheduleDiscountDrafts(input, deps)).rejects.toBe(failure);
    expect(deps.savePendingDraft).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledOnce();
    expect(deps.audit).toHaveBeenCalledWith(
      'org-1',
      actor,
      'propose',
      expect.objectContaining({ new: { status: 'FAILED' }, tier: 'standard' })
    );
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
