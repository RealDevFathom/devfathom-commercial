/**
 * FINANCE tools for the DevFathom assistant — invoices, transactions, recurring
 * expenses and financial summaries.
 *
 * The ENTIRE domain is ADMIN-ONLY: the `finance:read` ABAC policy resolves to
 * ADMIN (HR does NOT get finance). For non-admins this builder returns an EMPTY
 * tool set, so the model is never even offered a finance tool. Every `execute`
 * also re-checks `h.isAdmin` (belt + braces, in case the set is ever exposed).
 *
 * Each tool mirrors the equivalent `adminProcedure` in
 * `src/server/routers/finance.ts` — same input validation, logic and side
 * effects (invoice_* activity, invoiceIssued/invoicePaid emails). Writes set
 * `needsApproval: true`. Optional params are `.nullish()` (NOT `.optional()`):
 * Groq/gpt-oss send `null` for omitted optionals and 400 on a bare `.optional()`.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { AssistantHelpers, ToolSet } from '@/lib/ai/context';
import { fromCurrencyGroups, diffByCurrency } from '@/lib/finance/currency';
import { calculateInvoiceMoney } from '@/lib/finance/invoice-money';
import {
  invoiceStatusTransitionError,
  invoiceStatusUpdate,
  PAID_STATUS_ERROR,
} from '@/lib/finance/invoice-status';

// Money columns are Decimal(12,2) — Postgres caps a value at 9,999,999,999.99.
// Bound amounts here so an oversized input is a clean validation error, not a
// raw DB 500. Mirrors src/server/routers/finance.ts.
const MAX_MONEY = 9_999_999_999.99;
const MONEY_MAX_MESSAGE = 'Amount must be 9,999,999,999.99 or less';
const positiveMoney = () => z.number().positive().max(MAX_MONEY, MONEY_MAX_MESSAGE);
const nonNegativeMoney = () => z.number().nonnegative().max(MAX_MONEY, MONEY_MAX_MESSAGE);

const EXPENSE_CATEGORIES = [
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
] as const;

// A recurring expense's stored nextDueDate doesn't advance on its own, so once a
// due date passes it goes stale. Roll it forward by its interval until it lands
// today or later, so we always surface the genuine *next* occurrence. Computed
// on read — we never mutate the row. Mirrors src/server/routers/finance.ts.
const INTERVAL_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

function rollForwardDueDate(due: Date, interval: string, now: Date): Date {
  const stepMonths = INTERVAL_MONTHS[interval.toLowerCase()] ?? 1;
  const next = new Date(due);
  const anchorDay = next.getDate();
  for (let i = 0; next < now && i < 600; i++) {
    next.setDate(anchorDay);
    next.setMonth(next.getMonth() + stepMonths);
  }
  return next;
}

/** Display label for a money amount, e.g. "$1,200" / "Rs 50,000". */
const moneyLabel = (amount: number, currency: string) =>
  currency === 'PKR' ? `Rs ${amount.toLocaleString()}` : `$${amount.toLocaleString()}`;

/**
 * Build the FINANCE tool set. Returns an EMPTY set for non-admins so the model
 * receives no finance tools at all; admins get the full read + write surface.
 */
