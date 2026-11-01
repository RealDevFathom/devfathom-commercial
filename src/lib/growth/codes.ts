import { TRPCError } from '@trpc/server';
import { monthlyCampaignSpend } from './spend';
import { randomBytes } from 'node:crypto';
import type { Campaign } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { validateDiscount } from '@/lib/pharmacy/sales';

export function campaignCode(name: string) {
  const prefix = (name.replace(/[^a-z]/gi, '').toUpperCase() + 'SHOP').slice(0, 4);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return `${prefix}-${[...randomBytes(6)].map((b) => alphabet[b & 31]).join('')}`;
}
export function discountFor(
  campaign: Pick<Campaign, 'discountType' | 'discountValue'>,
  grossMinor: number
) {
  return campaign.discountType === 'percent'
    ? Math.floor((grossMinor * (campaign.discountValue ?? 0)) / 100)
    : campaign.discountType === 'fixed'
      ? Math.min(grossMinor, campaign.discountValue ?? 0)
      : 0;
}
/** Caller holds the tenant transaction; serialize spend, scheduling and redemption. */
export async function lockGrowth(db: ScopedDb, organizationId: string) {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`growth:${organizationId}`}, 0))::text`;
}
export function validateCode(
  recipient: { redeemedAt: Date | null; status: string; customerId: string },
  campaign: Pick<Campaign, 'status' | 'codeExpiresAt' | 'spentMinor' | 'budgetCapMinor'>,
  customerId: string | null,
  now: Date
) {
  if (
    !['sending', 'sent'].includes(campaign.status) ||
    (campaign.codeExpiresAt && campaign.codeExpiresAt <= now) ||
    recipient.redeemedAt ||
    ['redeemed', 'skipped', 'failed'].includes(recipient.status) ||
    customerId !== recipient.customerId ||
    campaign.spentMinor >= campaign.budgetCapMinor
  )
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Campaign code is unavailable.' });
}
export async function redeemCode(
  db: ScopedDb,
  organizationId: string,
  input: { code: string; saleId: string; branchId: string },
  now = new Date()
) {
  await lockGrowth(db, organizationId);
  const recipient = await db.campaignRecipient.findFirst({
    where: { organizationId, code: input.code.trim().toUpperCase() },
    include: { campaign: true },
  });
  if (!recipient)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Campaign code is unavailable.' });
  let sale = await db.pharmacySale.findFirst({
    where: { organizationId, id: input.saleId, branchId: input.branchId },
    include: { lines: { include: { medicine: true } } },
  });
  if (!sale || sale.status !== 'OPEN' || sale.discountCode || !sale.lines.length)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'An open sale without a campaign code is required.',
    });
  // Same row lock protocol as addSaleLine: tender/void cannot race the discount.
  const locked = await db.pharmacySale.updateMany({
    where: { organizationId, id: sale.id, status: 'OPEN', discountCode: null },
    data: { status: 'OPEN' },
  });
  if (locked.count !== 1)
    throw new TRPCError({ code: 'CONFLICT', message: 'Sale changed; retry.' });
  sale = await db.pharmacySale.findFirstOrThrow({
    where: { organizationId, id: input.saleId, branchId: input.branchId },
    include: { lines: { include: { medicine: true } } },
  });
  const campaign = recipient.campaign;
  validateCode(recipient, campaign, sale.customerId, now);
  const settings = await db.growthSettings.findUniqueOrThrow({ where: { organizationId } });
  const monthSpent = await monthlyCampaignSpend(db, organizationId, now);
  // Meta policy: never promote any medicine, including OTC. Only front-shop products.
  const eligible = sale.lines.filter(
    (l) =>
      l.medicine.productFamily === 'FRONT_SHOP' &&
      !l.medicine.rx &&
      !l.medicine.restricted &&
      !l.medicine.controlled
  );
  if (!eligible.length || sale.lines.some((l) => l.discountMinor > 0))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Code requires non-medicine items without an existing discount.',
    });
  const gross = eligible.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
  const discount = discountFor(campaign, gross);
  if (
    discount <= 0 ||
    campaign.spentMinor + discount > campaign.budgetCapMinor ||
    monthSpent + discount > settings.monthlyBudgetMinor
  )
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Campaign budget exceeded.' });
  let remaining = discount;
  for (const [index, line] of eligible.entries()) {
    const lineGross = line.quantity * line.unitPriceMinor;
    const amount =
      index === eligible.length - 1 ? remaining : Math.floor((discount * lineGross) / gross);
    remaining -= amount;
    validateDiscount({
      regulated: false,
      discountMinor: amount,
      grossMinor: lineGross,
      costMinor: line.unitCostMinor * line.quantity,
      approvedByUserId: campaign.approvedBy ?? undefined,
      approvalPolicy: `growth:${campaign.id}`,
    });
    await db.pharmacySaleLine.update({
      where: { id: line.id },
      data: {
        discountMinor: amount,
        discountKind: 'PROMOTION',
        approvedByUserId: campaign.approvedBy,
        approvalPolicy: `growth:${campaign.id}`,
      },
    });
  }
  await db.pharmacySale.update({
    where: { id: sale.id },
    data: { discountCode: recipient.code },
  });
  await db.campaignRecipient.update({
    where: { id: recipient.id },
    data: { status: 'redeemed', redeemedAt: now, saleId: sale.id },
  });
  await db.campaign.update({
    where: { id: campaign.id },
    data: {
      spentMinor: { increment: discount },
      ...(campaign.spentMinor + discount >= campaign.budgetCapMinor ? { status: 'exhausted' } : {}),
    },
  });
  return { customerId: recipient.customerId, discountMinor: discount };
}
