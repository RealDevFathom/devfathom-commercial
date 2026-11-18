import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  readPharmacyMarketingReport,
  summarizeStoredMarketingAttribution,
  validateMarketingReportFilters,
  type StoredMarketingAttribution,
} from './marketing-report';

const filters = { branchIds: ['branch-a'], from: '2026-10-01', to: '2026-10-06' };
const link = (overrides: Partial<StoredMarketingAttribution> = {}): StoredMarketingAttribution => ({
  id: 'link-a',
  campaignId: 'campaign-a',
  visitId: 'visit-a',
  receiptId: 'receipt-a',
  attributedAt: new Date('2026-10-04T12:00:00Z'),
  method: 'LAST_CAPTURE_BEFORE_VISIT',
  windowDays: 7,
  confidence: 'LOW',
  recoveredSalesMinor: 1000,
  recoveredMarginMinor: 100,
  messageCostMinor: 10,
  ...overrides,
});

describe('marketing report evidence', () => {
  it.each([
    { ...filters, from: '2026-02-30' },
    { ...filters, to: '2026-09-30' },
    { ...filters, branchIds: [] },
    { ...filters, from: '2026-01-01' },
  ])('rejects invalid or unbounded filters before reading', async (input) => {
    expect(() => validateMarketingReportFilters(input)).toThrow('valid UTC dates');
    await expect(readPharmacyMarketingReport({} as ScopedDb, 'org-a', input)).rejects.toThrow();
  });

  it('uses inclusive UTC days', () => {
    expect(validateMarketingReportFilters(filters)).toEqual({
      gte: new Date('2026-10-01T00:00:00Z'),
      lt: new Date('2026-10-07T00:00:00Z'),
    });
  });

  it('does not inflate totals with competing campaign or visit links; order is stable', () => {
    const rows = [
      link(),
      link({ id: 'link-z', campaignId: 'campaign-z', recoveredSalesMinor: 9000 }),
      link({ id: 'old', attributedAt: new Date('2026-10-03'), recoveredSalesMinor: 8000 }),
      link({ id: 'other', receiptId: 'receipt-b', recoveredSalesMinor: 2000 }),
    ];
    const report = summarizeStoredMarketingAttribution(rows);
    expect(summarizeStoredMarketingAttribution([...rows].reverse())).toEqual(report);
    expect(report).toMatchObject({
      estimated: true,
      attributedReceipts: 2,
      excludedCompetingLinks: 2,
      recoveredSalesMinor: 3000,
      recoveredMarginMinor: 200,
      linkedMessageCostMinor: 20,
      methods: ['LAST_CAPTURE_BEFORE_VISIT'],
    });
  });

  it('reads persisted events with tenant, branch and period predicates; keeps unavailable delivery unknown', async () => {
    const capture = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 3 }, (_, i) => ({ id: String(i), dispatchAttempts: [] }))
      );
    const exclusion = vi.fn().mockResolvedValue([{ reason: 'OPTED_OUT', _count: { _all: 2 } }]);
    const optOut = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(4);
    const attribution = vi.fn().mockResolvedValue([link()]);
    const db = {
      pharmacyCampaignCapture: { findMany: capture },
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyCampaignExclusion: { groupBy: exclusion },
      pharmacyMessageLog: { count: optOut },
      pharmacyCampaignAttribution: { findMany: attribution },
    } as unknown as ScopedDb;
    const report = await readPharmacyMarketingReport(db, 'org-a', filters);
    expect(report).toMatchObject({
      prepared: 3,
      providerAccepted: 0,
      delivered: 0,
      failed: 0,
      unknown: 3,
      deliveryEvidenceAvailable: true,
      consentOptOuts: 1,
      unassignedConsentOptOuts: 4,
      optedOutExclusions: 2,
    });
    for (const query of [capture, exclusion, attribution]) {
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-a',
            branchId: { in: ['branch-a'] },
          }),
        })
      );
    }
    expect(capture.mock.calls[0][0].where.capturedAt).toEqual(
      validateMarketingReportFilters(filters)
    );
    expect(exclusion.mock.calls[0][0].where.evaluatedAt).toEqual(
      validateMarketingReportFilters(filters)
    );
    expect(attribution.mock.calls[0][0].where.attributedAt).toEqual(
      validateMarketingReportFilters(filters)
    );
    expect(optOut).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: 'org-a',
        branchId: null,
        direction: 'INBOUND',
        kind: 'OPT_OUT',
        createdAt: validateMarketingReportFilters(filters),
        status: { in: ['RECEIVED', 'SENT'] },
      },
    });
    expect(report).not.toHaveProperty('customers');
    expect(report.attribution).not.toHaveProperty('links');
  });

  it('reports zero observed delivery for an empty capture cohort', async () => {
    const db = {
      pharmacyCampaignCapture: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyCampaignExclusion: { groupBy: vi.fn().mockResolvedValue([]) },
      pharmacyMessageLog: { count: vi.fn().mockResolvedValue(0) },
      pharmacyCampaignAttribution: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as ScopedDb;
    expect(await readPharmacyMarketingReport(db, 'org-a', filters)).toMatchObject({
      prepared: 0,
      unknown: 0,
      delivered: 0,
      providerAccepted: 0,
      failed: 0,
      attribution: { attributedReceipts: 0, recoveredSalesMinor: 0 },
    });
  });
});