export function buildFinanceTools(h: AssistantHelpers): ToolSet {
  const { db } = h;
  const tools: ToolSet = {};
  if (!h.isAdmin) return tools; // finance is admin-only — no tools for non-admins.

  const now = () => h.now();
  const FINANCE_RESTRICTED = 'Finance data is restricted to administrators.';

  // Resolve a free-text client name to one client (or candidates to ask about).
  const resolveClient = async (query: string) => {
    const clients = await db.client.findMany({ select: { id: true, name: true } });
    return h.resolveNamed(query, clients);
  };

  // Resolve a free-text project name to one project (or candidates to ask about).
  const resolveProject = async (query: string) => {
    const projects = await db.project.findMany({ select: { id: true, name: true } });
    return h.resolveNamed(query, projects);
  };

  // ─────────────────────────────────── READS ──────────────────────────────────

  tools.getFinanceSummary = tool({
    description:
      'Get a finance summary (income, expenses, profit, margin, invoices) for a period. Use for "how are we doing financially", "this month\'s profit", "income vs expenses". ADMIN ONLY.',
    inputSchema: z.object({
      startDate: z.string().nullish().describe('ISO date; defaults to start of this month'),
      endDate: z.string().nullish().describe('ISO date; defaults to today'),
    }),
    execute: async ({ startDate, endDate }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };
      const today = now();
      const start = startDate
        ? new Date(startDate)
        : new Date(today.getFullYear(), today.getMonth(), 1);
      const end = endDate ? new Date(endDate) : today;

      // FIN-02: group by currency — never report a USD + PKR sum as one number.
      const [incomeG, expenseG, paidG, outstandingG] = await Promise.all([
        db.transaction.groupBy({
          by: ['currency'],
          _sum: { amount: true },
          _count: true,
          where: { type: 'INCOME', date: { gte: start, lte: end } },
        }),
        db.transaction.groupBy({
          by: ['currency'],
          _sum: { amount: true },
          _count: true,
          where: { type: 'EXPENSE', date: { gte: start, lte: end } },
        }),
        db.invoice.groupBy({
          by: ['currency'],
          _sum: { total: true },
          _count: true,
          where: { status: 'PAID' },
        }),
        db.invoice.groupBy({
          by: ['currency'],
          _sum: { total: true },
          _count: true,
          where: { status: { in: ['SENT', 'OVERDUE'] } },
        }),
      ]);

      const income = fromCurrencyGroups(incomeG, 'amount');
      const expense = fromCurrencyGroups(expenseG, 'amount');
      return {
        period: { start, end },
        note: 'Amounts are grouped by currency; never sum across currencies.',
        incomeByCurrency: income,
        incomeCount: incomeG.reduce((s, g) => s + g._count, 0),
        expenseByCurrency: expense,
        expenseCount: expenseG.reduce((s, g) => s + g._count, 0),
        profitByCurrency: diffByCurrency(income, expense),
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
      };
    },
  });

  tools.getPnlReport = tool({
    description:
      'A profit-and-loss report: income, expense, profit and margin per month over the last N months, plus a year-to-date expense breakdown by category. Use for "P&L", "monthly profit trend", "where is the money going", "expense breakdown". ADMIN ONLY.',
    inputSchema: z.object({
      months: z
        .number()
        .int()
        .min(1)
        .max(24)
        .nullish()
        .describe('How many months back (default 12)'),
    }),
    execute: async ({ months }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };
      const span = months ?? 12;
      const today = now();

      // FIN-02: per-month figures are grouped by currency (USD + PKR are never
      // summed together). Each month carries a per-currency breakdown.
      const monthRanges: Date[] = [];
      const groupPromises = [];
      for (let i = span - 1; i >= 0; i--) {
        const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
        monthRanges.push(date);
        groupPromises.push(
          db.transaction.groupBy({
            by: ['currency'],
            _sum: { amount: true },
            where: { type: 'INCOME', date: { gte: date, lte: endOfMonth } },
          }),
          db.transaction.groupBy({
            by: ['currency'],
            _sum: { amount: true },
            where: { type: 'EXPENSE', date: { gte: date, lte: endOfMonth } },
          })
        );
      }

      const groups = await Promise.all(groupPromises);

      const data = monthRanges.map((date, idx) => {
        const income = fromCurrencyGroups(groups[idx * 2], 'amount');
        const expense = fromCurrencyGroups(groups[idx * 2 + 1], 'amount');
        return {
          period: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          incomeByCurrency: income,
          expenseByCurrency: expense,
          profitByCurrency: diffByCurrency(income, expense),
        };
      });

      const categoryGroups = await db.transaction.groupBy({
        by: ['category', 'currency'],
        _sum: { amount: true },
        where: { type: 'EXPENSE', date: { gte: new Date(today.getFullYear(), 0, 1) } },
        orderBy: { _sum: { amount: 'desc' } },
      });

      return {
        note: 'Amounts are grouped by currency; never sum across currencies.',
        data,
        categoryBreakdown: categoryGroups.map((c) => ({
          category: c.category || 'Uncategorized',
          currency: c.currency,
          amount: Number(c._sum.amount || 0),
        })),
      };
    },
  });

  tools.listInvoices = tool({
    description:
      'List invoices with their client, total, status, due date and overdue flag. Use for "outstanding invoices", "unpaid invoices", "who owes us", "<client> invoices", "overdue invoices". ADMIN ONLY.',
    inputSchema: z.object({
      status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']).nullish(),
      clientName: z.string().nullish().describe('Limit to one client (fuzzy name match)'),
      outstandingOnly: z.boolean().nullish().describe('Only SENT/OVERDUE (unpaid) invoices'),
      overdueOnly: z.boolean().nullish().describe('Only invoices past their due date and not paid'),
    }),
    execute: async ({ status, clientName, outstandingOnly, overdueOnly }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };
      const where: Prisma.InvoiceWhereInput = {};
      if (status) where.status = status;
      else if (outstandingOnly) where.status = { in: ['SENT', 'OVERDUE'] };
      if (overdueOnly) {
        where.dueDate = { lt: now() };
        where.status = { in: ['SENT', 'OVERDUE'] };
      }
      if (clientName) {
        const r = await resolveClient(clientName);
        if (r.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };
        where.clientId = r.value.id;
      }
      const invoices = await db.invoice.findMany({
        where,
        take: 50,
        orderBy: { dueDate: 'asc' },
        select: {
          invoiceNumber: true,
          total: true,
          currency: true,
          status: true,
          dueDate: true,
          paidAt: true,
          client: { select: { name: true } },
        },
      });
      return invoices.map((i) => ({
        invoiceNumber: i.invoiceNumber,
        client: i.client.name,
        total: Number(i.total),
        currency: i.currency,
        status: i.status,
        dueDate: i.dueDate,
        overdue: i.status !== 'PAID' && i.status !== 'CANCELLED' && i.dueDate < now(),
      }));
    },
  });

  tools.getInvoice = tool({
    description:
      'Full detail for ONE invoice: client + primary contact, project, line items, subtotal/tax/total, status and key dates. Identify it by its invoice number (e.g. "INV-2026-001") or by client name. Use for "show invoice <number>", "what is on <client>\'s invoice", "the line items on that invoice". ADMIN ONLY.',
    inputSchema: z.object({
      invoiceNumber: z.string().nullish().describe('Invoice number, e.g. "INV-2026-001"'),
      clientName: z
        .string()
        .nullish()
        .describe('Client name — used when no invoice number is given'),
    }),
    execute: async ({ invoiceNumber, clientName }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };
      if (!invoiceNumber && !clientName)
        return { error: 'Provide an invoice number or a client name.' };

      let invoiceId: string | undefined;
      if (invoiceNumber) {
        const matches = await db.invoice.findMany({
          where: { invoiceNumber: { contains: invoiceNumber, mode: 'insensitive' } },
          select: { id: true, invoiceNumber: true },
          take: 6,
        });
        if (matches.length === 0) return { error: `No invoice matches "${invoiceNumber}".` };
        if (matches.length > 1)
          return {
            needsClarification: `Which invoice — ${matches.map((m) => m.invoiceNumber).join(', ')}?`,
          };
        invoiceId = matches[0].id;
      } else if (clientName) {
        const r = await resolveClient(clientName);
        if (r.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };
        const clientInvoices = await db.invoice.findMany({
          where: { clientId: r.value.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, invoiceNumber: true, status: true },
          take: 10,
        });
        if (clientInvoices.length === 0) return { error: `${r.value.name} has no invoices.` };
        if (clientInvoices.length > 1)
          return {
            needsClarification: `${r.value.name} has several invoices — which one? ${clientInvoices
              .map((i) => `${i.invoiceNumber} (${i.status})`)
              .join(', ')}`,
          };
        invoiceId = clientInvoices[0].id;
      }

      const invoice = await db.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          client: { include: { contacts: { where: { isPrimary: true }, take: 1 } } },
          project: { select: { name: true } },
        },
      });
      if (!invoice) return { error: 'That invoice was not found.' };

      const rawItems = Array.isArray(invoice.items)
        ? (invoice.items as Array<{
            description?: string;
            quantity?: number;
            rate?: number;
            amount?: number;
          }>)
        : [];
      const primary = invoice.client.contacts[0];

      return {
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        client: invoice.client.name,
        clientContact: primary ? { name: primary.name, email: primary.email ?? null } : null,
        project: invoice.project?.name ?? null,
        currency: invoice.currency,
        subtotal: Number(invoice.subtotal),
        tax: Number(invoice.tax),
        total: Number(invoice.total),
        dueDate: invoice.dueDate,
        sentAt: invoice.sentAt,
        paidAt: invoice.paidAt,
        notes: invoice.notes,
        overdue:
          invoice.status !== 'PAID' && invoice.status !== 'CANCELLED' && invoice.dueDate < now(),
        items: rawItems.map((it) => ({
          description: it.description ?? '',
          quantity: Number(it.quantity ?? 0),
          unitPrice: Number(it.rate ?? 0),
          amount: Number(it.amount ?? 0),
        })),
      };
    },
  });

  tools.listTransactions = tool({
    description:
      'List financial transactions (income & expenses) with amount, category, date and the project/client they relate to. Filter by type, category or date range. Use for "recent expenses", "income this quarter", "what did we spend on HOSTING", "transactions in May". ADMIN ONLY.',
    inputSchema: z.object({
      type: z.enum(['INCOME', 'EXPENSE']).nullish(),
      category: z.enum(EXPENSE_CATEGORIES).nullish().describe('Expense category filter'),
      startDate: z.string().nullish().describe('ISO date — only transactions on/after'),
      endDate: z.string().nullish().describe('ISO date — only transactions on/before'),
      limit: z.number().int().min(1).max(100).nullish().describe('Default 50'),
    }),
    execute: async ({ type, category, startDate, endDate, limit }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };
      const where: Prisma.TransactionWhereInput = {};
      if (type) where.type = type;
      if (category) where.category = category;
      if (startDate || endDate) {
        where.date = {
          ...(startDate ? { gte: new Date(startDate) } : {}),
          ...(endDate ? { lte: new Date(endDate) } : {}),
        };
      }
      const transactions = await db.transaction.findMany({
        where,
        include: {
          project: { select: { name: true } },
          client: { select: { name: true } },
        },
        orderBy: { date: 'desc' },
        take: limit ?? 50,
      });
      return transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        currency: t.currency,
        category: t.category,
        description: t.description,
        date: t.date,
        project: t.project?.name ?? null,
        client: t.client?.name ?? null,
      }));
    },
  });

  tools.listRecurringExpenses = tool({
    description:
      'List active recurring expenses / subscriptions (name, amount, category, billing interval, next due date, vendor), soonest-due first. Use for "our subscriptions", "recurring costs", "what bills are coming up", "monthly burn". ADMIN ONLY.',
    inputSchema: z.object({}),
    execute: async () => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };
      const expenses = await db.recurringExpense.findMany({ where: { active: true } });
      const today = now();
      today.setHours(0, 0, 0, 0);
      return expenses
        .map((exp) => ({
          ...exp,
          nextDueDate: rollForwardDueDate(exp.nextDueDate, exp.interval, today),
        }))
        .sort((a, b) => a.nextDueDate.getTime() - b.nextDueDate.getTime())
        .map((exp) => ({
          id: exp.id,
          name: exp.name,
          amount: Number(exp.amount),
          currency: exp.currency,
          category: exp.category,
          interval: exp.interval,
          nextDueDate: exp.nextDueDate,
          vendorName: exp.vendorName,
        }));
    },
  });

  // ─────────────────────────────────── WRITES ─────────────────────────────────

  tools.createInvoice = tool({
    description:
      'Create a DRAFT invoice for a client. Give the client name, line items, optional tax and discount amounts, currency and due date. Totals are computed for you. ADMIN ONLY.',
    inputSchema: z.object({
      clientName: z.string().describe('Client to bill (fuzzy name match)'),
      projectName: z.string().nullish().describe('Optional project to attach the invoice to'),
      items: z
        .array(
          z.object({
            description: z.string().min(1),
            quantity: z.number().positive(),
            unitPrice: positiveMoney(),
          })
        )
        .min(1)
        .describe('Line items; each amount = quantity × unitPrice'),
      tax: nonNegativeMoney().nullish().describe('Tax amount to add to the subtotal (default 0)'),
      discount: nonNegativeMoney()
        .nullish()
        .describe('Discount amount to subtract from the subtotal (default 0)'),
      currency: z.enum(['USD', 'PKR']).nullish().describe('Default USD'),
      dueDate: z.string().describe('ISO date the invoice is due'),
      notes: z.string().nullish(),
    }),
    needsApproval: true,
    execute: async ({
      clientName,
      projectName,
      items,
      tax,
      discount,
      currency,
      dueDate,
      notes,
    }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };

      const rc = await resolveClient(clientName);
      if (rc.kind === 'notfound') return { error: `No client matches "${clientName}".` };
      if (rc.kind === 'ambiguous')
        return { needsClarification: `Which client — ${rc.candidates.join(', ')}?` };

      let projectId: string | null = null;
      let resolvedProject: string | undefined;
      if (projectName) {
        const rp = await resolveProject(projectName);
        if (rp.kind === 'notfound') return { error: `No project matches "${projectName}".` };
        if (rp.kind === 'ambiguous')
          return { needsClarification: `Which project — ${rp.candidates.join(', ')}?` };
        projectId = rp.value.id;
        resolvedProject = rp.value.name;
      }

      let money;
      try {
        money = calculateInvoiceMoney(
          items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            rate: item.unitPrice,
          })),
          tax ?? 0,
          discount ?? 0
        );
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Invalid invoice totals' };
      }
      const invCurrency = currency ?? 'USD';

      // Invoice number: INV-<year>-<sequence>. Mirrors the tRPC mutation.
      // FIN-09: per-year sequence so it resets to -001 each January.
      const invYear = new Date().getFullYear();
      const count = await db.invoice.count({
        where: { invoiceNumber: { startsWith: `INV-${invYear}-` } },
      });
      const invoiceNumber = `INV-${invYear}-${String(count + 1).padStart(3, '0')}`;

      const invoice = await db.invoice.create({
        data: {
          invoiceNumber,
          clientId: rc.value.id,
          projectId,
          items: money.items,
          subtotal: money.subtotal,
          discount: money.discount,
          tax: money.tax,
          total: money.total,
          currency: invCurrency,
          status: 'DRAFT',
          dueDate: new Date(dueDate),
          notes: notes ?? null,
        },
        include: { client: { select: { name: true } } },
      });

      h.activity({
        type: 'invoice_created',
        message: `created invoice ${invoice.invoiceNumber} for ${invoice.client.name} ($${Number(
          invoice.total
        ).toLocaleString()})`,
        entityType: 'Invoice',
        entityId: invoice.id,
      });

      // NB: no "Invoice issued" notification here — createInvoice always makes a
      // DRAFT (mirrors the router, which only logs invoice_created activity). The
      // issued/paid notifications belong to updateInvoiceStatus on SENT/PAID.

      h.audit({
        category: 'FINANCE',
        action: 'create_invoice',
        operation: 'CREATE',
        description: `Created invoice ${invoice.invoiceNumber} for ${invoice.client.name}`,
        targetType: 'Invoice',
        targetId: invoice.id,
        targetLabel: invoice.invoiceNumber,
        metadata: { total: money.total, currency: invCurrency },
      });

      return {
        invoiceNumber: invoice.invoiceNumber,
        client: invoice.client.name,
        project: resolvedProject ?? null,
        subtotal: money.subtotal,
        discount: money.discount,
        tax: money.tax,
        total: money.total,
        currency: invCurrency,
        status: invoice.status,
        dueDate: invoice.dueDate,
        note: rc.interpreted ? `Interpreted "${clientName}" as ${rc.value.name}.` : undefined,
      };
    },
  });

  tools.updateInvoiceStatus = tool({
    description:
      "Change an invoice's status to SENT, OVERDUE, CANCELLED or back to DRAFT. Identify it by invoice number. Payments must be recorded with the payment tool; this tool cannot mark an invoice PAID. ADMIN ONLY.",
    inputSchema: z.object({
      invoiceNumber: z.string().describe('Invoice number, e.g. "INV-2026-003"'),
      status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']),
    }),
    needsApproval: true,
    execute: async ({ invoiceNumber, status }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };

      const matches = await db.invoice.findMany({
        where: { invoiceNumber: { contains: invoiceNumber, mode: 'insensitive' } },
        select: { id: true, invoiceNumber: true, status: true },
        take: 6,
      });
      if (matches.length === 0) return { error: `No invoice matches "${invoiceNumber}".` };
      if (matches.length > 1)
        return {
          needsClarification: `Which invoice — ${matches.map((m) => m.invoiceNumber).join(', ')}?`,
        };
      const priorStatus = matches[0].status;

      if (status === 'PAID') return { error: PAID_STATUS_ERROR };

      // FIN-06: no-op → don't re-stamp or re-fire side-effects.
      if (priorStatus === status) {
        return {
          invoiceNumber: matches[0].invoiceNumber,
          status,
          note: `Invoice ${matches[0].invoiceNumber} is already ${status}; nothing changed.`,
        };
      }
      // FIN-06: enforce the status state-machine.
      const transitionError = invoiceStatusTransitionError(priorStatus, status);
      if (transitionError) {
        return {
          error: transitionError,
        };
      }

      const changed = await db.invoice.updateMany({
        where: { id: matches[0].id, status: priorStatus },
        data: invoiceStatusUpdate(priorStatus, status, now()),
      });
      if (changed.count !== 1) {
        return { error: 'Invoice status changed concurrently. Refresh and try again.' };
      }
      const invoice = await db.invoice.findUniqueOrThrow({
        where: { id: matches[0].id },
        include: { client: { select: { name: true } } },
      });

      const totalLabel = `$${Number(invoice.total).toLocaleString()}`;
      if (status === 'SENT') {
        h.activity({
          type: 'invoice_sent',
          message: `sent invoice ${invoice.invoiceNumber} to ${invoice.client.name} (${totalLabel})`,
          entityType: 'Invoice',
          entityId: invoice.id,
        });
      }

      h.audit({
        category: 'FINANCE',
        action: 'update_invoice_status',
        operation: 'UPDATE',
        description: `Set invoice ${invoice.invoiceNumber} to ${status}`,
        targetType: 'Invoice',
        targetId: invoice.id,
        targetLabel: invoice.invoiceNumber,
        changes: { status: { before: priorStatus, after: status } },
      });

      return {
        invoiceNumber: invoice.invoiceNumber,
        client: invoice.client.name,
        status: invoice.status,
        paidAt: invoice.paidAt,
        sentAt: invoice.sentAt,
      };
    },
  });

  tools.createTransaction = tool({
    description:
      'Record a financial transaction — income or an expense. Give the type, amount, a description and (for expenses) a category; optionally tie it to a project or client and set the date. Use for "log a $200 hosting expense", "record income from <client>". ADMIN ONLY.',
    inputSchema: z.object({
      type: z.enum(['INCOME', 'EXPENSE']),
      amount: positiveMoney(),
      description: z.string().min(1),
      category: z.enum(EXPENSE_CATEGORIES).nullish().describe('Expense category (for EXPENSE)'),
      currency: z.enum(['USD', 'PKR']).nullish().describe('Default USD'),
      projectName: z.string().nullish().describe('Optional project to attribute it to'),
      clientName: z.string().nullish().describe('Optional client to attribute it to'),
      date: z.string().nullish().describe('ISO date; defaults to today'),
    }),
    needsApproval: true,
    execute: async ({
      type,
      amount,
      description,
      category,
      currency,
      projectName,
      clientName,
      date,
    }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };

      let projectId: string | null = null;
      let resolvedProject: string | undefined;
      if (projectName) {
        const rp = await resolveProject(projectName);
        if (rp.kind === 'notfound') return { error: `No project matches "${projectName}".` };
        if (rp.kind === 'ambiguous')
          return { needsClarification: `Which project — ${rp.candidates.join(', ')}?` };
        projectId = rp.value.id;
        resolvedProject = rp.value.name;
      }
      let clientId: string | null = null;
      let resolvedClient: string | undefined;
      if (clientName) {
        const rc = await resolveClient(clientName);
        if (rc.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (rc.kind === 'ambiguous')
          return { needsClarification: `Which client — ${rc.candidates.join(', ')}?` };
        clientId = rc.value.id;
        resolvedClient = rc.value.name;
      }

      const when = date ? new Date(date) : now();
      const transaction = await db.transaction.create({
        data: {
          type,
          amount,
          currency: currency ?? 'USD',
          category: category ?? null,
          description,
          projectId,
          clientId,
          date: when,
        },
      });

      h.audit({
        category: 'FINANCE',
        action: 'create_transaction',
        operation: 'CREATE',
        description: `Recorded ${type.toLowerCase()} ${moneyLabel(amount, currency ?? 'USD')} — ${description}`,
        targetType: 'Transaction',
        targetId: transaction.id,
        targetLabel: description,
        metadata: { type, amount, category: category ?? null },
      });

      return {
        id: transaction.id,
        type: transaction.type,
        amount: Number(transaction.amount),
        currency: transaction.currency,
        category: transaction.category,
        description: transaction.description,
        date: transaction.date,
        project: resolvedProject ?? null,
        client: resolvedClient ?? null,
      };
    },
  });

  tools.updateTransaction = tool({
    description:
      'Update an existing transaction — its type, amount, description, category, date, or the project/client it is attributed to. Give the transaction id (from listTransactions) plus the fields to change. ADMIN ONLY.',
    inputSchema: z.object({
      id: z.string().describe('Transaction id from listTransactions'),
      type: z.enum(['INCOME', 'EXPENSE']).nullish(),
      amount: positiveMoney().nullish(),
      description: z.string().min(1).nullish(),
      category: z.enum(EXPENSE_CATEGORIES).nullish(),
      projectName: z.string().nullish(),
      clientName: z.string().nullish(),
      date: z.string().nullish().describe('ISO date'),
    }),
    needsApproval: true,
    execute: async ({ id, type, amount, description, category, projectName, clientName, date }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };

      const existing = await db.transaction.findUnique({
        where: { id },
        select: { id: true, description: true },
      });
      if (!existing) return { error: 'That transaction was not found.' };

      const data: Prisma.TransactionUpdateInput = {};
      if (type != null) data.type = type;
      if (amount != null) data.amount = amount;
      if (description != null) data.description = description;
      if (category != null) data.category = category;
      if (date != null) data.date = new Date(date);
      if (projectName) {
        const rp = await resolveProject(projectName);
        if (rp.kind === 'notfound') return { error: `No project matches "${projectName}".` };
        if (rp.kind === 'ambiguous')
          return { needsClarification: `Which project — ${rp.candidates.join(', ')}?` };
        data.project = { connect: { id: rp.value.id } };
      }
      if (clientName) {
        const rc = await resolveClient(clientName);
        if (rc.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (rc.kind === 'ambiguous')
          return { needsClarification: `Which client — ${rc.candidates.join(', ')}?` };
        data.client = { connect: { id: rc.value.id } };
      }

      const transaction = await db.transaction.update({
        where: { id },
        data,
        include: {
          project: { select: { name: true } },
          client: { select: { name: true } },
        },
      });

      h.audit({
        category: 'FINANCE',
        action: 'update_transaction',
        operation: 'UPDATE',
        description: `Updated transaction "${transaction.description}"`,
        targetType: 'Transaction',
        targetId: transaction.id,
        targetLabel: transaction.description,
      });

      return {
        id: transaction.id,
        type: transaction.type,
        amount: Number(transaction.amount),
        currency: transaction.currency,
        category: transaction.category,
        description: transaction.description,
        date: transaction.date,
        project: transaction.project?.name ?? null,
        client: transaction.client?.name ?? null,
      };
    },
  });

  tools.deleteTransaction = tool({
    description:
      'Permanently delete a transaction. Give the transaction id (from listTransactions). Use for "delete that expense", "remove the duplicate transaction". ADMIN ONLY.',
    inputSchema: z.object({
      id: z.string().describe('Transaction id from listTransactions'),
    }),
    needsApproval: true,
    execute: async ({ id }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };
      const existing = await db.transaction.findUnique({
        where: { id },
        select: { id: true, type: true, amount: true, currency: true, description: true },
      });
      if (!existing) return { error: 'That transaction was not found.' };

      await db.transaction.delete({ where: { id } });

      h.audit({
        category: 'FINANCE',
        action: 'delete_transaction',
        operation: 'DELETE',
        description: `Deleted transaction "${existing.description}" (${moneyLabel(
          Number(existing.amount),
          existing.currency
        )})`,
        targetType: 'Transaction',
        targetId: existing.id,
        targetLabel: existing.description,
      });

      return { deleted: true, description: existing.description };
    },
  });

  tools.createRecurringExpense = tool({
    description:
      'Add a recurring expense / subscription (e.g. hosting, SaaS, salaries) — name, amount, category, billing interval and the next due date. Use for "add a $50/mo subscription for ...", "track our AWS bill". ADMIN ONLY.',
    inputSchema: z.object({
      name: z.string().min(1),
      amount: positiveMoney(),
      category: z.enum(EXPENSE_CATEGORIES),
      interval: z.enum(['monthly', 'quarterly', 'yearly']),
      nextDueDate: z.string().describe('ISO date of the next charge'),
      currency: z.enum(['USD', 'PKR']).nullish().describe('Default USD'),
      vendorName: z.string().nullish(),
    }),
    needsApproval: true,
    execute: async ({ name, amount, category, interval, nextDueDate, currency, vendorName }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };
      const expense = await db.recurringExpense.create({
        data: {
          name,
          amount,
          currency: currency ?? 'USD',
          category,
          interval,
          nextDueDate: new Date(nextDueDate),
          vendorName: vendorName ?? null,
        },
      });

      h.audit({
        category: 'FINANCE',
        action: 'create_recurring_expense',
        operation: 'CREATE',
        description: `Added recurring expense "${expense.name}" (${moneyLabel(
          Number(expense.amount),
          expense.currency
        )}/${expense.interval})`,
        targetType: 'RecurringExpense',
        targetId: expense.id,
        targetLabel: expense.name,
      });

      return {
        id: expense.id,
        name: expense.name,
        amount: Number(expense.amount),
        currency: expense.currency,
        category: expense.category,
        interval: expense.interval,
        nextDueDate: expense.nextDueDate,
        vendorName: expense.vendorName,
      };
    },
  });

  tools.deleteRecurringExpense = tool({
    description:
      'Cancel / stop a recurring expense so it no longer appears in upcoming bills. Give the recurring-expense id (from listRecurringExpenses). Use for "cancel that subscription", "we dropped <vendor>". ADMIN ONLY.',
    inputSchema: z.object({
      id: z.string().describe('Recurring-expense id from listRecurringExpenses'),
    }),
    needsApproval: true,
    execute: async ({ id }) => {
      if (!h.isAdmin) return { error: FINANCE_RESTRICTED };
      const existing = await db.recurringExpense.findUnique({
        where: { id },
        select: { id: true, name: true, active: true },
      });
      if (!existing) return { error: 'That recurring expense was not found.' };

      // Soft-delete: mark inactive (mirrors the tRPC mutation).
      await db.recurringExpense.update({ where: { id }, data: { active: false } });

      h.audit({
        category: 'FINANCE',
        action: 'delete_recurring_expense',
        operation: 'DELETE',
        description: `Cancelled recurring expense "${existing.name}"`,
        targetType: 'RecurringExpense',
        targetId: existing.id,
        targetLabel: existing.name,
        changes: { active: { before: existing.active, after: false } },
      });

      return { cancelled: true, name: existing.name };
    },
  });

  return tools;
}
