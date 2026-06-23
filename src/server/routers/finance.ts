import { z } from 'zod';
import { router, adminProcedure } from '../trpc';
import { logActivity } from '../activity';
import { TRPCError } from '@trpc/server';
import {
  fromCurrencyGroups,
  diffByCurrency,
  sumByCurrency,
  currenciesPresent,
  type CurrencyAmount,
} from '@/lib/finance/currency';

// Monthly-equivalent multiplier for a recurring expense's billing interval, so an
// ongoing subscription's run-rate can be folded into burn/profit (FIN-05).
const RECURRING_MONTHLY_FACTOR: Record<string, number> = {
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
};

// Money columns (transaction.amount, invoice totals, etc.) are Decimal(12,2), so the
// largest value Postgres will accept is 9,999,999,999.99. Bound amounts here so an
// oversized input fails as a clean validation error instead of a raw DB 500.
const MAX_MONEY = 9_999_999_999.99;
const MONEY_MAX_MESSAGE = 'Amount must be 9,999,999,999.99 or less';
const positiveMoney = () => z.number().positive().max(MAX_MONEY, MONEY_MAX_MESSAGE);
const nonNegativeMoney = () => z.number().nonnegative().max(MAX_MONEY, MONEY_MAX_MESSAGE);

// Round to 2 decimal places (cents). Used to derive invoice money server-side so
// caller-supplied subtotal/total are never trusted (FIN-01).
const round2 = (n: number) => Math.round(n * 100) / 100;

// A recurring expense's stored nextDueDate doesn't advance on its own, so once a
// due date passes it goes stale (e.g. seeded "May 1" still showing in June). Roll
// it forward by its interval until it lands today or later so the UI always shows
// the genuine *next* occurrence. Computed on read — we don't mutate the row here.
const INTERVAL_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

function rollForwardDueDate(due: Date, interval: string, now: Date): Date {
  const stepMonths = INTERVAL_MONTHS[interval.toLowerCase()] ?? 1;
  const next = new Date(due);
  const anchorDay = next.getDate();
  // Cap iterations so an unrecognized interval can never spin forever.
  for (let i = 0; next < now && i < 600; i++) {
    next.setDate(anchorDay);
    next.setMonth(next.getMonth() + stepMonths);
  }
  return next;
}

