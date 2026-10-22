import { describe, expect, it, vi } from 'vitest';
import {
  calculateShopBaseline,
  runChurnScoreBatch,
  scoreCustomerChurn,
  type ChurnScoreStore,
} from './score';

describe('scoreCustomerChurn', () => {
  const baseline = { recencyDays: 20, frequency: 10, monetaryMinor: 10_000 };

  it('scores the shop baseline at 50', () => {
    expect(scoreCustomerChurn({ customerId: 'customer', ...baseline }, baseline)).toEqual({
      customerId: 'customer',
      score: 50,
      band: 'MEDIUM',
      components: { recency: 50, frequency: 50, monetary: 50 },
    });
  });

  it('weights stale, infrequent, low-spend customers toward high risk', () => {
    expect(
      scoreCustomerChurn(
        { customerId: 'customer', recencyDays: 40, frequency: 0, monetaryMinor: 0 },
        baseline
      )
    ).toMatchObject({ score: 100, band: 'HIGH' });
    expect(
      scoreCustomerChurn(
        { customerId: 'customer', recencyDays: 0, frequency: 20, monetaryMinor: 20_000 },
        baseline
      )
    ).toMatchObject({ score: 0, band: 'LOW' });
  });

  it('handles a zero shop baseline and rejects invalid aggregates', () => {
    expect(
      scoreCustomerChurn(
        { customerId: 'customer', recencyDays: 0, frequency: 0, monetaryMinor: 0 },
        { recencyDays: 0, frequency: 0, monetaryMinor: 0 }
      ).score
    ).toBe(50);
    expect(() =>
      scoreCustomerChurn(
        { customerId: 'customer', recencyDays: -1, frequency: 1, monetaryMinor: 1 },
        baseline
      )
    ).toThrow('finite and non-negative');
  });

  it('derives the shop baseline from the tenant customer population', () => {
    expect(
      calculateShopBaseline([
        { customerId: 'a', recencyDays: 10, frequency: 2, monetaryMinor: 1_000 },
        { customerId: 'b', recencyDays: 30, frequency: 8, monetaryMinor: 3_000 },
      ])
    ).toEqual({ recencyDays: 20, frequency: 5, monetaryMinor: 2_000 });
  });
});

describe('tenant-scoped churn batch', () => {
  function store(): ChurnScoreStore {
    return {
      readRfm: vi
        .fn()
        .mockResolvedValue([
          { customerId: 'c1', recencyDays: 20, frequency: 10, monetaryMinor: 10_000 },
        ]),
      writeScore: vi.fn().mockResolvedValue(undefined),
      hasAIProviderSecret: vi.fn().mockResolvedValue(true),
      readPreviousExplanation: vi.fn().mockResolvedValue('old'),
      writeAudit: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('puts the organization predicate on every customer read and write', async () => {
    const db = store();
    await runChurnScoreBatch({
      organizationId: 'org-a',
      actorId: 'system',
      store: db,
      can: async () => false,
    });
    expect(db.readRfm).toHaveBeenCalledWith({ where: { organizationId: 'org-a' } });
    expect(db.hasAIProviderSecret).toHaveBeenCalledWith({ where: { organizationId: 'org-a' } });
    expect(db.writeScore).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', customerId: 'c1' },
      })
    );
  });

  it('sends only aggregates to standard-tier AI and audits its explanation', async () => {
    const db = store();
    const generate = vi.fn().mockResolvedValue('Aggregate-based explanation.');
    await runChurnScoreBatch({
      organizationId: 'org-a',
      actorId: 'actor-a',
      store: db,
      can: async () => true,
      explanation: { model: 'model-a', generate },
    });
    expect(generate).toHaveBeenCalledWith({
      score: 50,
      band: 'MEDIUM',
      components: { recency: 50, frequency: 50, monetary: 50 },
      baseline: { recencyDays: 20, frequency: 10, monetaryMinor: 10_000 },
      model: 'model-a',
      tier: 'standard',
    });
    expect(JSON.stringify(generate.mock.calls[0][0])).not.toContain('c1');
    expect(db.readPreviousExplanation).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', customerId: 'c1' },
    });
    expect(db.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'actor-a',
        organizationId: 'org-a',
        oldValue: 'old',
        newValue: 'Aggregate-based explanation.',
        model: 'model-a',
        tier: 'standard',
      })
    );
  });

  it.each([
    { secret: false, allowed: true },
    { secret: true, allowed: false },
  ])('keeps AI off when server gate is $secret/$allowed', async ({ secret, allowed }) => {
    const db = store();
    vi.mocked(db.hasAIProviderSecret).mockResolvedValue(secret);
    const generate = vi.fn();
    await runChurnScoreBatch({
      organizationId: 'org-a',
      actorId: 'actor-a',
      store: db,
      can: async () => allowed,
      explanation: { model: 'model-a', generate },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(db.writeAudit).not.toHaveBeenCalled();
  });
});
