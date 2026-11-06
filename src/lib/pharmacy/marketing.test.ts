import { describe, expect, it } from 'vitest';

import { buildCapturePlan, buildAttributionReport, validateSegmentDefinition } from './marketing';

describe('pharmacy marketing invariants', () => {
  it.each(['prescription', 'condition', 'allergy', 'medicine'])(
    'rejects protected clinical field %s at segment definition time',
    (field) => {
      expect(() =>
        validateSegmentDefinition({ version: 1, all: [{ field, operator: 'eq', value: 'x' }] })
      ).toThrow('Clinical and medicine data cannot be used in marketing segments.');
    }
  );

  it('accepts the nightly churn score as a retail segment field', () => {
    expect(() =>
      validateSegmentDefinition({
        version: 1,
        all: [{ field: 'churnScore', operator: 'gte', value: 70 }],
      })
    ).not.toThrow();
  });

  it('fails closed for regulated-item outreach while D10 is unapproved', () => {
    expect(() =>
      buildCapturePlan({
        campaignId: 'campaign-1',
        channel: 'SMS',
        purpose: 'MARKETING',
        template: { approved: true, body: 'A retail offer for you.' },
        ownerApproval: { approved: true },
        regulatoryApproval: { d10Approved: false },
        promotesRegulatedItem: true,
        candidates: [],
        now: new Date('2026-09-05T12:00:00Z'),
        quietHours: { startHour: 22, endHour: 8 },
        frequencyCap: { max: 2, windowDays: 7 },
      })
    ).toThrow('This campaign cannot run because regulated-item outreach is not approved.');
  });

  it('excludes an opted-out customer with auditable reason and captures no send', () => {
    const result = buildCapturePlan({
      campaignId: 'campaign-1',
      channel: 'SMS',
      purpose: 'MARKETING',
      template: { approved: true, body: 'Your front-shop offer is ready.' },
      ownerApproval: { approved: true },
      regulatoryApproval: { d10Approved: false },
      promotesRegulatedItem: false,
      candidates: [
        {
          customerId: 'customer-1',
          consent: { granted: false, effectiveAt: new Date('2026-09-05T11:00:00Z') },
          priorCaptures: [],
        },
      ],
      now: new Date('2026-09-05T12:00:00Z'),
      quietHours: { startHour: 22, endHour: 8 },
      frequencyCap: { max: 2, windowDays: 7 },
    });

    expect(result.captures).toEqual([]);
    expect(result.exclusions).toEqual([
      expect.objectContaining({ customerId: 'customer-1', reason: 'OPTED_OUT' }),
    ]);
  });

  it('reports estimated campaign to visit to receipt attribution without message volume', () => {
    const report = buildAttributionReport({
      campaignId: 'campaign-1',
      method: 'LAST_CAPTURE_BEFORE_VISIT',
      windowDays: 7,
      exclusions: ['returns', 'visits before capture'],
      confidence: 'LOW',
      links: [
        {
          visitId: 'visit-1',
          receiptId: 'receipt-1',
          recoveredSalesMinor: 2500,
          recoveredMarginMinor: 700,
          messageCostMinor: 50,
        },
      ],
    });

    expect(report).toMatchObject({
      campaignId: 'campaign-1',
      estimated: true,
      method: 'LAST_CAPTURE_BEFORE_VISIT',
      windowDays: 7,
      recoveredSalesMinor: 2500,
      recoveredMarginMinor: 700,
      messageCostMinor: 50,
      costPerRecoveredSaleMinor: 50,
      links: [{ visitId: 'visit-1', receiptId: 'receipt-1' }],
    });
    expect(report).not.toHaveProperty('messageVolume');
  });
});
