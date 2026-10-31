import { describe, expect, it } from 'vitest';
import { computeRfmSegments, planRfmWinBack, type RfmCustomerFacts } from './rfm-winback';

const config = {
  recencyDays: [7, 30, 60, 90] as const,
  frequencyReceipts: [2, 4, 8, 12] as const,
  monetaryMinor: [1_000, 5_000, 10_000, 20_000] as const,
  winBackChurnScore: 0.7,
  clvProjectionPeriods: 2,
};

const fixture = (overrides: Partial<RfmCustomerFacts> = {}): RfmCustomerFacts => ({
  customerId: 'customer-1',
  daysSinceLastReceipt: 3,
  receiptCount: 15,
  completedSalesMinor: 30_000,
  observedPeriods: 3,
  churnScore: 0.8,
  hasDrugPurchase: false,
  refillDue: false,
  reminderWhatsAppConsent: false,
  marketingWhatsAppConsent: false,
  ...overrides,
});

describe('RFM segmentation', () => {
  it.each([NaN, Infinity, -Infinity, -0.01, 1.01])(
    'rejects invalid churn score %s',
    (churnScore) => {
      expect(() => computeRfmSegments([fixture({ churnScore })], config)).toThrow(/churnScore/);
    }
  );

  it('computes auditable segments and labels projected CLV as an estimate', () => {
    expect(
      computeRfmSegments(
        [
          fixture(),
          fixture({
            customerId: 'at-risk',
            daysSinceLastReceipt: 95,
            receiptCount: 8,
            completedSalesMinor: 10_000,
          }),
        ],
        config
      )
    ).toEqual([
      expect.objectContaining({
        customerId: 'customer-1',
        recencyScore: 5,
        frequencyScore: 5,
        monetaryScore: 5,
        segment: 'CHAMPION',
        observedValueMinor: 30_000,
        estimatedClvMinor: 50_000,
        clvIsEstimate: true,
      }),
      expect.objectContaining({ customerId: 'at-risk', recencyScore: 1, segment: 'AT_RISK' }),
    ]);
  });

  it('uses only configurable boundaries and an existing churn score', () => {
    const [result] = computeRfmSegments(
      [fixture({ daysSinceLastReceipt: 7, churnScore: 0.73 })],
      config
    );
    expect(result).toMatchObject({ recencyScore: 4, churnScore: 0.73 });
  });
});

describe('RFM win-back policy', () => {
  it.each([NaN, Infinity, -Infinity, -0.01, 1.01])(
    'rejects invalid win-back threshold %s even without customers',
    (winBackChurnScore) => {
      expect(() => planRfmWinBack([], { ...config, winBackChurnScore }, 'Non-drug offer')).toThrow(
        /winBackChurnScore/
      );
    }
  );

  it.each([NaN, Infinity, -Infinity, -0.01, 1.01])(
    'rejects invalid churn score %s before planning either action',
    (churnScore) => {
      for (const hasDrugPurchase of [false, true]) {
        expect(() =>
          planRfmWinBack(
            [
              fixture({
                churnScore,
                hasDrugPurchase,
                refillDue: true,
                reminderWhatsAppConsent: true,
                marketingWhatsAppConsent: true,
              }),
            ],
            config,
            'Non-drug offer'
          )
        ).toThrow(/churnScore/);
      }
    }
  );

  it.each([0, config.winBackChurnScore, 1])(
    'includes valid scores at threshold %s',
    (churnScore) => {
      const customer = fixture({ churnScore, marketingWhatsAppConsent: true });
      expect(computeRfmSegments([customer], config)[0]?.churnScore).toBe(churnScore);
      expect(
        planRfmWinBack([customer], { ...config, winBackChurnScore: churnScore }, 'Non-drug offer')
      ).toEqual([
        {
          customerId: customer.customerId,
          kind: 'NON_DRUG_MARKETING',
          text: 'Non-drug offer',
          includesOffer: true,
        },
      ]);
    }
  );

  it('uses fixed offer-free generic utility copy for every drug customer', () => {
    const [action] = planRfmWinBack(
      [
        fixture({
          hasDrugPurchase: true,
          refillDue: true,
          reminderWhatsAppConsent: true,
          marketingWhatsAppConsent: true,
        }),
      ],
      config,
      'Save 20% on skincare'
    );
    expect(action).toEqual({
      customerId: 'customer-1',
      kind: 'REFILL_DUE_UTILITY',
      text: 'Your refill may be due soon. Reply YES if you would like the pharmacy team to contact you.',
      includesOffer: false,
    });
    expect(action?.text).not.toMatch(/20%|skincare|drug|medicine|tablet|capsule|salt/i);
  });

  it('never falls back to marketing for a drug customer without reminder consent', () => {
    expect(
      planRfmWinBack(
        [fixture({ hasDrugPurchase: true, refillDue: true, marketingWhatsAppConsent: true })],
        config,
        'Non-drug offer'
      )
    ).toEqual([]);
  });

  it('sends non-drug offers only with marketing consent and above configured churn threshold', () => {
    const customers = [
      fixture({ customerId: 'consented', marketingWhatsAppConsent: true }),
      fixture({ customerId: 'no-consent' }),
      fixture({ customerId: 'below-score', churnScore: 0.69, marketingWhatsAppConsent: true }),
    ];
    expect(
      planRfmWinBack(customers, config, 'Save on personal-care essentials. Reply STOP to opt out.')
    ).toEqual([
      {
        customerId: 'consented',
        kind: 'NON_DRUG_MARKETING',
        text: 'Save on personal-care essentials. Reply STOP to opt out.',
        includesOffer: true,
      },
    ]);
  });
});
