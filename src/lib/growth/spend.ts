import { zonedWallTimeToUtc } from '@/lib/restaurant/sop-recurrence';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type DiscountLine = {
  discountMinor: number;
  canonicalUnits: number;
  returnLines: { canonicalUnits: number }[];
  unidentifiedReturnHolds: { canonicalUnits: number }[];
};
export function remainingCampaignDiscount(line: DiscountLine) {
  const returned = [...line.returnLines, ...line.unidentifiedReturnHolds].reduce(
    (sum, row) => sum + row.canonicalUnits,
    0
  );
  return (
    line.discountMinor -
    Math.floor((line.discountMinor * Math.min(returned, line.canonicalUnits)) / line.canonicalUnits)
  );
}
export async function monthlyCampaignSpend(db: ScopedDb, organizationId: string, now: Date) {
  const organization = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { timezone: true },
  });
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: organization.timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const monthStart = zonedWallTimeToUtc(`${year}-${month}-01`, 0, organization.timezone).instant;
  const recipients = await db.campaignRecipient.findMany({
    where: {
      organizationId,
      redeemedAt: { gte: monthStart },
    },
    select: {
      sale: {
        select: {
          status: true,
          lines: { include: { returnLines: true, unidentifiedReturnHolds: true } },
        },
      },
    },
  });
  return recipients.reduce(
    (sum, r) =>
      sum +
      (r.sale && r.sale.status !== 'VOID'
        ? r.sale.lines.reduce((n, line) => n + remainingCampaignDiscount(line), 0)
        : 0),
    0
  );
}
/** The caller holds the growth lock before taking any sale/line locks. */
export async function releaseCampaignSpend(
  db: ScopedDb,
  organizationId: string,
  saleId: string,
  amount: number
) {
  if (amount <= 0) return;
  const recipient = await db.campaignRecipient.findFirst({
    where: { organizationId, saleId, status: 'redeemed' },
    include: { campaign: true },
  });
  if (!recipient) return;
  await db.campaign.update({
    where: { organizationId, id: recipient.campaignId },
    data: {
      spentMinor: { decrement: amount },
      ...(recipient.campaign.status === 'exhausted' ? { status: 'sent' } : {}),
    },
  });
}
