import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { logActivity } from '../activity';
import { optionalWebsiteUrl } from '@/lib/validators';

// Contract `value` shares the Decimal(12,2) money columns used across finance, so
// the largest value Postgres will accept is 9,999,999,999.99 — bound it here so an
// oversized input fails as a clean validation error instead of a raw DB 500.
const MAX_MONEY = 9_999_999_999.99;
const contractValue = () =>
  z.number().nonnegative().max(MAX_MONEY, 'Amount must be 9,999,999,999.99 or less');
const contractStatusEnum = z.enum(['DRAFT', 'SENT', 'SIGNED', 'EXPIRED', 'TERMINATED']);
const currencyEnum = z.enum(['USD', 'PKR']);

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
        contracts: { take: isAdmin ? undefined : 0, orderBy: { createdAt: 'desc' } },
      },
    });

    return client;
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
      return ctx.db.clientContact.create({ data: input });
    }),

  deleteContact: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.clientContact.delete({ where: { id: input.id } });
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
        })
        // CON-01: endDate must not precede startDate (when both are set).
        .refine((d) => !(d.startDate && d.endDate) || d.endDate >= d.startDate, {
          message: 'End date must be on or after the start date.',
          path: ['endDate'],
        })
    )
    .mutation(async ({ ctx, input }) => {
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
        })
        // CON-01: endDate must not precede startDate when both are supplied.
        .refine((d) => !(d.startDate && d.endDate) || d.endDate >= d.startDate, {
          message: 'End date must be on or after the start date.',
          path: ['endDate'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
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