export const financeRouter = router({
  getTransactions: adminProcedure
    .input(
      z.object({
        type: z.enum(['INCOME', 'EXPENSE']).optional(),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        category: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {};
      if (input.type) where.type = input.type;
      if (input.category) where.category = input.category;
      if (input.startDate || input.endDate) {
        where.date = {
          ...(input.startDate && { gte: input.startDate }),
          ...(input.endDate && { lte: input.endDate }),
        };
      }

      return ctx.db.transaction.findMany({
        where,
        include: {
          project: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } },
        },
        orderBy: { date: 'desc' },
        take: input.limit,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });
    }),

  createTransaction: adminProcedure
    .input(
      z.object({
        type: z.enum(['INCOME', 'EXPENSE']),
        amount: positiveMoney(),
        currency: z.enum(['USD', 'PKR']).default('USD'),
        category: z
          .enum([
            'SALARIES',
            'SUBSCRIPTIONS',
            'OFFICE',
            'MARKETING',
            'HOSTING',
            'SOFTWARE',
            'HARDWARE',
            'TRAVEL',
            'UTILITIES',
            'MISCELLANEOUS',
          ])
          .optional(),
        description: z.string().min(1),
        projectId: z.string().optional(),
        clientId: z.string().optional(),
        date: z.date(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction.create({
        data: {
          ...input,
          projectId: input.projectId || null,
          clientId: input.clientId || null,
          category: input.category || null,
        },
      });
    }),

  updateTransaction: adminProcedure
    .input(
      z.object({
        id: z.string(),
        type: z.enum(['INCOME', 'EXPENSE']).optional(),
        amount: positiveMoney().optional(),
        description: z.string().min(1).optional(),
        category: z
          .enum([
            'SALARIES',
            'SUBSCRIPTIONS',
            'OFFICE',
            'MARKETING',
            'HOSTING',
            'SOFTWARE',
            'HARDWARE',
            'TRAVEL',
            'UTILITIES',
            'MISCELLANEOUS',
          ])
          .nullable()
          .optional(),
        projectId: z.string().nullable().optional(),
        clientId: z.string().nullable().optional(),
        date: z.date().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.db.transaction.update({ where: { id }, data });
    }),

  deleteTransaction: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction.delete({ where: { id: input.id } });
    }),

  getInvoices: adminProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(1000).optional(),
          cursor: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.invoice.findMany({
        include: {
          client: { select: { id: true, name: true, logo: true } },
          project: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: input?.limit ? Math.min(input.limit, 1000) : undefined,
        ...(input?.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });
    }),

  getInvoiceById: adminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.invoice.findUnique({
        where: { id: input.id },
        include: {
          client: { include: { contacts: { where: { isPrimary: true }, take: 1 } } },
          project: { select: { id: true, name: true } },
        },
      });
    }),

  createInvoice: adminProcedure
    .input(
      z.object({
        clientId: z.string(),
        projectId: z.string().optional(),
        items: z.array(
          z.object({
            description: z.string(),
            quantity: z.number().positive(),
            rate: positiveMoney(),
            amount: nonNegativeMoney(),
          })
        ),
        subtotal: nonNegativeMoney(),
        tax: nonNegativeMoney().default(0),
        total: nonNegativeMoney(),
        currency: z.enum(['USD', 'PKR']).default('USD'),
        dueDate: z.date(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // FIN-01: never trust client-sent money. Derive every line `amount`, the
      // `subtotal` and the `total` from quantity × rate (+ tax) on the server, so
      // a request claiming subtotal/total = 0 (or a negative) cannot corrupt the
      // stored figure or the paid/outstanding aggregates. Mirrors the AI tool.
      const lineItems = input.items.map((it) => ({
        description: it.description,
        quantity: it.quantity,
        rate: it.rate,
        amount: round2(it.quantity * it.rate),
      }));
      const subtotal = round2(lineItems.reduce((s, it) => s + it.amount, 0));
      const tax = round2(input.tax ?? 0);
      const total = round2(subtotal + tax);

      // Generate invoice number
      const count = await ctx.db.invoice.count();
      const year = new Date().getFullYear();
      const invoiceNumber = `INV-${year}-${String(count + 1).padStart(3, '0')}`;

      const invoice = await ctx.db.invoice.create({
        data: {
          invoiceNumber,
          clientId: input.clientId,
          projectId: input.projectId || null,
          items: lineItems,
          subtotal,
          tax,
          total,
          currency: input.currency,
          status: 'DRAFT',
          dueDate: input.dueDate,
          notes: input.notes,
        },
        include: { client: { select: { name: true } } },
      });

      logActivity(ctx.db, ctx.session.user.id, {
        type: 'invoice_created',
        message: `created invoice ${invoice.invoiceNumber} for ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
        entityType: 'Invoice',
        entityId: invoice.id,
      });

      return invoice;
    }),

  updateInvoiceStatus: adminProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // FIN-06: enforce a status state-machine, never re-fire side-effects on a
      // no-op, and clear paidAt/sentAt when the invoice leaves PAID/SENT.
      const current = await ctx.db.invoice.findUnique({
        where: { id: input.id },
        select: { status: true },
      });
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invoice not found' });

      const prior = current.status;
      const next = input.status;

      // No-op: don't overwrite paidAt/sentAt or re-emit activity/notifications.
      if (prior === next) {
        return ctx.db.invoice.findUniqueOrThrow({
          where: { id: input.id },
          include: { client: { select: { name: true } } },
        });
      }

      const ALLOWED: Record<string, string[]> = {
        DRAFT: ['SENT', 'CANCELLED'],
        SENT: ['PAID', 'OVERDUE', 'CANCELLED', 'DRAFT'],
        OVERDUE: ['PAID', 'CANCELLED', 'SENT'],
        PAID: ['CANCELLED'],
        CANCELLED: ['DRAFT'],
      };
      if (!ALLOWED[prior]?.includes(next)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot change an invoice from ${prior} to ${next}.`,
        });
      }

      const data: Record<string, unknown> = { status: next };
      if (next === 'PAID') data.paidAt = new Date();
      if (next === 'SENT') data.sentAt = new Date();
      // Clear stamps when the invoice leaves the corresponding state.
      if (prior === 'PAID' && next !== 'PAID') data.paidAt = null;
      if (next === 'DRAFT') {
        data.sentAt = null;
        data.paidAt = null;
      }

      const invoice = await ctx.db.invoice.update({
        where: { id: input.id },
        data,
        include: { client: { select: { name: true } } },
      });

      if (next === 'SENT') {
        logActivity(ctx.db, ctx.session.user.id, {
          type: 'invoice_sent',
          message: `sent invoice ${invoice.invoiceNumber} to ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
          entityType: 'Invoice',
          entityId: invoice.id,
        });
      } else if (next === 'PAID') {
        logActivity(ctx.db, ctx.session.user.id, {
          type: 'invoice_paid',
          message: `marked invoice ${invoice.invoiceNumber} as paid ($${Number(invoice.total).toLocaleString()})`,
          entityType: 'Invoice',
          entityId: invoice.id,
        });
      }

      return invoice;
    }),

  getRecurringExpenses: adminProcedure.query(async ({ ctx }) => {
    const expenses = await ctx.db.recurringExpense.findMany({
      where: { active: true },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Surface the next upcoming due date (rolled past any lapsed cycles), then sort
    // by it so the soonest-due subscription leads the list.
    return expenses
      .map((exp) => ({
        ...exp,
        nextDueDate: rollForwardDueDate(exp.nextDueDate, exp.interval, today),
      }))
      .sort((a, b) => a.nextDueDate.getTime() - b.nextDueDate.getTime());
  }),

  createRecurringExpense: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        amount: positiveMoney(),
        currency: z.enum(['USD', 'PKR']).default('USD'),
        category: z.enum([
          'SALARIES',
          'SUBSCRIPTIONS',
          'OFFICE',
          'MARKETING',
          'HOSTING',
          'SOFTWARE',
          'HARDWARE',
          'TRAVEL',
          'UTILITIES',
          'MISCELLANEOUS',
        ]),
        interval: z.string().min(1),
        nextDueDate: z.date(),
        vendorName: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.recurringExpense.create({ data: input });
    }),

  deleteRecurringExpense: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.recurringExpense.update({
        where: { id: input.id },
        data: { active: false },
      });
    }),

  getFinancialSummary: adminProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    // FIN-02: group every aggregate BY currency. Summing USD + PKR into one
    // scalar misstates totals (a hardcoded "$" on Rs hundreds of thousands), so
    // each figure is returned as a per-currency breakdown the UI renders apart.
    const txGroup = (where: Record<string, unknown>) =>
      ctx.db.transaction.groupBy({ by: ['currency'], _sum: { amount: true }, where });

    const [
      monthlyIncomeG,
      monthlyExpenseG,
      yearlyIncomeG,
      yearlyExpenseG,
      paidInvoicesG,
      outstandingInvoicesG,
      recurring,
    ] = await Promise.all([
      // FIN-04: cap each "this period" window at `now` so future-dated rows can't
      // inflate it (the bounded P&L would otherwise disagree with these KPIs).
      txGroup({ type: 'INCOME', date: { gte: startOfMonth, lte: now } }),
      txGroup({ type: 'EXPENSE', date: { gte: startOfMonth, lte: now } }),
      txGroup({ type: 'INCOME', date: { gte: startOfYear, lte: now } }),
      txGroup({ type: 'EXPENSE', date: { gte: startOfYear, lte: now } }),
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
      ctx.db.recurringExpense.findMany({
        where: { active: true },
        select: { amount: true, currency: true, interval: true },
      }),
    ]);

    const monthlyIncome = fromCurrencyGroups(monthlyIncomeG, 'amount');
    const yearlyIncome = fromCurrencyGroups(yearlyIncomeG, 'amount');

    // FIN-05: recurring expenses are never posted as transactions, so burn and
    // profit silently omitted them. Fold each active subscription's monthly-
    // equivalent run-rate (currency-aware) into the monthly/yearly expense.
    const recurringMonthlyMap = new Map<string, number>();
    for (const e of recurring) {
      const factor = RECURRING_MONTHLY_FACTOR[e.interval.toLowerCase()] ?? 1;
      recurringMonthlyMap.set(
        e.currency,
        (recurringMonthlyMap.get(e.currency) ?? 0) + Number(e.amount) * factor
      );
    }
    const recurringMonthly: CurrencyAmount[] = Array.from(recurringMonthlyMap, ([currency, amount]) => ({
      currency,
      amount: Math.round(amount * 100) / 100,
    }));
    const recurringYearly: CurrencyAmount[] = recurringMonthly.map((r) => ({
      currency: r.currency,
      amount: Math.round(r.amount * 12 * 100) / 100,
    }));

    const monthlyExpense = sumByCurrency(fromCurrencyGroups(monthlyExpenseG, 'amount'), recurringMonthly);
    const yearlyExpense = sumByCurrency(fromCurrencyGroups(yearlyExpenseG, 'amount'), recurringYearly);

    return {
      monthlyIncome,
      monthlyExpense,
      monthlyProfit: diffByCurrency(monthlyIncome, monthlyExpense),
      yearlyIncome,
      yearlyExpense,
      yearlyProfit: diffByCurrency(yearlyIncome, yearlyExpense),
      totalPaid: fromCurrencyGroups(paidInvoicesG, 'total'),
      paidCount: paidInvoicesG.reduce((s, g) => s + g._count, 0),
      totalOutstanding: fromCurrencyGroups(outstandingInvoicesG, 'total'),
      outstandingCount: outstandingInvoicesG.reduce((s, g) => s + g._count, 0),
    };
  }),

  getPnlReport: adminProcedure
    .input(
      z.object({
        period: z.enum(['monthly', 'quarterly', 'yearly']).default('monthly'),
        months: z.number().min(1).max(24).default(12),
      })
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();

      // FIN-02: P&L is reported PER currency — income/expense are grouped by
      // currency per month (and the category breakdown by category+currency), so
      // the trend chart and pie never blend USD and PKR. The client picks one
      // currency to view at a time.
      const monthRanges: Date[] = [];
      const groupPromises = [];
      for (let i = input.months - 1; i >= 0; i--) {
        const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
        monthRanges.push(date);
        groupPromises.push(
          ctx.db.transaction.groupBy({
            by: ['currency'],
            _sum: { amount: true },
            where: { type: 'INCOME', date: { gte: date, lte: endOfMonth } },
          }),
          ctx.db.transaction.groupBy({
            by: ['currency'],
            _sum: { amount: true },
            where: { type: 'EXPENSE', date: { gte: date, lte: endOfMonth } },
          })
        );
      }

      const monthGroups = await Promise.all(groupPromises);

      // Expense breakdown by category AND currency (year-to-date).
      const categoryGroups = await ctx.db.transaction.groupBy({
        by: ['category', 'currency'],
        _sum: { amount: true },
        where: { type: 'EXPENSE', date: { gte: new Date(now.getFullYear(), 0, 1) } },
        orderBy: { _sum: { amount: 'desc' } },
      });

      // Per-month per-currency amount lookup helper.
      const amountFor = (
        groups: Array<{ currency: string; _sum: { amount: unknown } }>,
        currency: string
      ) => Number(groups.find((g) => g.currency === currency)?._sum.amount ?? 0);

      const monthIncome = monthRanges.map((_, idx) => fromCurrencyGroups(monthGroups[idx * 2], 'amount'));
      const monthExpense = monthRanges.map((_, idx) =>
        fromCurrencyGroups(monthGroups[idx * 2 + 1], 'amount')
      );
      const currencies = currenciesPresent(
        ...monthIncome,
        ...monthExpense,
        fromCurrencyGroups(categoryGroups, 'amount')
      );

      const byCurrency: Record<
        string,
        {
          data: Array<{
            period: string;
            income: number;
            expense: number;
            profit: number;
            margin: number;
          }>;
          categoryBreakdown: Array<{ category: string; amount: number }>;
        }
      > = {};

      for (const currency of currencies) {
        const data = monthRanges.map((date, idx) => {
          const incomeAmt = amountFor(monthGroups[idx * 2], currency);
          const expenseAmt = amountFor(monthGroups[idx * 2 + 1], currency);
          return {
            period: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
            income: incomeAmt,
            expense: expenseAmt,
            profit: incomeAmt - expenseAmt,
            margin: incomeAmt > 0 ? ((incomeAmt - expenseAmt) / incomeAmt) * 100 : 0,
          };
        });
        const categoryBreakdown = categoryGroups
          .filter((c) => c.currency === currency)
          .map((c) => ({
            category: c.category || 'Uncategorized',
            amount: Number(c._sum.amount || 0),
          }))
          .filter((c) => c.amount !== 0)
          .sort((a, b) => b.amount - a.amount);
        byCurrency[currency] = { data, categoryBreakdown };
      }

      return { currencies, byCurrency };
    }),
});
