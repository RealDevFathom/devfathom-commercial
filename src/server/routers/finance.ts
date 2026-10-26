import { z } from 'zod';
import { format } from 'date-fns';
import { router, adminProcedure } from '../trpc';
import { logActivity } from '../activity';
import { emitEvent } from '@/lib/webhooks';
import { TRPCError } from '@trpc/server';
import { assertInOrganization, workspaceId } from '../org-refs';
import { sendEmail, templates, appUrl } from '@/lib/email';
import {
  fromCurrencyGroups,
  diffByCurrency,
  sumByCurrency,
  currenciesPresent,
  moneyLabel,
  type CurrencyAmount,
} from '@/lib/finance/currency';
import { invoiceStatusTransitionError, invoiceStatusUpdate } from '@/lib/finance/invoice-status';
import { calculateInvoiceMoney, fromCents, moneyCents } from '@/lib/finance/invoice-money';

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
const MAX_MONEY_CENTS = 999_999_999_999n;
const MAX_INVOICE_QUANTITY = 1_000_000;
const MAX_INVOICE_ITEMS = 100;
const MONEY_MAX_MESSAGE = 'Amount must be 9,999,999,999.99 or less';
const positiveMoney = () => z.number().positive().max(MAX_MONEY, MONEY_MAX_MESSAGE);
const nonNegativeMoney = () => z.number().nonnegative().max(MAX_MONEY, MONEY_MAX_MESSAGE);

export const createInvoiceInputSchema = z.object({
  clientId: z.string(),
  projectId: z.string().optional(),
  items: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.number().positive().max(MAX_INVOICE_QUANTITY),
        rate: positiveMoney(),
        amount: nonNegativeMoney(),
      })
    )
    .min(1, 'Invoice must have at least one line item')
    .max(MAX_INVOICE_ITEMS, `Invoice cannot have more than ${MAX_INVOICE_ITEMS} line items`),
  subtotal: nonNegativeMoney(),
  discount: nonNegativeMoney().default(0),
  tax: nonNegativeMoney().default(0),
  total: nonNegativeMoney(),
  currency: z.enum(['USD', 'PKR']).default('USD'),
  dueDate: z.date(),
  notes: z.string().optional(),
});

// Round to 2 decimal places (cents). Used to derive invoice money server-side so
// caller-supplied subtotal/total are never trusted (FIN-01). Discounts are
// bounded by the derived subtotal so an invoice can never have a negative net.
const round2 = (n: number) => fromCents(moneyCents(n));

function assertMoneyRange(cents: bigint) {
  if (cents > MAX_MONEY_CENTS) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: MONEY_MAX_MESSAGE });
  }
}

export function calculateInvoiceTotals(
  items: Array<{ quantity: number; rate: number }>,
  taxInput = 0,
  discountInput = 0
) {
  const { amountCents, subtotalCents, taxCents, discountCents, totalCents } =
    calculateInvoiceMoney(items, taxInput, discountInput);
  amountCents.forEach(assertMoneyRange);
  assertMoneyRange(subtotalCents);
  assertMoneyRange(taxCents);
  assertMoneyRange(discountCents);
  if (discountCents > subtotalCents) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Discount cannot exceed the invoice subtotal',
    });
  }
  assertMoneyRange(totalCents);
  return {
    amounts: amountCents.map(fromCents),
    subtotal: fromCents(subtotalCents),
    discount: fromCents(discountCents),
    tax: fromCents(taxCents),
    total: fromCents(totalCents),
  };
}

