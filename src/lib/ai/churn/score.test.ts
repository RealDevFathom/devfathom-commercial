import { describe, expect, it, vi } from 'vitest';
import pharmacyCases from '../../../../tests/fixtures/ai/churn-score/pharmacy-rfm-cases.json';
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

  it.each(pharmacyCases)('matches the eval fixture: $name', ({ customer, baseline, expected }) => {
    expect(scoreCustomerChurn(customer, baseline)).toEqual(expected);
  });

  it('returns an empty baseline for a pharmacy with no eligible customers', () => {
    expect(calculateShopBaseline([])).toEqual({
      recencyDays: 0,
      frequency: 0,
      monetaryMinor: 0,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-finite RFM input %s',
    (invalid) => {
      expect(() =>
        scoreCustomerChurn(
          { customerId: 'customer', recencyDays: 1, frequency: invalid, monetaryMinor: 1 },
          baseline
        )
      ).toThrow('RFM values must be finite and non-negative.');
    }
  );
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

  it('completes the happy path and puts the organization predicate on every operation', async () => {
    const db = store();
    const scores = await runChurnScoreBatch({
      organizationId: 'org-a',
      actorId: 'system',
      store: db,
      can: async () => false,
    });
    expect(scores).toEqual([
      {
        customerId: 'c1',
        score: 50,
        band: 'MEDIUM',
        components: { recency: 50, frequency: 50, monetary: 50 },
      },
    ]);
    expect(db.readRfm).toHaveBeenCalledWith({ where: { organizationId: 'org-a' } });
    expect(db.hasAIProviderSecret).not.toHaveBeenCalled();
    expect(db.writeScore).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', customerId: 'c1' },
      })
    );
  });

  it('cannot read or write another organization while scoring org A', async () => {
    const tenantRows = new Map([
      [
        'org-a',
        [{ customerId: 'org-a-customer', recencyDays: 5, frequency: 4, monetaryMinor: 2_000 }],
      ],
      [
        'org-b',
        [{ customerId: 'org-b-customer', recencyDays: 90, frequency: 1, monetaryMinor: 100 }],
      ],
    ]);
    const db = store();
    vi.mocked(db.readRfm).mockImplementation(
      async ({ where }) => tenantRows.get(where.organizationId) ?? []
    );

    const scores = await runChurnScoreBatch({
      organizationId: 'org-a',
      actorId: 'actor-a',
      store: db,
      can: async () => false,
    });

    expect(scores.map(({ customerId }) => customerId)).toEqual(['org-a-customer']);
    expect(db.readRfm).toHaveBeenCalledExactlyOnceWith({ where: { organizationId: 'org-a' } });
    expect(db.writeScore).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', customerId: 'org-a-customer' },
      })
    );
    expect(JSON.stringify(vi.mocked(db.writeScore).mock.calls)).not.toContain('org-b');
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
    expect(db.writeAudit).toHaveBeenCalledWith({
      actorId: 'actor-a',
      organizationId: 'org-a',
      action: 'AI_CHURN_EXPLANATION',
      oldValue: 'old',
      newValue: 'Aggregate-based explanation.',
      model: 'model-a',
      tier: 'standard',
    });
  });

  it('keeps AI off by default until this organization has a provider secret', async () => {
    const db = store();
    vi.mocked(db.hasAIProviderSecret).mockResolvedValue(false);
    const can = vi.fn().mockResolvedValue(true);
    const generate = vi.fn();
    await runChurnScoreBatch({
      organizationId: 'org-a',
      actorId: 'actor-a',
      store: db,
      can,
      explanation: { model: 'model-a', generate },
    });
    expect(db.hasAIProviderSecret).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId: 'org-a' },
    });
    expect(can).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(db.writeAudit).not.toHaveBeenCalled();
  });

  it('honors an explicit DENY from central can() over an otherwise configured AI path', async () => {
    const db = store();
    const can = vi.fn().mockResolvedValue(false);
    const generate = vi.fn();
    await runChurnScoreBatch({
      organizationId: 'org-a',
      actorId: 'actor-a',
      store: db,
      can,
      explanation: { model: 'model-a', generate },
    });
    expect(can).toHaveBeenCalledExactlyOnceWith('ai:churn:explain');
    expect(generate).not.toHaveBeenCalled();
    expect(db.readPreviousExplanation).not.toHaveBeenCalled();
    expect(db.writeAudit).not.toHaveBeenCalled();
  });

  it('writes one audit-log entry for every AI explanation action', async () => {
    const db = store();
    vi.mocked(db.readRfm).mockResolvedValue([
      { customerId: 'c1', recencyDays: 10, frequency: 6, monetaryMinor: 4_000 },
      { customerId: 'c2', recencyDays: 30, frequency: 2, monetaryMinor: 1_000 },
    ]);
    vi.mocked(db.readPreviousExplanation).mockImplementation(async ({ where }) =>
      where.customerId === 'c1' ? 'previous-c1' : null
    );
    const generate = vi
      .fn()
      .mockResolvedValueOnce('explanation-c1')
      .mockResolvedValueOnce('explanation-c2');

    await runChurnScoreBatch({
      organizationId: 'org-a',
      actorId: 'pharmacist-a',
      store: db,
      can: async () => true,
      explanation: { model: 'model-a', generate },
    });

    expect(db.writeAudit).toHaveBeenCalledTimes(2);
    expect(db.writeAudit).toHaveBeenNthCalledWith(1, {
      actorId: 'pharmacist-a',
      organizationId: 'org-a',
      action: 'AI_CHURN_EXPLANATION',
      oldValue: 'previous-c1',
      newValue: 'explanation-c1',
      model: 'model-a',
      tier: 'standard',
    });
    expect(db.writeAudit).toHaveBeenNthCalledWith(2, {
      actorId: 'pharmacist-a',
      organizationId: 'org-a',
      action: 'AI_CHURN_EXPLANATION',
      oldValue: null,
      newValue: 'explanation-c2',
      model: 'model-a',
      tier: 'standard',
    });
  });

  it('is idempotent for a retried deterministic batch', async () => {
    const rows = new Map<string, unknown>();
    const db = store();
    vi.mocked(db.writeScore).mockImplementation(async ({ where, score }) => {
      rows.set(`${where.organizationId}:${where.customerId}`, structuredClone(score));
    });
    const input = {
      organizationId: 'org-a',
      actorId: 'system',
      store: db,
      can: async () => false,
    };

    const first = await runChurnScoreBatch(input);
    const second = await runChurnScoreBatch(input);

    expect(second).toEqual(first);
    expect(rows.size).toBe(1);
    expect([...rows.keys()]).toEqual(['org-a:c1']);
    expect(db.writeScore).toHaveBeenCalledTimes(2);
  });
});
