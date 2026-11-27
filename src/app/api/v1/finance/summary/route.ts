import { workspaceDateRange, workspaceMonthRange } from '@/lib/timezone';
import { NextResponse } from 'next/server';
import { withApiAuth } from '@/lib/api-auth';
import { fromCurrencyGroups, diffByCurrency } from '@/lib/finance/currency';

export const GET = withApiAuth('finance:read', async (ctx, request) => {
  const url = new URL(request.url);
  const startDateParam = url.searchParams.get('startDate');
  const endDateParam = url.searchParams.get('endDate');

  const now = new Date();
  const org = await ctx.db.organization.findUnique({
    where: { id: ctx.organizationId },
    select: { timezone: true },
  });
  const zone = org?.timezone;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const startDate = startDateParam
    ? dateOnly.test(startDateParam)
      ? workspaceDateRange(startDateParam, startDateParam, zone).from
      : new Date(startDateParam)
    : workspaceMonthRange(zone, now).from;
  const endDate = endDateParam
    ? dateOnly.test(endDateParam)
      ? new Date(workspaceDateRange(endDateParam, endDateParam, zone).to.getTime() - 1)
      : new Date(endDateParam)
    : now;
  // FIN-02: every monetary aggregate is grouped BY currency so the JSON never
  // reports a USD + PKR sum as a single figure. Each total is an array of
  // { currency, amount } pairs.
  const [incomeG, expenseG, paidG, outstandingG, expenseByCategoryG] = await Promise.all([
    ctx.db.transaction.groupBy({
      by: ['currency'],
      _sum: { amount: true },
      _count: true,
      where: { type: 'INCOME', date: { gte: startDate, lte: endDate } },
    }),
    ctx.db.transaction.groupBy({
      by: ['currency'],
      _sum: { amount: true },
      _count: true,
      where: { type: 'EXPENSE', date: { gte: startDate, lte: endDate } },
    }),
    ctx.db.invoice.groupBy({
      by: ['currency'],
      _sum: { total: true },
      _count: true,
      where: { status: 'PAID' },
    }),
    ctx.db.invoice.groupBy({
      by: ['currency'],
      _sum: { total: true },
      _count: true,
      where: { status: { in: ['SENT', 'OVERDUE'] } },
    }),
    ctx.db.transaction.groupBy({
      by: ['category', 'currency'],
      _sum: { amount: true },
      where: { type: 'EXPENSE', date: { gte: startDate, lte: endDate } },
      orderBy: { _sum: { amount: 'desc' } },
    }),
  ]);

  const income = fromCurrencyGroups(incomeG, 'amount');
  const expense = fromCurrencyGroups(expenseG, 'amount');

  return NextResponse.json({
    data: {
      period: { startDate, endDate },
      income: { byCurrency: income, count: incomeG.reduce((s, g) => s + g._count, 0) },
      expense: { byCurrency: expense, count: expenseG.reduce((s, g) => s + g._count, 0) },
      profit: { byCurrency: diffByCurrency(income, expense) },
      invoices: {
        paid: {
          byCurrency: fromCurrencyGroups(paidG, 'total'),
          count: paidG.reduce((s, g) => s + g._count, 0),
        },
        outstanding: {
          byCurrency: fromCurrencyGroups(outstandingG, 'total'),
          count: outstandingG.reduce((s, g) => s + g._count, 0),
        },
      },
      expenseByCategory: expenseByCategoryG.map((c) => ({
        category: c.category || 'Uncategorized',
        currency: c.currency,
        amount: Number(c._sum.amount || 0),
      })),
    },
  });
});