it('separates sandbox outcomes and legacy ambiguity; revalues verified receipt returns at cutoff', async () => {
  const { ATTRIBUTION_METHOD } = await import('./marketing-attribution');
  const stored = link({
    method: ATTRIBUTION_METHOD,
    visitId: 'receipt:receipt-a',
    recoveredSalesMinor: 1000,
  });
  const db = {
    pharmacyCampaignCapture: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'live',
          dispatchAttempts: [
            {
              provider: 'meta',
              events: [
                { state: 'PROVIDER_ACCEPTED', reason: null },
                { state: 'DELIVERED', reason: null },
              ],
            },
          ],
        },
        {
          id: 'sandbox',
          dispatchAttempts: [
            {
              provider: 'sandbox',
              events: [
                { state: 'PROVIDER_ACCEPTED', reason: null },
                { state: 'DELIVERED', reason: null },
              ],
            },
          ],
        },
        { id: 'legacy', dispatchAttempts: [] },
      ]),
    },
    pharmacyCampaignExclusion: { groupBy: vi.fn().mockResolvedValue([]) },
    pharmacyMessageLog: { count: vi.fn().mockResolvedValue(0) },
    pharmacyCampaignAttribution: {
      findMany: vi.fn().mockResolvedValue([stored, link({ id: 'legacy', receiptId: 'receipt-z' })]),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValue([
        { receiptId: 'receipt-a', campaignId: 'campaign-a', salesMinor: 500, marginMinor: 50 },
      ]),
  } as unknown as ScopedDb;
  expect(await readPharmacyMarketingReport(db, 'org-a', filters)).toMatchObject({
    prepared: 3,
    providerAccepted: 1,
    delivered: 1,
    unknown: 2,
    preparationOnly: 1,
    sandbox: { captures: 1, accepted: 1, delivered: 1 },
    attribution: {
      attributedReceipts: 1,
      recoveredSalesMinor: 500,
      recoveredMarginMinor: 50,
      linkedMessageCostMinor: null,
      excludedUnverifiedLinks: 1,
    },
  });
});

describe('DEV-943 marketing report counts the organisation’s days', () => {
  function windowDb() {
    const capture = vi.fn().mockResolvedValue([]);
    const exclusion = vi.fn().mockResolvedValue([]);
    const optOut = vi.fn().mockResolvedValue(0);
    const attribution = vi.fn().mockResolvedValue([]);
    const db = {
      pharmacyCampaignCapture: { findMany: capture },
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyCampaignExclusion: { groupBy: exclusion },
      pharmacyMessageLog: { count: optOut },
      pharmacyCampaignAttribution: { findMany: attribution },
    } as unknown as ScopedDb;
    return { db, capture, exclusion, optOut, attribution };
  }
  const day = { branchIds: ['branch-a'], from: '2026-11-19', to: '2026-11-19' };

  it('reads shop midnight to shop midnight for a Karachi organisation', async () => {
    const { db, capture, exclusion, optOut, attribution } = windowDb();
    const report = await readPharmacyMarketingReport(db, 'org-a', day, 'Asia/Karachi');
    // 19 Nov in Karachi runs from 19:00 UTC on 18 Nov to 19:00 UTC on 19 Nov.
    const window = {
      gte: new Date('2026-11-18T19:00:00.000Z'),
      lt: new Date('2026-11-19T19:00:00.000Z'),
    };
    expect(capture.mock.calls[0][0].where.capturedAt).toEqual(window);
    expect(exclusion.mock.calls[0][0].where.evaluatedAt).toEqual(window);
    expect(attribution.mock.calls[0][0].where.attributedAt).toEqual(window);
    expect(optOut.mock.calls[0][0].where.createdAt).toEqual(window);
    expect(optOut.mock.calls[1][0].where.createdAt).toEqual(window);
    expect(report.period).toEqual({
      from: '2026-11-19',
      to: '2026-11-19',
      timezone: 'Asia/Karachi',
    });
    expect(report.cutoff).toBe('2026-11-19T19:00:00.000Z');
    // A capture at 19:30 UTC on 18 Nov counts on 19 Nov; one at 18:59 UTC does not.
    const inWindow = (at: string) => new Date(at) >= window.gte && new Date(at) < window.lt;
    expect(inWindow('2026-11-18T19:30:00.000Z')).toBe(true);
    expect(inWindow('2026-11-18T18:59:00.000Z')).toBe(false);
  });

  it.each([['UTC'], [null], [undefined], ['PKT']])(
    'keeps the UTC window for a %s organisation, exactly as before',
    async (zone) => {
      const { db, capture, attribution } = windowDb();
      const report = await readPharmacyMarketingReport(db, 'org-a', filters, zone);
      expect(capture.mock.calls[0][0].where.capturedAt).toEqual(
        validateMarketingReportFilters(filters)
      );
      expect(attribution.mock.calls[0][0].where.attributedAt).toEqual(
        validateMarketingReportFilters(filters)
      );
      expect(report.period.timezone).toBe('UTC');
    }
  );
});
