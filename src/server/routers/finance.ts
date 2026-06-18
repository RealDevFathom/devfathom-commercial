import { z } from 'zod';
import { router, adminProcedure } from '../trpc';
import { logActivity } from '../activity';

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
        amount: z.number().positive(),
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
        amount: z.number().positive().optional(),
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

  getInvoices: adminProcedure.query(async ({ ctx }) => {
    return ctx.db.invoice.findMany({
      include: {
        client: { select: { id: true, name: true, logo: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
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
            rate: z.number().positive(),
            amount: z.number(),
          })
        ),
        subtotal: z.number(),
        tax: z.number().default(0),
        total: z.number(),
        currency: z.enum(['USD', 'PKR']).default('USD'),
        dueDate: z.date(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Generate invoice number
      const count = await ctx.db.invoice.count();
      const year = new Date().getFullYear();
      const invoiceNumber = `INV-${year}-${String(count + 1).padStart(3, '0')}`;

      const invoice = await ctx.db.invoice.create({
        data: {
          invoiceNumber,
          clientId: input.clientId,
          projectId: input.projectId || null,
          items: input.items,
          subtotal: input.subtotal,
          tax: input.tax,
          total: input.total,
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
      const data: Record<string, unknown> = { status: input.status };
      if (input.status === 'PAID') data.paidAt = new Date();
      if (input.status === 'SENT') data.sentAt = new Date();

      const invoice = await ctx.db.invoice.update({
        where: { id: input.id },
        data,
        include: { client: { select: { name: true } } },
      });

      if (input.status === 'SENT') {
        logActivity(ctx.db, ctx.session.user.id, {
          type: 'invoice_sent',
          message: `sent invoice ${invoice.invoiceNumber} to ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
          entityType: 'Invoice',
          entityId: invoice.id,
        });
      } else if (input.status === 'PAID') {
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
    return ctx.db.recurringExpense.findMany({
      where: { active: true },
      orderBy: { nextDueDate: 'asc' },
    });
  }),

  createRecurringExpense: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        amount: z.number().positive(),
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

    const [
      monthlyIncome,
      monthlyExpense,
      yearlyIncome,
      yearlyExpense,
      paidInvoices,
      outstandingInvoices,
    ] = await Promise.all([
      ctx.db.transaction.aggregate({
        _sum: { amount: true },
        where: { type: 'INCOME', date: { gte: startOfMonth } },
      }),
      ctx.db.transaction.aggregate({
        _sum: { amount: true },
        where: { type: 'EXPENSE', date: { gte: startOfMonth } },
      }),
      ctx.db.transaction.aggregate({
        _sum: { amount: true },
        where: { type: 'INCOME', date: { gte: startOfYear } },
      }),
      ctx.db.transaction.aggregate({
        _sum: { amount: true },
        where: { type: 'EXPENSE', date: { gte: startOfYear } },
      }),
      ctx.db.invoice.aggregate({ _sum: { total: true }, _count: true, where: { status: 'PAID' } }),
      ctx.db.invoice.aggregate({
        _sum: { total: true },
        _count: true,
        where: { status: { in: ['SENT', 'OVERDUE'] } },
      }),
    ]);

    return {
      monthlyIncome: Number(monthlyIncome._sum.amount || 0),
      monthlyExpense: Number(monthlyExpense._sum.amount || 0),
      monthlyProfit:
        Number(monthlyIncome._sum.amount || 0) - Number(monthlyExpense._sum.amount || 0),
      yearlyIncome: Number(yearlyIncome._sum.amount || 0),
      yearlyExpense: Number(yearlyExpense._sum.amount || 0),
      yearlyProfit: Number(yearlyIncome._sum.amount || 0) - Number(yearlyExpense._sum.amount || 0),
      totalPaid: Number(paidInvoices._sum.total || 0),
      paidCount: paidInvoices._count,
      totalOutstanding: Number(outstandingInvoices._sum.total || 0),
      outstandingCount: outstandingInvoices._count,
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
      const data = [];
      const now = new Date();

      for (let i = input.months - 1; i >= 0; i--) {
        const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);

        const [income, expense] = await Promise.all([
          ctx.db.transaction.aggregate({
            _sum: { amount: true },
            where: { type: 'INCOME', date: { gte: date, lte: endOfMonth } },
          }),
          ctx.db.transaction.aggregate({
            _sum: { amount: true },
            where: { type: 'EXPENSE', date: { gte: date, lte: endOfMonth } },
          }),
        ]);

        const incomeAmt = Number(income._sum.amount || 0);
        const expenseAmt = Number(expense._sum.amount || 0);

        data.push({
          period: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          income: incomeAmt,
          expense: expenseAmt,
          profit: incomeAmt - expenseAmt,
          margin: incomeAmt > 0 ? ((incomeAmt - expenseAmt) / incomeAmt) * 100 : 0,
        });
      }

      // Expense breakdown by category
      const categoryBreakdown = await ctx.db.transaction.groupBy({
        by: ['category'],
        _sum: { amount: true },
        where: { type: 'EXPENSE', date: { gte: new Date(now.getFullYear(), 0, 1) } },
        orderBy: { _sum: { amount: 'desc' } },
      });

      return {
        data,
        categoryBreakdown: categoryBreakdown.map((c) => ({
          category: c.category || 'Uncategorized',
          amount: Number(c._sum.amount || 0),
        })),
      };
    }),
});
