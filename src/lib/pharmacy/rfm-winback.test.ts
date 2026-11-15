import { describe, expect, it } from 'vitest';
import {
  computeRfmSegments,
  planRfmWinBack,
  validateNonDrugOffer,
  type RfmCustomerFacts,
} from './rfm-winback';

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

const OFFER_TEXT = 'Save on personal-care essentials. Reply STOP to opt out.';
const reviewed = (body = OFFER_TEXT) => ({
  body,
  approvedByUserId: 'owner-1',
  approvedAt: new Date('2026-10-01T00:00:00Z'),
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
      expect(() => planRfmWinBack([], { ...config, winBackChurnScore }, reviewed())).toThrow(
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
            reviewed()
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
        planRfmWinBack([customer], { ...config, winBackChurnScore: churnScore }, reviewed())
      ).toEqual([
        {
          customerId: customer.customerId,
          kind: 'NON_DRUG_MARKETING',
          text: `${OFFER_TEXT}\nMedicines excluded / Adviyaat shamil nahin`,
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
      reviewed('Save 20% on skincare. Reply STOP to opt out.')
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
        reviewed()
      )
    ).toEqual([]);
  });

  it('sends non-drug offers only with marketing consent and above configured churn threshold', () => {
    const customers = [
      fixture({ customerId: 'consented', marketingWhatsAppConsent: true }),
      fixture({ customerId: 'no-consent' }),
      fixture({ customerId: 'below-score', churnScore: 0.69, marketingWhatsAppConsent: true }),
    ];
    expect(planRfmWinBack(customers, config, reviewed())).toEqual([
      {
        customerId: 'consented',
        kind: 'NON_DRUG_MARKETING',
        // DEV-27: the required voucher footer is auto-added.
        text: 'Save on personal-care essentials. Reply STOP to opt out.\nMedicines excluded / Adviyaat shamil nahin',
        includesOffer: true,
      },
    ]);
  });

  it.each([
    'Save on antibiotics. Reply STOP to opt out.',
    'Painkillers 10% off this week. Reply STOP to opt out.',
    'Paracetamol deals inside. Reply STOP to opt out.',
    'Vitamin bundle savings. Reply STOP to opt out.',
    'Buy 2 get 1 on 500 mg packs. Reply STOP to opt out.',
    'Cough syrup offer today. Reply STOP to opt out.',
    'Discount on your medicines. Reply STOP to opt out.',
  ])('rejects offer copy naming a drug, salt or medicine category: %s', (body) => {
    expect(() =>
      planRfmWinBack([fixture({ marketingWhatsAppConsent: true })], config, reviewed(body))
    ).toThrow(/drug, salt or medicine/);
  });

  it('rejects offer copy that is not an owner-approved template', () => {
    for (const offer of [
      { body: OFFER_TEXT, approvedByUserId: null, approvedAt: new Date() },
      { body: OFFER_TEXT, approvedByUserId: 'owner-1', approvedAt: null },
    ])
      expect(() => planRfmWinBack([], config, offer)).toThrow(/owner-approved/);
  });

  it('rejects empty offers and offers without STOP opt-out instructions', () => {
    expect(() => validateNonDrugOffer(reviewed('   '))).toThrow(/required/);
    expect(() => validateNonDrugOffer(reviewed('Save on personal-care essentials.'))).toThrow(
      /STOP/
    );
  });

  it('accepts reviewed generic retail copy', () => {
    expect(validateNonDrugOffer(reviewed())).toBe(OFFER_TEXT);
  });
});
