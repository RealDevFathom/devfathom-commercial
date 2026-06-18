import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';

export const GET = withApiAuth('finance:read', async (_ctx, request) => {
  const url = new URL(request.url);
  const startDateParam = url.searchParams.get('startDate');
  const endDateParam = url.searchParams.get('endDate');

  const now = new Date();
  const startDate = startDateParam
    ? new Date(startDateParam)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const endDate = endDateParam ? new Date(endDateParam) : now;

  const [income, expense, paidInvoices, outstandingInvoices, expenseByCategory] = await Promise.all(
    [
      db.transaction.aggregate({
        _sum: { amount: true },
        _count: true,
        where: { type: 'INCOME', date: { gte: startDate, lte: endDate } },
      }),
      db.transaction.aggregate({
        _sum: { amount: true },
        _count: true,
        where: { type: 'EXPENSE', date: { gte: startDate, lte: endDate } },
      }),
      db.invoice.aggregate({
        _sum: { total: true },
        _count: true,
        where: { status: 'PAID' },
      }),
      db.invoice.aggregate({
        _sum: { total: true },
        _count: true,
        where: { status: { in: ['SENT', 'OVERDUE'] } },
      }),
      db.transaction.groupBy({
        by: ['category'],
        _sum: { amount: true },
        where: { type: 'EXPENSE', date: { gte: startDate, lte: endDate } },
        orderBy: { _sum: { amount: 'desc' } },
      }),
    ]
  );

  const totalIncome = Number(income._sum.amount || 0);
  const totalExpense = Number(expense._sum.amount || 0);

  return NextResponse.json({
    data: {
      period: { startDate, endDate },
      income: { total: totalIncome, count: income._count },
      expense: { total: totalExpense, count: expense._count },
      profit: totalIncome - totalExpense,
      margin: totalIncome > 0 ? ((totalIncome - totalExpense) / totalIncome) * 100 : 0,
      invoices: {
        paid: { total: Number(paidInvoices._sum.total || 0), count: paidInvoices._count },
        outstanding: {
          total: Number(outstandingInvoices._sum.total || 0),
          count: outstandingInvoices._count,
        },
      },
      expenseByCategory: expenseByCategory.map((c) => ({
        category: c.category || 'Uncategorized',
        amount: Number(c._sum.amount || 0),
      })),
    },
  });
});
