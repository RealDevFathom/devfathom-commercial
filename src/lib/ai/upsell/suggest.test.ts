import { beforeEach, describe, expect, it, vi } from 'vitest';
import { suggestUpsells, type UpsellDependencies, type UpsellProduct } from './suggest';

const safe: UpsellProduct = {
  id: 'otc-1',
  name: 'Water',
  rxOnly: false,
  controlled: false,
  scheduled: false,
};

function setup(overrides: Partial<UpsellDependencies> = {}) {
  const dependencies: UpsellDependencies = {
    canSuggest: vi.fn().mockResolvedValue(true),
    readAIConfiguration: vi.fn().mockResolvedValue({
      enabled: true,
      providerSecretConfigured: true,
      model: 'standard-model',
    }),
    readCoPurchases: vi.fn().mockResolvedValue([]),
    rankAndPhrase: vi.fn().mockResolvedValue([]),
    audit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return dependencies;
}

const context = { organizationId: 'org-a', actorId: 'user-a', cart: [safe] };

describe('server checkout upsell safety boundary', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    ['Rx-only', { rxOnly: true }],
    ['controlled', { controlled: true }],
    ['scheduled', { scheduled: true }],
  ])('never sends or suggests a %s candidate', async (_label, restriction) => {
    const rankAndPhrase = vi.fn().mockResolvedValue([{ productId: 'blocked', message: 'Buy it' }]);
    const dependencies = setup({
      readCoPurchases: vi.fn().mockResolvedValue([
        { ...safe, id: 'blocked', coPurchaseCount: 99, ...restriction },
        { ...safe, id: 'allowed', name: 'Tissues', coPurchaseCount: 10 },
      ]),
      rankAndPhrase,
    });

    const result = await suggestUpsells(context, dependencies);

    expect(rankAndPhrase).toHaveBeenCalledWith({
      tier: 'standard',
      candidates: [{ productId: 'allowed', name: 'Tissues', coPurchaseCount: 10 }],
    });
    expect(result).toEqual([]);
  });

  it('suppresses a controlled cart before co-purchase or AI access', async () => {
    const dependencies = setup();
    const result = await suggestUpsells(
      { ...context, cart: [{ ...safe, controlled: true }] },
      dependencies
    );

    expect(result).toEqual([]);
    expect(dependencies.readCoPurchases).not.toHaveBeenCalled();
    expect(dependencies.rankAndPhrase).not.toHaveBeenCalled();
    expect(dependencies.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-a',
        organizationId: 'org-a',
        new: { status: 'SUPPRESSED', productIds: [] },
      })
    );
  });

  it('is off unless both the org switch and provider secret are configured', async () => {
    for (const configuration of [
      { enabled: false, providerSecretConfigured: true, model: 'standard-model' },
      { enabled: true, providerSecretConfigured: false, model: 'standard-model' },
    ]) {
      const dependencies = setup({
        readAIConfiguration: vi.fn().mockResolvedValue(configuration),
      });
      await expect(suggestUpsells(context, dependencies)).resolves.toEqual([]);
      expect(dependencies.readCoPurchases).not.toHaveBeenCalled();
    }
  });

  it('honors central permission denial and returns advisory co-purchase suggestions only', async () => {
    const denied = setup({ canSuggest: vi.fn().mockResolvedValue(false) });
    await expect(suggestUpsells(context, denied)).resolves.toEqual([]);
    expect(denied.readAIConfiguration).not.toHaveBeenCalled();

    const allowed = setup({
      readCoPurchases: vi
        .fn()
        .mockResolvedValue([{ ...safe, id: 'otc-2', name: 'Tissues', coPurchaseCount: 12 }]),
      rankAndPhrase: vi
        .fn()
        .mockResolvedValue([{ productId: 'otc-2', message: 'Often bought together.' }]),
    });
    await expect(suggestUpsells(context, allowed)).resolves.toEqual([
      {
        productId: 'otc-2',
        name: 'Tissues',
        message: 'Often bought together.',
        advisoryOnly: true,
      },
    ]);
    expect(allowed.readCoPurchases).toHaveBeenCalledWith('org-a', ['otc-1']);
    expect(allowed.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        model: 'standard-model',
        tier: 'standard',
        new: { status: 'SUGGESTED', productIds: ['otc-2'] },
      })
    );
  });
});