// IMP-FIN-04: money is Decimal(12,2), so a partial payment can legitimately pay an
// invoice off to the exact cent. Compare paid-vs-total with a half-cent tolerance
// so a sub-cent float artifact never tips an exact payoff into "overpayment" — and
// never leaves a fully-paid invoice a hair short of PAID.
const PAYMENT_EPSILON = 0.005;

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
      const orgId = workspaceId(ctx);
      await assertInOrganization(ctx.db.client, orgId, [input.clientId]);
      await assertInOrganization(ctx.db.project, orgId, [input.projectId]);
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
      const orgId = workspaceId(ctx);
      await assertInOrganization(ctx.db.client, orgId, [data.clientId]);
      await assertInOrganization(ctx.db.project, orgId, [data.projectId]);
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
      const invoices = await ctx.db.invoice.findMany({
        include: {
          client: { select: { id: true, name: true, logo: true } },
          project: { select: { id: true, name: true } },
          // IMP-FIN-04: ship the payments alongside each invoice so the list can
          // show paid/balance without an N+1 of per-row fetches.
          payments: { orderBy: { paidAt: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
        take: input?.limit ? Math.min(input.limit, 1000) : undefined,
        ...(input?.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      // Derive paid/balance server-side (round2) so the client never re-sums money.
      return invoices.map((inv) => {
        const amountPaid = round2(inv.payments.reduce((s, p) => s + Number(p.amount), 0));
        return { ...inv, amountPaid, balance: round2(Number(inv.total) - amountPaid) };
      });
    }),

  getInvoiceById: adminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const invoice = await ctx.db.invoice.findUnique({
        where: { id: input.id },
        include: {
          client: { include: { contacts: { where: { isPrimary: true }, take: 1 } } },
          project: { select: { id: true, name: true } },
          // IMP-FIN-04: payments + computed paid/balance for the invoice detail view.
          payments: { orderBy: { paidAt: 'desc' } },
        },
      });
      if (!invoice) return null;
      const amountPaid = round2(invoice.payments.reduce((s, p) => s + Number(p.amount), 0));
      return { ...invoice, amountPaid, balance: round2(Number(invoice.total) - amountPaid) };
    }),

  createInvoice: adminProcedure.input(createInvoiceInputSchema).mutation(async ({ ctx, input }) => {
    const orgId = workspaceId(ctx);
    await assertInOrganization(ctx.db.client, orgId, [input.clientId]);
    await assertInOrganization(ctx.db.project, orgId, [input.projectId]);
    // FIN-01: never trust client-sent money. Derive every line `amount`, the
    // `subtotal` and the `total` from quantity × rate (- discount + tax) on the server, so
    // a request claiming subtotal/total = 0 (or a negative) cannot corrupt the
    // stored figure or the paid/outstanding aggregates. Mirrors the AI tool.
    const totals = calculateInvoiceTotals(input.items, input.tax, input.discount);
    const lineItems = input.items.map((it, index) => ({
      description: it.description,
      quantity: it.quantity,
      rate: it.rate,
      amount: totals.amounts[index],
    }));

    // Generate invoice number. FIN-09: scope the count to THIS year's invoices
    // so the sequence resets to -001 each January (was a global count that never
    // reset across years).
    const year = new Date().getFullYear();
    const count = await ctx.db.invoice.count({
      where: { invoiceNumber: { startsWith: `INV-${year}-` } },
    });
    const invoiceNumber = `INV-${year}-${String(count + 1).padStart(3, '0')}`;

    const invoice = await ctx.db.invoice.create({
      data: {
        invoiceNumber,
        clientId: input.clientId,
        projectId: input.projectId || null,
        items: lineItems,
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        total: totals.total,
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

  // IMP-FIN-01: full line-item edit of an unsettled invoice. Like createInvoice,
  // every line `amount`, the `subtotal` and the `total` are recomputed SERVER-SIDE
  // from quantity × rate (- discount + tax) — a caller-supplied total is never trusted (FIN-01).
  // Only a DRAFT or SENT invoice may be edited; a PAID/CANCELLED/OVERDUE invoice is
  // settled or void and its figures are frozen.
  updateInvoice: adminProcedure
    .input(
      z.object({
        id: z.string(),
        items: z
          .array(
            z.object({
              description: z.string().min(1),
              quantity: z.number().positive().max(MAX_INVOICE_QUANTITY),
              rate: positiveMoney(),
            })
          )
          .min(1)
          .max(MAX_INVOICE_ITEMS),
        tax: nonNegativeMoney().optional(),
        discount: nonNegativeMoney().optional(),
        dueDate: z.date().optional(),
        notes: z.string().optional(),
        status: z.enum(['DRAFT', 'SENT']).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = workspaceId(ctx);
      return ctx.db.$transaction(async (tx) => {
        // Serialize edits with payment recording. Re-read only after acquiring the
        // row lock so status, adjustments, and collected funds cannot go stale.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM invoices
          WHERE id = ${input.id} AND "organizationId" = ${orgId}
          FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Invoice not found' });
        }
        const current = await tx.invoice.findUnique({
          where: { id: input.id, organizationId: orgId },
          select: { status: true, discount: true, tax: true },
        });
        if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invoice not found' });
        if (current.status !== 'DRAFT' && current.status !== 'SENT') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `A ${current.status.toLowerCase()} invoice can't be edited — only draft or sent invoices.`,
          });
        }

        const totals = calculateInvoiceTotals(
          input.items,
          input.tax ?? Number(current.tax),
          input.discount ?? Number(current.discount)
        );
        const paid = await tx.payment.aggregate({
          where: { invoiceId: input.id, organizationId: orgId },
          _sum: { amount: true },
        });
        const amountPaid = round2(Number(paid._sum.amount ?? 0));
        if (totals.total < amountPaid) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invoice total cannot be less than the ${amountPaid.toFixed(2)} already paid. Record a refund or adjustment first.`,
          });
        }

        const lineItems = input.items.map((it, index) => ({
          description: it.description,
          quantity: it.quantity,
          rate: it.rate,
          amount: totals.amounts[index],
        }));
        const data: Record<string, unknown> = {
          items: lineItems,
          subtotal: totals.subtotal,
          discount: totals.discount,
          tax: totals.tax,
          total: totals.total,
        };
        if (input.dueDate) data.dueDate = input.dueDate;
        if (input.notes !== undefined) data.notes = input.notes.trim() || null;
        if (input.status && input.status !== current.status) {
          data.status = input.status;
          if (input.status === 'SENT') data.sentAt = new Date();
          if (input.status === 'DRAFT') data.sentAt = null;
        }

        const invoice = await tx.invoice.update({
          where: { id: input.id, organizationId: orgId },
          data,
          include: {
            client: { include: { contacts: { where: { isPrimary: true }, take: 1 } } },
            project: { select: { id: true, name: true } },
            payments: { orderBy: { paidAt: 'desc' } },
          },
        });
        return { ...invoice, amountPaid, balance: round2(Number(invoice.total) - amountPaid) };
      });
    }),

  // IMP-FIN-01: email the invoice to the client's primary contact (falling back to
  // any contact that has an email), linking to the print/PDF view. Best-effort send
  // surfaced as a clean error; on success a DRAFT is promoted to SENT + sentAt.
  sendInvoiceEmail: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invoice = await ctx.db.invoice.findUnique({
        where: { id: input.id },
        include: {
          client: { include: { contacts: { where: { isPrimary: true }, take: 1 } } },
        },
      });
      if (!invoice) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invoice not found' });

      // Prefer the primary contact; otherwise any contact on the client with an email.
      let recipient = invoice.client.contacts[0];
      if (!recipient?.email) {
        const fallback = await ctx.db.clientContact.findFirst({
          where: { clientId: invoice.clientId, email: { not: null } },
        });
        if (fallback) recipient = fallback;
      }
      if (!recipient?.email) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `No contact email on file for ${invoice.client.name}. Add a contact with an email address first.`,
        });
      }

      const mail = templates.invoiceIssued({
        recipientName: recipient.name,
        invoiceNumber: invoice.invoiceNumber,
        clientName: invoice.client.name,
        amountLabel: moneyLabel(Number(invoice.total), invoice.currency),
        dueDate: format(new Date(invoice.dueDate), 'MMM d, yyyy'),
        url: `${appUrl()}/finance/invoices/${invoice.id}/print`,
      });

      try {
        await sendEmail({
          to: { email: recipient.email, name: recipient.name },
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Couldn't send the invoice email: ${err instanceof Error ? err.message : 'unknown error'}`,
        });
      }

      // Promote DRAFT → SENT only after a successful send.
      const wasDraft = invoice.status === 'DRAFT';
      if (wasDraft) {
        await ctx.db.invoice.update({
          where: { id: invoice.id },
          data: { status: 'SENT', sentAt: new Date() },
        });
      }

      logActivity(ctx.db, ctx.session.user.id, {
        type: 'invoice_sent',
        message: `emailed invoice ${invoice.invoiceNumber} to ${recipient.email} (${invoice.client.name})`,
        entityType: 'Invoice',
        entityId: invoice.id,
      });

      return {
        sentTo: recipient.email,
        status: wasDraft ? ('SENT' as const) : invoice.status,
      };
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

      const transitionError = invoiceStatusTransitionError(prior, next);
      if (transitionError) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: transitionError,
        });
      }

      // No-op: don't overwrite paidAt/sentAt or re-emit activity/notifications.
      if (prior === next) {
        return ctx.db.invoice.findUniqueOrThrow({
          where: { id: input.id },
          include: { client: { select: { name: true } } },
        });
      }

      const changed = await ctx.db.invoice.updateMany({
        where: { id: input.id, status: prior },
        data: invoiceStatusUpdate(prior, next, new Date()),
      });
      if (changed.count !== 1) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Invoice status changed concurrently. Refresh and try again.',
        });
      }
      const invoice = await ctx.db.invoice.findUniqueOrThrow({
        where: { id: input.id },
        include: { client: { select: { name: true } } },
      });

      if (next === 'SENT') {
        logActivity(ctx.db, ctx.session.user.id, {
          type: 'invoice_sent',
          message: `sent invoice ${invoice.invoiceNumber} to ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
          entityType: 'Invoice',
          entityId: invoice.id,
        });
      }

      return invoice;
    }),

  // IMP-FIN-04: record a (partial) payment against an invoice. The payment's
  // currency is inherited from the invoice (never caller-supplied). We re-sum every
  // payment for the invoice inside the transaction and flip it to PAID the moment
  // the balance is covered; a payment that doesn't cover the total leaves the status
  // untouched (still SENT/OVERDUE). Overpayment beyond a half-cent is rejected.
  addPayment: adminProcedure
    .input(
      z.object({
        invoiceId: z.string(),
        amount: positiveMoney(),
        method: z.string().max(100).optional(),
        note: z.string().max(1000).optional(),
        paidAt: z.date().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = workspaceId(ctx);
      // IMP-REST-03: captured inside the tx, fired only AFTER it commits.
      let paidEvent: {
        invoiceId: string;
        total: number;
        currency: string;
        clientId: string;
      } | null = null;

      const result = await ctx.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM invoices
          WHERE id = ${input.invoiceId} AND "organizationId" = ${orgId}
          FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Invoice not found' });
        }
        const invoice = await tx.invoice.findUnique({
          where: { id: input.invoiceId, organizationId: orgId },
          select: { id: true, status: true, total: true, currency: true, clientId: true },
        });
        if (!invoice) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invoice not found' });

        // A DRAFT isn't owed yet, and a PAID/CANCELLED invoice shouldn't accrue more
        // payments — reject each as a clean validation error rather than a DB write.
        if (invoice.status === 'DRAFT') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Send the invoice before recording a payment.',
          });
        }
        if (invoice.status === 'PAID') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This invoice is already paid in full.',
          });
        }
        if (invoice.status === 'CANCELLED') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot record a payment against a cancelled invoice.',
          });
        }

        const total = round2(Number(invoice.total));
        const prior = await tx.payment.aggregate({
          where: { invoiceId: invoice.id, organizationId: orgId },
          _sum: { amount: true },
        });
        const alreadyPaid = round2(Number(prior._sum.amount ?? 0));
        const newPaid = round2(alreadyPaid + input.amount);

        // Reject overpayment beyond a half-cent rounding tolerance.
        if (newPaid > total + PAYMENT_EPSILON) {
          const balance = round2(total - alreadyPaid);
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Payment exceeds the outstanding balance of ${balance.toFixed(2)}.`,
          });
        }

        const payment = await tx.payment.create({
          data: {
            organizationId: orgId,
            invoiceId: invoice.id,
            amount: input.amount,
            currency: invoice.currency,
            method: input.method?.trim() || null,
            note: input.note?.trim() || null,
            ...(input.paidAt && { paidAt: input.paidAt }),
          },
        });

        // Balance covered → mark PAID (the DRAFT/PAID guards above mean we only ever
        // flip from SENT/OVERDUE here). Otherwise leave the status as-is.
        const fullyPaid = newPaid >= total - PAYMENT_EPSILON;
        if (fullyPaid) {
          await tx.invoice.update({
            where: { id: invoice.id, organizationId: orgId },
            data: { status: 'PAID', paidAt: new Date() },
          });
          paidEvent = {
            invoiceId: invoice.id,
            total,
            currency: invoice.currency,
            clientId: invoice.clientId,
          };
        }

        return {
          payment,
          amountPaid: newPaid,
          balance: round2(total - newPaid),
          status: fullyPaid ? ('PAID' as const) : invoice.status,
        };
      });

      // IMP-REST-03: fan out invoice.paid once the invoice has truly flipped to
      // PAID and the transaction has committed. Fire-and-forget — emitEvent
      // never throws, so it can't affect the recorded payment.
      if (paidEvent) emitEvent(ctx.db, ctx.entitlements, 'invoice.paid', paidEvent);

      return result;
    }),

  // IMP-FIN-04: remove a payment and recompute. If deleting it drops a PAID invoice
  // back below its total, revert the invoice to SENT and clear paidAt so it re-enters
  // the outstanding pipeline.
  deletePayment: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const payment = await tx.payment.findUnique({
          where: { id: input.id },
          select: { id: true, invoiceId: true },
        });
        if (!payment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment not found' });

        await tx.payment.delete({ where: { id: payment.id } });

        const invoice = await tx.invoice.findUnique({
          where: { id: payment.invoiceId },
          select: { id: true, status: true, total: true },
        });
        if (!invoice) return { invoiceId: payment.invoiceId, amountPaid: 0, balance: 0 };

        const total = round2(Number(invoice.total));
        const agg = await tx.payment.aggregate({
          where: { invoiceId: invoice.id },
          _sum: { amount: true },
        });
        const amountPaid = round2(Number(agg._sum.amount ?? 0));

        if (invoice.status === 'PAID' && amountPaid < total - PAYMENT_EPSILON) {
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { status: 'SENT', paidAt: null },
          });
        }

        return { invoiceId: invoice.id, amountPaid, balance: round2(total - amountPaid) };
      });
    }),

  // IMP-FIN-04: flip every SENT invoice whose due date has passed to OVERDUE. This is
  // the action a nightly cron would call; exposed here for an operator button. Returns
  // how many invoices were flagged.
  markOverdueInvoices: adminProcedure.mutation(async ({ ctx }) => {
    const result = await ctx.db.invoice.updateMany({
      where: { status: 'SENT', dueDate: { lt: new Date() } },
      data: { status: 'OVERDUE', sentAt: null },
    });
    return { count: result.count };
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

  // IMP-FIN-03: post every recurring expense that has come due as a real EXPENSE
  // transaction (one per elapsed billing cycle), then persist the advanced
  // nextDueDate so a re-run never double-posts the same cycle. This is the
  // mechanism a production cron would invoke; here it's an operator-triggered
  // mutation. Per-expense cycle count is capped so a long-stale row can't post
  // hundreds of rows in one go.
  postDueRecurringExpenses: adminProcedure.mutation(async ({ ctx }) => {
    const now = new Date();
    const expenses = await ctx.db.recurringExpense.findMany({ where: { active: true } });
    let posted = 0;
    const details: Array<{ id: string; name: string; cycles: number }> = [];

    for (const exp of expenses) {
      const stepMonths = INTERVAL_MONTHS[exp.interval.toLowerCase()] ?? 1;
      const anchorDay = new Date(exp.nextDueDate).getDate();
      const due = new Date(exp.nextDueDate);
      const toPost: Date[] = [];
      for (let i = 0; due <= now && i < 36; i++) {
        toPost.push(new Date(due));
        due.setDate(anchorDay);
        due.setMonth(due.getMonth() + stepMonths);
      }
      if (toPost.length === 0) continue;

      await ctx.db.$transaction([
        ctx.db.transaction.createMany({
          data: toPost.map((d) => ({
            type: 'EXPENSE' as const,
            amount: exp.amount,
            currency: exp.currency,
            category: exp.category,
            description: `${exp.name}${exp.vendorName ? ` — ${exp.vendorName}` : ''} (recurring)`,
            date: d,
          })),
        }),
        ctx.db.recurringExpense.update({ where: { id: exp.id }, data: { nextDueDate: due } }),
      ]);
      posted += toPost.length;
      details.push({ id: exp.id, name: exp.name, cycles: toPost.length });
    }

    return { posted, details };
  }),

  // IMP-FIN-03: spend-against-budget rollup. For each project carrying a budget,
  // total its posted EXPENSE transactions (kept per-currency, since budgets are a
  // single Decimal and projects may transact in more than one currency).
  getBudgetVsActuals: adminProcedure.query(async ({ ctx }) => {
    const projects = await ctx.db.project.findMany({
      where: { budget: { not: null } },
      select: { id: true, name: true, budget: true },
    });
    if (projects.length === 0) return [];

    const grouped = await ctx.db.transaction.groupBy({
      by: ['projectId', 'currency'],
      _sum: { amount: true },
      where: { type: 'EXPENSE', projectId: { in: projects.map((p) => p.id) } },
    });

    return projects.map((p) => {
      const spent = grouped
        .filter((g) => g.projectId === p.id)
        .map((g) => ({ currency: g.currency, amount: round2(Number(g._sum.amount ?? 0)) }));
      const budget = round2(Number(p.budget));
      const totalSpent = round2(spent.reduce((s, g) => s + g.amount, 0));
      return {
        projectId: p.id,
        name: p.name,
        budget,
        spent,
        totalSpent,
        pct: budget > 0 ? Math.round((totalSpent / budget) * 100) : 0,
        overBudget: totalSpent > budget,
      };
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
    const recurringMonthly: CurrencyAmount[] = Array.from(
      recurringMonthlyMap,
      ([currency, amount]) => ({
        currency,
        amount: Math.round(amount * 100) / 100,
      })
    );
    const recurringYearly: CurrencyAmount[] = recurringMonthly.map((r) => ({
      currency: r.currency,
      amount: Math.round(r.amount * 12 * 100) / 100,
    }));

    const monthlyExpense = sumByCurrency(
      fromCurrencyGroups(monthlyExpenseG, 'amount'),
      recurringMonthly
    );
    const yearlyExpense = sumByCurrency(
      fromCurrencyGroups(yearlyExpenseG, 'amount'),
      recurringYearly
    );

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
        // FIN-09: include the final millisecond so a 23:59:59.5xx row isn't dropped.
        const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
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

      const monthIncome = monthRanges.map((_, idx) =>
        fromCurrencyGroups(monthGroups[idx * 2], 'amount')
      );
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
            // FIN-08: round to cents / 2-dp so raw JSON doesn't leak float artifacts
            // (e.g. 0.20000000000000018) from Decimal→Number subtraction.
            profit: round2(incomeAmt - expenseAmt),
            margin:
              incomeAmt > 0 ? Math.round(((incomeAmt - expenseAmt) / incomeAmt) * 10000) / 100 : 0,
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
