import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { assertChannelMember } from '../authz';

export const chatRouter = router({
  getChannels: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    return ctx.db.channel.findMany({
      where: { members: { some: { userId } } },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, avatar: true, status: true } } },
        },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: { sender: { select: { id: true, name: true } } },
        },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }),

  getMessages: protectedProcedure
    .input(
      z.object({
        channelId: z.string(),
        limit: z.number().min(1).max(50).default(30),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.channelId);
      const messages = await ctx.db.message.findMany({
        where: { channelId: input.channelId, parentId: null },
        include: {
          sender: { select: { id: true, name: true, avatar: true } },
          reactions: true,
          attachments: true,
          _count: { select: { replies: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });
      return messages.reverse();
    }),

  sendMessage: protectedProcedure
    .input(
      z.object({
        channelId: z.string(),
        content: z.string().min(1),
        parentId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.channelId);
      const message = await ctx.db.message.create({
        data: {
          content: input.content,
          channelId: input.channelId,
          senderId: ctx.session.user.id,
          parentId: input.parentId,
        },
        include: {
          sender: { select: { id: true, name: true, avatar: true } },
          _count: { select: { replies: true } },
        },
      });

      await ctx.db.channel.update({
        where: { id: input.channelId },
        data: { updatedAt: new Date() },
      });

      return message;
    }),

  createChannel: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        type: z.enum(['GROUP', 'PROJECT']).default('GROUP'),
        memberIds: z.array(z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const allMembers = [...new Set([ctx.session.user.id, ...input.memberIds])];
      return ctx.db.channel.create({
        data: {
          name: input.name,
          description: input.description,
          type: input.type,
          members: { create: allMembers.map((userId) => ({ userId })) },
        },
      });
    }),

  updateChannel: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.id);
      const { id, ...data } = input;
      return ctx.db.channel.update({ where: { id }, data });
    }),

  deleteChannel: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertChannelMember(ctx, input.id);
      return ctx.db.channel.delete({ where: { id: input.id } });
    }),
});
