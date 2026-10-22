import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../../../../tests/fixtures/ai/upsell-engine/pharmacy-cases.json';
import {
  UPSELL_LABEL,
  suggestUpsells,
  type CoPurchaseCandidate,
  type UpsellContext,
  type UpsellDependencies,
  type UpsellProduct,
} from './suggest';

const safe: UpsellProduct = {
  id: 'otc-water', name: 'Mineral Water', rxOnly: false, controlled: false, scheduled: false,
};
const context: UpsellContext = {
  organizationId: 'org-a', actorId: 'pharmacist-a', cart: [safe],
};

function setup(overrides: Partial<UpsellDependencies> = {}): UpsellDependencies {
  return {
    canSuggest: vi.fn().mockResolvedValue(true),
    readAIConfiguration: vi.fn().mockResolvedValue({
      enabled: true, providerSecretConfigured: true, model: 'standard-model',
    }),
    readCoPurchases: vi.fn().mockResolvedValue([]),
    rankAndPhrase: vi.fn().mockResolvedValue([]),
    audit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function candidate(
  id: string,
  name: string,
  coPurchaseCount: number,
  restrictions: Partial<Pick<UpsellProduct, 'rxOnly' | 'controlled' | 'scheduled'>> = {}
): CoPurchaseCandidate {
  return { ...safe, id, name, coPurchaseCount, ...restrictions };
}

describe('pharmacy DevFathom AI upsell engine', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses the approved label and returns happy-path advisory suggestions in model order', async () => {
    expect(UPSELL_LABEL).toBe('DevFathom AI');
    const dependencies = setup({
      readCoPurchases: vi.fn().mockResolvedValue([
        candidate('tissues', 'Tissues', 12), candidate('soap', 'Hand Soap', 7),
      ]),
      rankAndPhrase: vi.fn().mockResolvedValue([
        { productId: 'soap', message: '  Useful for hand hygiene.  ' },
        { productId: 'tissues', message: 'Often bought together.' },
      ]),
    });

    await expect(suggestUpsells(context, dependencies)).resolves.toEqual([
      { productId: 'soap', name: 'Hand Soap', message: 'Useful for hand hygiene.', advisoryOnly: true },
      { productId: 'tissues', name: 'Tissues', message: 'Often bought together.', advisoryOnly: true },
    ]);
    expect(dependencies.rankAndPhrase).toHaveBeenCalledWith({ tier: 'standard', candidates: [
      { productId: 'tissues', name: 'Tissues', coPurchaseCount: 12 },
      { productId: 'soap', name: 'Hand Soap', coPurchaseCount: 7 },
    ] });
    expect(dependencies.audit).toHaveBeenCalledWith({
      actorId: 'pharmacist-a',
      organizationId: 'org-a',
      action: 'AI_UPSELL_SUGGEST',
      old: null,
      new: { status: 'SUGGESTED', productIds: ['soap', 'tissues'] },
      model: 'standard-model',
      tier: 'standard',
    });
  });

  it('keeps reads tenant scoped so org A cannot see org B', async () => {
    const rows: Record<string, CoPurchaseCandidate[]> = {
      'org-a': [candidate('a-item', 'A item', 4)],
      'org-b': [candidate('b-private', 'B private item', 999)],
    };
    const readCoPurchases = vi.fn(async (organizationId: string) => rows[organizationId] ?? []);
    const rankAndPhrase = vi.fn(async (input: Parameters<UpsellDependencies['rankAndPhrase']>[0]) =>
      input.candidates.map(({ productId }) => ({ productId, message: `Offer ${productId}` }))
    );

    const result = await suggestUpsells(context, setup({ readCoPurchases, rankAndPhrase }));

    expect(readCoPurchases).toHaveBeenCalledWith('org-a', ['otc-water']);
    expect(result.map(({ productId }) => productId)).toEqual(['a-item']);
    expect(rankAndPhrase).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [expect.objectContaining({ productId: 'a-item' })],
    }));
  });

  it('gives an explicit central DENY precedence over ALLOW', async () => {
    const centralCan = vi.fn(async (decisions: Array<'ALLOW' | 'DENY'>) =>
      decisions.includes('DENY') ? false : decisions.includes('ALLOW')
    );
    const dependencies = setup({ canSuggest: () => centralCan(['ALLOW', 'DENY']) });

    await expect(suggestUpsells(context, dependencies)).resolves.toEqual([]);
    expect(dependencies.readAIConfiguration).not.toHaveBeenCalled();
    expect(dependencies.readCoPurchases).not.toHaveBeenCalled();
    expect(dependencies.audit).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a', new: { status: 'DENIED', productIds: [] },
    }));
  });

  it.each(['pharmacy:dispense', 'pharmacy:safety', 'pharmacy:catalogue-review'])(
    'does not let a broad pharmacy grant satisfy exact-only %s',
    async (requiredCapability) => {
      const can = vi.fn(async (capability: string, grants: string[]) =>
        grants.includes(capability)
      );
      const dependencies = setup({
        canSuggest: () => can(requiredCapability, ['pharmacy:*']),
      });

      await expect(suggestUpsells(context, dependencies)).resolves.toEqual([]);
      expect(can).toHaveBeenCalledWith(requiredCapability, ['pharmacy:*']);
      expect(dependencies.readAIConfiguration).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['org setting is absent/off', { enabled: false, providerSecretConfigured: true, model: 'standard-model' }],
    ['provider secret is absent', { enabled: true, providerSecretConfigured: false, model: 'standard-model' }],
    ['server model is absent', { enabled: true, providerSecretConfigured: true, model: null }],
  ])('is off when %s', async (_reason, configuration) => {
    const dependencies = setup({ readAIConfiguration: vi.fn().mockResolvedValue(configuration) });
    await expect(suggestUpsells(context, dependencies)).resolves.toEqual([]);
    expect(dependencies.readAIConfiguration).toHaveBeenCalledWith('org-a');
    expect(dependencies.readCoPurchases).not.toHaveBeenCalled();
    expect(dependencies.rankAndPhrase).not.toHaveBeenCalled();
    expect(dependencies.audit).toHaveBeenCalledWith(expect.objectContaining({
      new: { status: 'DISABLED', productIds: [] },
    }));
  });

  it('is idempotent for the same checkout and removes duplicate model output', async () => {
    const frozen = Object.freeze({ ...context, cart: Object.freeze([{ ...safe }]) }) as UpsellContext;
    const dependencies = setup({
      readCoPurchases: vi.fn().mockResolvedValue([candidate('tissues', 'Tissues', 12)]),
      rankAndPhrase: vi.fn().mockResolvedValue([
        { productId: 'tissues', message: 'Often bought together.' },
        { productId: 'tissues', message: 'Duplicate' },
      ]),
    });

    const first = await suggestUpsells(frozen, dependencies);
    const second = await suggestUpsells(frozen, dependencies);
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    expect(dependencies.audit).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Rx-only', { rxOnly: true }], ['controlled', { controlled: true }], ['scheduled', { scheduled: true }],
  ])('never sends or returns a %s candidate', async (_label, restriction) => {
    const dependencies = setup({
      readCoPurchases: vi.fn().mockResolvedValue([
        candidate('blocked', 'Blocked medicine', 99, restriction),
        candidate('allowed', 'Tissues', 10),
      ]),
      rankAndPhrase: vi.fn().mockResolvedValue([
        { productId: 'blocked', message: 'Unsafe' },
        { productId: 'allowed', message: 'Often bought together.' },
      ]),
    });
    await expect(suggestUpsells(context, dependencies)).resolves.toEqual([
      { productId: 'allowed', name: 'Tissues', message: 'Often bought together.', advisoryOnly: true },
    ]);
    expect(dependencies.rankAndPhrase).toHaveBeenCalledWith({ tier: 'standard', candidates: [
      { productId: 'allowed', name: 'Tissues', coPurchaseCount: 10 },
    ] });
  });

  it('suppresses a controlled cart before any co-purchase or AI access', async () => {
    const dependencies = setup();
    await expect(suggestUpsells({
      ...context, cart: [{ ...safe, controlled: true }],
    }, dependencies)).resolves.toEqual([]);
    expect(dependencies.readCoPurchases).not.toHaveBeenCalled();
    expect(dependencies.rankAndPhrase).not.toHaveBeenCalled();
    expect(dependencies.audit).toHaveBeenCalledWith(expect.objectContaining({
      new: { status: 'SUPPRESSED', productIds: [] },
    }));
  });

  it('rejects invalid evidence and hallucinated, blank, cart, and duplicate outputs', async () => {
    const dependencies = setup({
      readCoPurchases: vi.fn().mockResolvedValue([
        candidate('negative', 'Negative', -1), candidate('fraction', 'Fraction', 1.5),
        candidate('otc-water', 'Already in cart', 30), candidate('eligible', 'Eligible', 2),
      ]),
      rankAndPhrase: vi.fn().mockResolvedValue([
        { productId: 'unknown', message: 'Hallucinated' },
        { productId: 'eligible', message: ' ' },
        { productId: 'eligible', message: 'Approved' },
        { productId: 'eligible', message: 'Duplicate' },
      ]),
    });
    await expect(suggestUpsells(context, dependencies)).resolves.toEqual([
      { productId: 'eligible', name: 'Eligible', message: 'Approved', advisoryOnly: true },
    ]);
  });

  it.each([
    ['DENIED', setup({ canSuggest: vi.fn().mockResolvedValue(false) }), null],
    ['DISABLED', setup({ readAIConfiguration: vi.fn().mockResolvedValue({ enabled: false, providerSecretConfigured: false, model: null }) }), null],
    ['SUPPRESSED', setup(), 'standard-model'],
  ] as const)('writes a complete %s audit entry', async (status, dependencies, model) => {
    await suggestUpsells(context, dependencies);
    expect(dependencies.audit).toHaveBeenCalledOnce();
    expect(dependencies.audit).toHaveBeenCalledWith({
      actorId: 'pharmacist-a', organizationId: 'org-a', action: 'AI_UPSELL_SUGGEST', old: null,
      new: { status, productIds: [] }, model, tier: 'standard',
    });
  });

  it('audits a failed provider action without swallowing its failure', async () => {
    const failure = new Error('provider unavailable');
    const dependencies = setup({
      readCoPurchases: vi.fn().mockResolvedValue([candidate('eligible', 'Eligible', 3)]),
      rankAndPhrase: vi.fn().mockRejectedValue(failure),
    });
    await expect(suggestUpsells(context, dependencies)).rejects.toBe(failure);
    expect(dependencies.audit).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a', model: 'standard-model', new: { status: 'DENIED', productIds: [] },
    }));
  });

  it.each(fixtures.cases)('matches pharmacy eval fixture $id', async (fixture) => {
    const dependencies = setup({
      canSuggest: vi.fn().mockResolvedValue(fixture.permission),
      readAIConfiguration: vi.fn().mockResolvedValue(fixture.configuration),
      readCoPurchases: vi.fn().mockResolvedValue(fixture.candidates),
      rankAndPhrase: vi.fn().mockResolvedValue(fixture.ranked),
    });
    await expect(suggestUpsells(fixture.context, dependencies)).resolves.toEqual(fixture.expected);
  });
});
