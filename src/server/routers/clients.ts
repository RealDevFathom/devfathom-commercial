import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { logActivity } from '../activity';
import { notify } from '@/lib/notifications';
import { optionalWebsiteUrl } from '@/lib/validators';
import { assertInOrganization, workspaceId } from '../org-refs';

// Contract `value` shares the Decimal(12,2) money columns used across finance, so
// the largest value Postgres will accept is 9,999,999,999.99 — bound it here so an
// oversized input fails as a clean validation error instead of a raw DB 500.
const MAX_MONEY = 9_999_999_999.99;
const contractValue = () =>
  z.number().nonnegative().max(MAX_MONEY, 'Amount must be 9,999,999,999.99 or less');
const contractStatusEnum = z.enum(['DRAFT', 'SENT', 'SIGNED', 'EXPIRED', 'TERMINATED']);
const currencyEnum = z.enum(['USD', 'PKR']);

// IMP-CLI-05: guard a contract's optional project link — fail with a clean 404
// instead of a raw FK error (P2003) if the project id doesn't resolve.
async function assertProjectExists(db: Prisma.TransactionClient, projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Linked project not found.' });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export const clientsRouter = router({
  // CANONICAL CLIENT-DIRECTORY TRUST POLICY (AUTHZ-04). One policy, applied across
  // tRPC, REST and the AI assistant so the three surfaces no longer disagree:
  //   • DIRECTORY (client names + basic fields): visible to all authenticated
  //     employees over the session-auth surfaces (tRPC here, AI globalSearch) —
  //     employees need to pick a client on projects/finance forms and in search.
  //   • DETAIL that is finance-sensitive (invoices, contracts, revenue): ADMIN
  //     only — see getById (strips them for non-admins) + revenueByClient below.
  //   • REST /api/v1/clients: ADMIN-BOUND TOKENS ONLY — a deliberately stricter
  //     posture for machine access (a narrow CRM integration token shouldn't
  //     enumerate the directory), enforced by the isAdmin gate on those routes.
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.session.user.role === 'ADMIN';

    const clients = await ctx.db.client.findMany({
      include: {
        contacts: { where: { isPrimary: true }, take: 1 },
        _count: { select: { projects: true, invoices: true, documents: true } },
      },
      orderBy: { name: 'asc' },
    });

    const revenueByClient = isAdmin
      ? await ctx.db.invoice.groupBy({
          by: ['clientId'],
          where: { status: 'PAID' },
          _sum: { total: true },
        })
      : [];
    const revenueMap = new Map(revenueByClient.map((r) => [r.clientId, Number(r._sum.total ?? 0)]));

    return clients.map((c) => ({
      ...c,
      _count: {
        ...c._count,
        invoices: isAdmin ? c._count.invoices : 0,
      },
      totalRevenue: isAdmin ? (revenueMap.get(c.id) ?? 0) : 0,
    }));
  }),

  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const isAdmin = ctx.session.user.role === 'ADMIN';

    // IMP-CLI-08: don't FETCH finance-sensitive rows for non-admins (was loaded
    // then discarded). `take: 0` skips the row load while keeping the array shape
    // stable, so no post-query strip is needed.
    const client = await ctx.db.client.findUnique({
      where: { id: input.id },
      include: {
        contacts: { orderBy: { isPrimary: 'desc' } },
        projects: {
          include: {
            members: {
              include: { user: { select: { id: true, name: true, avatar: true } } },
            },
            _count: { select: { boards: true } },
          },
        },
        invoices: {
          take: isAdmin ? undefined : 0,
          orderBy: { createdAt: 'desc' },
          include: { project: { select: { id: true, name: true } } },
        },
        documents: {
          include: { uploadedBy: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
        contracts: {
          take: isAdmin ? undefined : 0,
          orderBy: { createdAt: 'desc' },
          // IMP-CLI-05: surface the delivery project a contract funds, if linked.
          include: { project: { select: { id: true, name: true } } },
        },
      },
    });

    return client;
  }),

  // IMP-CLI-02: per-client activity timeline (client events + its invoices/
  // contracts for admins) — account context at a glance before a call.
  getActivity: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const isAdmin = ctx.session.user.role === 'ADMIN';
      const [invoices, contracts] = await Promise.all([
        isAdmin
          ? ctx.db.invoice.findMany({ where: { clientId: input.id }, select: { id: true } })
          : Promise.resolve([]),
        isAdmin
          ? ctx.db.contract.findMany({ where: { clientId: input.id }, select: { id: true } })
          : Promise.resolve([]),
      ]);
      const or: Prisma.ActivityWhereInput[] = [{ entityType: 'Client', entityId: input.id }];
      if (invoices.length)
        or.push({ entityType: 'Invoice', entityId: { in: invoices.map((i) => i.id) } });
      if (contracts.length)
        or.push({ entityType: 'Contract', entityId: { in: contracts.map((c) => c.id) } });
      return ctx.db.activity.findMany({
        where: { OR: or },
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { user: { select: { id: true, name: true, avatar: true } } },
      });
    }),

  // IMP-CLI-05: per-client total contracted value, grouped by currency. Money is
  // finance-sensitive, so this mirrors the contracts admin-only posture. USD and
  // PKR contracts are kept on separate rows (never summed across currencies).
  contractedValue: adminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.contract.groupBy({
        by: ['currency'],
        where: { clientId: input.id, value: { not: null } },
        _sum: { value: true },
        _count: { _all: true },
      });
      return rows
        .map((r) => ({
          currency: r.currency,
          total: Number(r._sum.value ?? 0),
          count: r._count._all,
        }))
        .sort((a, b) => b.total - a.total);
    }),

  // IMP-CLI-04 — contract expiry / renewal reminders.
  //
  // sweepExpiredContracts is the action a scheduled job (cron) calls: flip every
  // still-in-force contract whose end date has passed to EXPIRED. Only SENT and
  // SIGNED are touched — DRAFT (never executed), TERMINATED (ended deliberately)
  // and already-EXPIRED rows are deliberately left alone. Best-effort alerts the
  // admins of what lapsed; a notification hiccup never fails the sweep.
  sweepExpiredContracts: adminProcedure.mutation(async ({ ctx }) => {
    const now = new Date();
    // Snapshot the affected rows first — updateMany returns only a count, and we
    // want titles/clients for the activity log + admin alert below.
    const due = await ctx.db.contract.findMany({
      where: { status: { in: ['SENT', 'SIGNED'] }, endDate: { lt: now } },
      select: { id: true, title: true, client: { select: { id: true, name: true } } },
    });
    if (due.length === 0) return { expired: 0 };

    await ctx.db.contract.updateMany({
      where: { id: { in: due.map((c) => c.id) } },
      data: { status: 'EXPIRED' },
    });

    logActivity(ctx.db, ctx.session.user.id, {
      type: 'contract_updated',
      message: `expired ${due.length} contract${due.length === 1 ? '' : 's'} past their end date`,
    });

    // Best-effort: alert the admins which contracts lapsed. `contract_*` types
    // route through the IMP-AUTH-04 'client' notification category (see
    // categoryForType). Guard the lookup so a DB hiccup can't fail the sweep.
    try {
      const admins = await ctx.db.user.findMany({
        where: { role: 'ADMIN', status: { not: 'INACTIVE' } },
        select: { id: true },
      });
      const single = due.length === 1;
      notify(
        ctx.db,
        admins.map((a) => a.id),
        {
          type: 'contract_expired',
          title: single ? 'Contract expired' : 'Contracts expired',
          message: single
            ? `Contract "${due[0].title}" for ${due[0].client.name} has reached its end date and was marked expired.`
            : `${due.length} contracts have passed their end date and were marked expired.`,
          entityType: 'Contract',
          entityId: single ? due[0].id : undefined,
        }
      );
    } catch (err) {
      console.error('[clients.sweepExpiredContracts] admin notification failed', err);
    }

    return { expired: due.length };
  }),

  // getExpiringContracts — renewal reminders. Contracts still in force
  // (SENT/SIGNED) whose end date falls within the next `withinDays`, soonest
  // first, each carrying its client {id,name}. Exposed for a future cross-client
  // "expiring soon" dashboard; the per-client Contracts tab derives its row chips
  // from each contract's endDate directly.
  getExpiringContracts: adminProcedure
    .input(z.object({ withinDays: z.number().int().positive().max(365).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const withinDays = input?.withinDays ?? 30;
      const now = new Date();
      const until = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
      return ctx.db.contract.findMany({
        where: { status: { in: ['SENT', 'SIGNED'] }, endDate: { gte: now, lte: until } },
        orderBy: { endDate: 'asc' },
        include: { client: { select: { id: true, name: true } } },
      });
    }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        website: optionalWebsiteUrl,
        industry: z.string().optional(),
        location: z.string().optional(),
        timezone: z.string().optional(),
        notes: z.string().optional(),
        contacts: z
          .array(
            z.object({
              name: z.string().min(1),
              email: z.string().email().optional(),
              phone: z.string().optional(),
              role: z.string().optional(),
              isPrimary: z.boolean().default(false),
            })
          )
          .default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { contacts, ...clientData } = input;
      const client = await ctx.db.client.create({
        data: {
          ...clientData,
          contacts: contacts.length > 0 ? { create: contacts } : undefined,
        },
      });
      logActivity(ctx.db, ctx.session.user.id, {
        type: 'client_created',
        message: `added client ${client.name}`,
        entityType: 'Client',
        entityId: client.id,
      });
      return client;
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        website: optionalWebsiteUrl.nullable(),
        industry: z.string().nullable().optional(),
        location: z.string().nullable().optional(),
        timezone: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        status: z.enum(['ACTIVE', 'INACTIVE', 'PROSPECT']).optional(),
        // IMP-CLI-03: logo is modeled + shown but was never settable.
        logo: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.db.client.update({ where: { id }, data });
    }),

  addContact: adminProcedure
    .input(
      z.object({
        clientId: z.string(),
        name: z.string().min(1),
        // CLI-02: validate the email when provided (was a bare optional string,
        // inconsistent with client `create` which uses `.email()`). Empty string
        // is accepted as "no email".
        email: z.string().email().or(z.literal('')).optional(),
        phone: z.string().optional(),
        role: z.string().optional(),
        isPrimary: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertInOrganization(ctx.db.client, workspaceId(ctx), [input.clientId]);
      return ctx.db.clientContact.create({ data: input });
    }),

  deleteContact: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.clientContact.delete({ where: { id: input.id } });
    }),

  // IMP-CLI-01: edit a contact + set primary (one primary per client).
  updateContact: adminProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        email: z.string().email().or(z.literal('')).optional(),
        phone: z.string().nullable().optional(),
        role: z.string().nullable().optional(),
        isPrimary: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const contact = await ctx.db.clientContact.findUnique({
        where: { id },
        select: { clientId: true },
      });
      if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' });
      // A client has at most one primary contact — demote the others when promoting.
      if (input.isPrimary === true) {
        await ctx.db.clientContact.updateMany({
          where: { clientId: contact.clientId, id: { not: id } },
          data: { isPrimary: false },
        });
      }
      return ctx.db.clientContact.update({ where: { id }, data });
    }),

  // ── Contracts ─────────────────────────────────────────────────────────────
  // Contracts carry a money `value`, so they're admin-only like the client's
  // invoices (see getById, which strips both for non-admins).
  addContract: adminProcedure
    .input(
      z
        .object({
          clientId: z.string(),
          title: z.string().min(1),
          fileUrl: z.string().optional(),
          value: contractValue().optional(),
          currency: currencyEnum.default('USD'),
          status: contractStatusEnum.default('DRAFT'),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          signedAt: z.date().optional(),
          notes: z.string().optional(),
          // IMP-CLI-05: optionally tie the contract to a delivery project.
          projectId: z.string().optional(),
        })
        // CON-01: endDate must not precede startDate (when both are set).
        .refine((d) => !(d.startDate && d.endDate) || d.endDate >= d.startDate, {
          message: 'End date must be on or after the start date.',
          path: ['endDate'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = workspaceId(ctx);
      await assertInOrganization(ctx.db.client, orgId, [input.clientId]);
      await assertInOrganization(ctx.db.project, orgId, [input.projectId]);
      // IMP-CLI-05: validate a supplied project link before persisting.
      if (input.projectId) await assertProjectExists(ctx.db, input.projectId);
      const contract = await ctx.db.contract.create({ data: input });
      logActivity(ctx.db, ctx.session.user.id, {
        type: 'contract_created',
        message: `added contract "${contract.title}"`,
        entityType: 'Contract',
        entityId: contract.id,
      });
      return contract;
    }),

  updateContract: adminProcedure
    .input(
      z
        .object({
          id: z.string(),
          title: z.string().min(1).optional(),
          fileUrl: z.string().nullable().optional(),
          value: contractValue().nullable().optional(),
          currency: currencyEnum.optional(),
          status: contractStatusEnum.optional(),
          startDate: z.date().nullable().optional(),
          endDate: z.date().nullable().optional(),
          signedAt: z.date().nullable().optional(),
          notes: z.string().nullable().optional(),
          // IMP-CLI-05: set (string) or clear (null) the linked delivery project.
          projectId: z.string().nullable().optional(),
        })
        // CON-01: endDate must not precede startDate when both are supplied.
        .refine((d) => !(d.startDate && d.endDate) || d.endDate >= d.startDate, {
          message: 'End date must be on or after the start date.',
          path: ['endDate'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      await assertInOrganization(ctx.db.project, workspaceId(ctx), [data.projectId]);
      // IMP-CLI-05: validate a newly-set project link (null = clear, skip check).
      if (data.projectId) await assertProjectExists(ctx.db, data.projectId);
      // CON-02: stamp signedAt the first time the EDIT FORM marks a contract SIGNED
      // — the inline status dropdown (setContractStatus) already did; now both agree.
      if (data.status === 'SIGNED' && data.signedAt === undefined) {
        const existing = await ctx.db.contract.findUnique({
          where: { id },
          select: { signedAt: true },
        });
        if (!existing?.signedAt) data.signedAt = new Date();
      }
      const contract = await ctx.db.contract.update({ where: { id }, data });
      logActivity(ctx.db, ctx.session.user.id, {
        type: 'contract_updated',
        message: `updated contract "${contract.title}"`,
        entityType: 'Contract',
        entityId: contract.id,
      });
      return contract;
    }),

  setContractStatus: adminProcedure
    .input(z.object({ id: z.string(), status: contractStatusEnum }))
    .mutation(async ({ ctx, input }) => {
      // Stamp signedAt the first time a contract is marked SIGNED.
      const existing = await ctx.db.contract.findUnique({
        where: { id: input.id },
        select: { signedAt: true },
      });
      const contract = await ctx.db.contract.update({
        where: { id: input.id },
        data: {
          status: input.status,
          ...(input.status === 'SIGNED' && !existing?.signedAt ? { signedAt: new Date() } : {}),
        },
      });
      logActivity(ctx.db, ctx.session.user.id, {
        type: 'contract_updated',
        message: `set contract "${contract.title}" to ${input.status.toLowerCase()}`,
        entityType: 'Contract',
        entityId: contract.id,
      });
      return contract;
    }),

  deleteContract: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const contract = await ctx.db.contract.delete({ where: { id: input.id } });
      logActivity(ctx.db, ctx.session.user.id, {
        type: 'contract_deleted',
        message: `deleted contract "${contract.title}"`,
      });
      return contract;
    }),

  // IMP-CLI-05: draft an invoice straight from a contract's value — carrying its
  // client, linked project and currency through as a single line item. Mirrors
  // finance.createInvoice (server-derived money, annually-reset INV number) so
  // the generated row is indistinguishable from a hand-keyed one.
  generateInvoiceFromContract: adminProcedure
    .input(
      z.object({
        contractId: z.string(),
        dueInDays: z.number().int().positive().max(365).default(30),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const contract = await ctx.db.contract.findUnique({ where: { id: input.contractId } });
      if (!contract) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contract not found' });

      const amount = round2(contract.value != null ? Number(contract.value) : 0);
      if (amount <= 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Set a contract value before generating an invoice.',
        });
      }

      // FIN-09: scope the sequence to THIS year's invoices so it resets each Jan.
      const year = new Date().getFullYear();
      const count = await ctx.db.invoice.count({
        where: { invoiceNumber: { startsWith: `INV-${year}-` } },
      });
      const invoiceNumber = `INV-${year}-${String(count + 1).padStart(3, '0')}`;
      const dueDate = new Date(Date.now() + input.dueInDays * 24 * 60 * 60 * 1000);

      const invoice = await ctx.db.invoice.create({
        data: {
          invoiceNumber,
          clientId: contract.clientId,
          projectId: contract.projectId,
          items: [{ description: contract.title, quantity: 1, rate: amount, amount }],
          subtotal: amount,
          tax: 0,
          total: amount,
          currency: contract.currency,
          status: 'DRAFT',
          dueDate,
          notes: `Generated from contract "${contract.title}"`,
        },
        include: { client: { select: { name: true } } },
      });

      logActivity(ctx.db, ctx.session.user.id, {
        type: 'invoice_created',
        message: `created invoice ${invoice.invoiceNumber} from contract "${contract.title}" for ${invoice.client.name}`,
        entityType: 'Invoice',
        entityId: invoice.id,
      });

      return invoice;
    }),

  delete: adminProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const client = await ctx.db.client.findUnique({
      where: { id: input.id },
      select: { name: true, _count: { select: { invoices: true } } },
    });
    if (!client) throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' });

    // CLI-01: Invoice.clientId is a required relation with no onDelete (Prisma
    // default = Restrict), unlike contacts/contracts/transactions (Cascade). A
    // raw delete therefore throws P2003. Pre-check and return a friendly error
    // the UI can render, instead of a generic failure.
    if (client._count.invoices > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Cannot delete ${client.name}: ${client._count.invoices} invoice(s) reference this client. Delete or reassign them first.`,
      });
    }

    const deleted = await ctx.db.client.delete({ where: { id: input.id } });
    logActivity(ctx.db, ctx.session.user.id, {
      type: 'client_deleted',
      message: `deleted client ${client.name}`,
    });
    return deleted;
  }),
});
