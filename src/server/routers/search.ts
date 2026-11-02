import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { getSearchCategoryAccess } from '@/lib/search-access';
import { router, protectedProcedure } from '../trpc';

/**
 * Cross-entity search powering the Cmd+K palette.
 * Returns small grouped result sets — capped per group — filtered by what the
 * current user is allowed to see.
 */
export const searchRouter = router({
  global: protectedProcedure
    .input(z.object({ query: z.string() }))
    .query(async ({ ctx, input }) => {
      const q = input.query.trim();
      if (q.length === 0) {
        return {
          projects: [],
          tasks: [],
          clients: [],
          notes: [],
          team: [],
        };
      }

      const userId = ctx.session.user.id;
      const isAdmin = ctx.session.user.role === 'ADMIN';
      const insensitive = { contains: q, mode: 'insensitive' as const };
      const access = getSearchCategoryAccess(ctx.entitlements);

      const [projects, tasks, clients, notes, team] = await Promise.all([
        // PROJECTS — admin sees all, employees only their projects
        access.projects
          ? ctx.db.project.findMany({
              where: {
                name: insensitive,
                ...(isAdmin ? {} : { members: { some: { userId } } }),
              },
              select: {
                id: true,
                name: true,
                type: true,
                status: true,
                client: access.clients ? { select: { id: true, name: true } } : false,
              },
              take: 6,
              orderBy: { updatedAt: 'desc' },
            })
          : [],

        // TASKS — admin sees all, employees only tasks in their projects
        access.tasks
          ? ctx.db.task.findMany({
              where: {
                title: insensitive,
                ...(isAdmin
                  ? {}
                  : { column: { board: { project: { members: { some: { userId } } } } } }),
              },
              select: {
                id: true,
                title: true,
                priority: true,
                column: {
                  select: {
                    board: {
                      select: { id: true, project: { select: { id: true, name: true } } },
                    },
                  },
                },
              },
              take: 6,
              orderBy: { updatedAt: 'desc' },
            })
          : [],

        // CLIENTS — everyone can see clients (no revenue exposed here)
        access.clients
          ? ctx.db.client.findMany({
              where: { name: insensitive },
              select: { id: true, name: true, industry: true },
              take: 6,
              orderBy: { name: 'asc' },
            })
          : [],

        // NOTES — only those visible to the user
        access.notes
          ? ctx.db.note.findMany({
              where: {
                AND: [
                  {
                    OR: [{ title: insensitive }, { contentText: insensitive }],
                  },
                  {
                    OR: [
                      { authorId: userId },
                      { visibility: 'TEAM' },
                      { visibility: 'SHARED', shares: { some: { userId } } },
                    ],
                  },
                ],
              },
              select: {
                id: true,
                title: true,
                visibility: true,
                author: { select: { id: true, name: true } },
              },
              take: 6,
              orderBy: { updatedAt: 'desc' },
            }) satisfies Prisma.PrismaPromise<unknown>
          : [],

        // TEAM — everyone can see the directory
        access.team
          ? ctx.db.user.findMany({
              where: {
                OR: [{ name: insensitive }, { email: insensitive }, { title: insensitive }],
                // IMP-HR-07: include ON_LEAVE (still-active) members; only laid-off /
                // deactivated (INACTIVE) people are excluded from search.
                status: { not: 'INACTIVE' },
              },
              select: { id: true, name: true, title: true, avatar: true },
              take: 6,
              orderBy: { name: 'asc' },
            })
          : [],
      ]);

      return { projects, tasks, clients, notes, team };
    }),
});
