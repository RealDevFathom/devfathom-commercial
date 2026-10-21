import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { budgetMonthStart } from './budget';
import { calendar, DAY, localDate } from './calendar';
export function revenueByWeekday(
  sales: Array<{
    completedAt: Date | null;
    lines: Array<{ quantity: number; unitPriceMinor: number; discountMinor: number }>;
  }>
) {
  const totals = Array<number>(7).fill(0);
  for (const sale of sales)
    if (sale.completedAt)
      totals[localDate(sale.completedAt).getUTCDay()] += sale.lines.reduce(
        (s, l) => s + l.quantity * l.unitPriceMinor - l.discountMinor,
        0
      );
  const mean = totals.reduce((a, b) => a + b, 0) / 7;
  return totals.map((revenueMinor, weekday) => ({
    weekday,
    revenueMinor,
    slow: revenueMinor < mean * 0.8,
  }));
}
export async function plannerSignals(
  db: ScopedDb,
  organizationId: string,
  now: Date,
  settings: { monthlyBudgetMinor: number; customDates: unknown }
) {
  const sales = await db.pharmacySale.findMany({
    where: {
      organizationId,
      status: 'COMPLETED',
      completedAt: { gte: new Date(now.getTime() - 56 * DAY), lte: now },
    },
    select: {
      completedAt: true,
      lines: { select: { quantity: true, unitPriceMinor: true, discountMinor: true } },
    },
  });
  const customers = await db.pharmacyCustomer.findMany({
    where: { organizationId, active: true, whatsappOptIn: true, whatsappE164: { not: null } },
    select: { patient: { select: { dateOfBirth: true } }, growthMetrics: true },
  });
  const recent = await db.campaign.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      kind: true,
      estimatedReach: true,
      spentMinor: true,
      _count: { select: { recipients: { where: { redeemedAt: { not: null } } } } },
    },
  });
  const monthStart = await budgetMonthStart(db, organizationId, now);
  const redeemed = await db.campaignRecipient.findMany({
    where: {
      organizationId,
      redeemedAt: { gte: monthStart, lte: now },
    },
    select: { sale: { select: { lines: { select: { discountMinor: true } } } } },
  });
  const spent = redeemed.reduce(
    (s, r) => s + (r.sale?.lines.reduce((v, l) => v + l.discountMinor, 0) ?? 0),
    0
  );
  const days = calendar(now, settings.customDates);
  const birthdays = customers.filter(
    (c) =>
      c.patient.dateOfBirth &&
      days.some((d) => d.date.slice(5) === c.patient.dateOfBirth!.toISOString().slice(5, 10))
  ).length;
  const sent = await db.campaignRecipient.count({
    where: { organizationId, sentAt: { not: null } },
  });
  const redemptions = await db.campaignRecipient.count({
    where: { organizationId, redeemedAt: { not: null } },
  });
  const revenue = revenueByWeekday(sales);
  return {
    days,
    revenueByWeekday: revenue,
    segments: {
      high: customers.filter((c) => c.growthMetrics?.churnBand === 'high').length,
      medium: customers.filter((c) => c.growthMetrics?.churnBand === 'medium').length,
      birthdays,
      refillDue: customers.filter(
        (c) =>
          c.growthMetrics?.nextRefillDueAt &&
          c.growthMetrics.nextRefillDueAt >= now &&
          c.growthMetrics.nextRefillDueAt.getTime() < now.getTime() + 14 * DAY
      ).length,
      optedIn: customers.length,
    },
    remainingBudgetMinor: Math.max(0, settings.monthlyBudgetMinor - spent),
    averageBasketMinor: sales.length
      ? Math.round(revenue.reduce((s, d) => s + d.revenueMinor, 0) / sales.length)
      : 0,
    redemptionRate: sent ? redemptions / sent : 0.08,
    recentCampaigns: recent.map((c) => ({
      kind: c.kind,
      reach: c.estimatedReach,
      redemptions: c._count.recipients,
      spendMinor: c.spentMinor,
    })),
  };
}
