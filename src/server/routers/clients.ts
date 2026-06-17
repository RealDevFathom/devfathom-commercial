import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { logActivity } from '../activity';

export const clientsRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.session.user.role === 'ADMIN';

    const clients = await ctx.db.client.findMany({
      include: {
        contacts: { where: { isPrimary: true }, take: 1 },
        _count: { select: { projects: true, invoices: true, documents: true } },
        invoices: { where: { status: 'PAID' }, select: { total: true } },
      },
      orderBy: { name: 'asc' },
    });

    return clients.map((c) => ({
      ...c,
      _count: {
        ...c._count,
        invoices: isAdmin ? c._count.invoices : 0,
      },
      totalRevenue: isAdmin
        ? c.invoices.reduce((sum, inv) => sum + Number(inv.total), 0)
        : 0,
      invoices: undefined,
    }));
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const isAdmin = ctx.session.user.role === 'ADMIN';

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
            orderBy: { createdAt: 'desc' },
            include: { project: { select: { id: true, name: true } } },
          },
          documents: {
            include: { uploadedBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!client) return null;
      // Strip invoices for non-admin users — keep array shape so client types stay stable.
      return isAdmin ? client : { ...client, invoices: [] as typeof client.invoices };
    }),

  create: adminProcedure
    .input(z.object({
      name: z.string().min(1),
      website: z.string().optional(),
      industry: z.string().optional(),
      location: z.string().optional(),
      timezone: z.string().optional(),
      notes: z.string().optional(),
      contacts: z.array(z.object({
        name: z.string().min(1),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        role: z.string().optional(),
        isPrimary: z.boolean().default(false),
      })).default([]),
    }))
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
    .input(z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      website: z.string().nullable().optional(),
      industry: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE', 'PROSPECT']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.db.client.update({ where: { id }, data });
    }),

  addContact: adminProcedure
    .input(z.object({
      clientId: z.string(),
      name: z.string().min(1),
      email: z.string().optional(),
      phone: z.string().optional(),
      role: z.string().optional(),
      isPrimary: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.clientContact.create({ data: input });
    }),

  deleteContact: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.clientContact.delete({ where: { id: input.id } });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const client = await ctx.db.client.findUnique({
        where: { id: input.id },
        select: { name: true },
      });
      const deleted = await ctx.db.client.delete({ where: { id: input.id } });
      if (client) {
        logActivity(ctx.db, ctx.session.user.id, {
          type: 'client_deleted',
          message: `deleted client ${client.name}`,
        });
      }
      return deleted;
    }),
});
