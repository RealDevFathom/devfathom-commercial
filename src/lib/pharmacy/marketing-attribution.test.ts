import { expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  eligibleMarketingReceipts,
  generateMarketingAttribution,
  ATTRIBUTION_METHOD,
} from './marketing-attribution';
const from = new Date('2026-10-01'),
  cutoff = new Date('2026-10-07');
it('writes an explicit receipt visit link only from qualifying delivery evidence; replay inserts nothing', async () => {
  const query = vi.fn().mockResolvedValue([
    {
      receiptId: 'r',
      campaignId: 'c',
      captureId: 'cap',
      completedAt: from,
      salesMinor: 800,
      marginMinor: 50,
    },
  ]);
  const create = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
  const db = {
    $queryRaw: query,
    pharmacyCampaignAttribution: { createMany: create },
  } as unknown as ScopedDb;
  const scope = { organizationId: 'org-a', branchId: 'b', actorId: 'a', timezone: 'UTC' };
  expect(await generateMarketingAttribution(db, scope, from, cutoff)).toMatchObject({ created: 1 });
  expect(await generateMarketingAttribution(db, scope, from, cutoff)).toMatchObject({ created: 0 });
  expect(create.mock.calls[0][0]).toMatchObject({
    skipDuplicates: true,
    data: {
      receiptId: 'r',
      visitId: 'receipt:r',
      method: ATTRIBUTION_METHOD,
      exclusions: { captureId: 'cap', cutoff: cutoff.toISOString() },
      recoveredSalesMinor: 800,
    },
  });
});
it('bounds eligibility by tenant, branch, matching customer, Meta delivery, seven days and return cutoff', async () => {
  const query = vi.fn().mockResolvedValue([]);
  await eligibleMarketingReceipts(
    { $queryRaw: query } as unknown as ScopedDb,
    'org-a',
    ['b'],
    from,
    cutoff
  );
  const sql = query.mock.calls[0][0];
  expect(sql.values).toContain('org-a');
  expect(sql.values).toContain('b');
  expect(sql.sql).toContain(`a.provider = 'meta'`);
  expect(sql.sql).toContain(`c."customerId" = s."customerId"`);
  expect(sql.sql).toContain(`interval '7 days'`);
  expect(sql.sql).toContain('pharmacy_sale_return_lines');
  expect(sql.sql).toContain('pharmacy_unidentified_return_holds');
  expect(sql.sql).toContain(`entry."sourceKind" = 'PHARMACY_UNIDENTIFIED_RETURN_HOLD'`);
  expect(sql.sql).toContain(`e."sourceKind"='PHARMACY_UNIDENTIFIED_RETURN_HOLD'`);
  expect(sql.sql).toContain('finance_journal_lines');
  expect(sql.sql).not.toContain('l."unitCostMinor" * l."canonicalUnits"');
  expect(sql.sql).toContain('money.margin::integer AS "marginMinor"');
  expect(sql.sql).not.toContain('GREATEST(0, money.margin)');
});

it('retains signed posted margin for an eligible loss-making receipt', async () => {
  const create = vi.fn().mockResolvedValue({ count: 1 });
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([
      {
        receiptId: 'loss-receipt',
        campaignId: 'c',
        captureId: 'cap',
        completedAt: from,
        salesMinor: 800,
        marginMinor: -50,
      },
    ]),
    pharmacyCampaignAttribution: { createMany: create },
  } as unknown as ScopedDb;
  await generateMarketingAttribution(
    db,
    { organizationId: 'org-a', branchId: 'b', actorId: 'a', timezone: 'UTC' },
    from,
    cutoff
  );
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ recoveredMarginMinor: -50 }) })
  );
});
it('allows ninety local calendar days across a daylight-saving change and no more', async () => {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyCampaignAttribution: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  } as unknown as ScopedDb;
  const scope = {
    organizationId: 'org-a',
    branchId: 'b',
    actorId: 'a',
    timezone: 'America/New_York',
  };
  await expect(
    generateMarketingAttribution(
      db,
      scope,
      new Date('2026-09-01T04:00:00Z'),
      new Date('2026-11-30T05:00:00Z')
    )
  ).resolves.toMatchObject({ created: 0 });
  await expect(
    generateMarketingAttribution(
      db,
      scope,
      new Date('2026-09-01T04:00:00Z'),
      new Date('2026-12-01T05:00:00Z')
    )
  ).rejects.toThrow('at most 90 days');
});
