import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import { router, protectedProcedure } from '../trpc';
import { logActivity } from '../activity';

const NoteVisibilityEnum = z.enum(['PRIVATE', 'SHARED', 'TEAM']);
const NotePermissionEnum = z.enum(['VIEW', 'EDIT']);

// Tiptap JSON shape — kept loose; the editor produces this.
const tiptapJsonSchema = z.unknown();

/**
 * Walk a Tiptap JSON document and collect IDs from `noteLink` nodes.
 * Used to maintain the NoteLink backlink table on save.
 */
function extractLinkedNoteIds(doc: unknown): string[] {
  const ids = new Set<string>();
  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'noteLink' && n.attrs && typeof n.attrs === 'object') {
      const attrs = n.attrs as Record<string, unknown>;
      if (typeof attrs.id === 'string') ids.add(attrs.id);
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  }
  walk(doc);
  return Array.from(ids);
}

/**
 * Extract plain text from Tiptap JSON for search indexing.
 */
function extractPlainText(doc: unknown): string {
  const parts: string[] = [];
  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  }
  walk(doc);
  return parts.join(' ').slice(0, 10000);
}

/**
 * Build a Prisma `where` clause that returns notes the user is allowed to see:
 * - they authored it
 * - it's TEAM-visible
 * - it's SHARED with them via NoteShare
 */
function visibilityWhere(userId: string): Prisma.NoteWhereInput {
  return {
    OR: [
      { authorId: userId },
      { visibility: 'TEAM' },
      { visibility: 'SHARED', shares: { some: { userId } } },
    ],
  };
}

function canEdit(
  note: {
    authorId: string;
    visibility: string;
    shares: Array<{ userId: string; permission: string }>;
  },
  userId: string
): boolean {
  if (note.authorId === userId) return true;
  if (note.visibility === 'TEAM') return true; // team notes are collaboratively editable
  if (note.visibility === 'SHARED') {
    return note.shares.some((s) => s.userId === userId && s.permission === 'EDIT');
  }
  return false;
}

export const notesRouter = router({
  /**
   * List notes the current user can see, with optional filters.
   * - scope=mine        → only authored by me
   * - scope=shared      → shared/team notes I didn't author
   * - scope=all         → everything visible to me (default)
   * - projectId/clientId→ scope to a specific entity
   */
  list: protectedProcedure
    .input(
      z
        .object({
          scope: z.enum(['mine', 'shared', 'all']).default('all'),
          projectId: z.string().optional(),
          clientId: z.string().optional(),
          search: z.string().optional(),
          limit: z.number().int().positive().optional(),
          cursor: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const scope = input?.scope ?? 'all';
      const take = input?.limit ? Math.min(input.limit, 1000) : undefined;

      const where: Prisma.NoteWhereInput = {
        AND: [
          visibilityWhere(userId),
          ...(scope === 'mine' ? [{ authorId: userId }] : []),
          ...(scope === 'shared' ? [{ NOT: { authorId: userId } }] : []),
          ...(input?.projectId ? [{ projectId: input.projectId }] : []),
          ...(input?.clientId ? [{ clientId: input.clientId }] : []),
          ...(input?.search
            ? [
                {
                  OR: [
                    { title: { contains: input.search, mode: 'insensitive' as const } },
                    { contentText: { contains: input.search, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
        ],
      };

      return ctx.db.note.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          title: true,
          visibility: true,
          authorId: true,
          projectId: true,
          clientId: true,
          updatedAt: true,
          createdAt: true,
          author: { select: { id: true, name: true, avatar: true } },
          project: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } },
        },
      });
    }),

  /**
   * Get a single note by id with full content + backlinks.
   * Throws FORBIDDEN if the user can't see it.
   */
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;

    const note = await ctx.db.note.findUnique({
      where: { id: input.id },
      include: {
        author: { select: { id: true, name: true, avatar: true } },
        project: { select: { id: true, name: true } },
        client: { select: { id: true, name: true } },
        shares: {
          include: { user: { select: { id: true, name: true, avatar: true } } },
        },
        // Outgoing forward-links and incoming backlinks
        linksFrom: {
          include: {
            toNote: { select: { id: true, title: true, authorId: true, visibility: true } },
          },
        },
        linksTo: {
          include: {
            fromNote: { select: { id: true, title: true, authorId: true, visibility: true } },
          },
        },
      },
    });

    if (!note) throw new TRPCError({ code: 'NOT_FOUND' });

    // Visibility check
    const isAuthor = note.authorId === userId;
    const isTeam = note.visibility === 'TEAM';
    const isSharedWithMe =
      note.visibility === 'SHARED' && note.shares.some((s) => s.userId === userId);
    if (!isAuthor && !isTeam && !isSharedWithMe) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }

    const editable = canEdit(note, userId);
    // Filter backlinks the user isn't allowed to see
    const visibleBacklinks = note.linksTo.filter((l) => {
      const f = l.fromNote;
      if (f.authorId === userId) return true;
      if (f.visibility === 'TEAM') return true;
      // Skip SHARED backlinks we can't independently verify here
      return false;
    });
    // Same visibility filter for OUTGOING links: a user can craft a noteLink to
    // any note id, so the forward-link must not leak a private note's title.
    const visibleForwardLinks = note.linksFrom.filter((l) => {
      const t = l.toNote;
      if (t.authorId === userId) return true;
      if (t.visibility === 'TEAM') return true;
      return false;
    });

    return { ...note, editable, linksTo: visibleBacklinks, linksFrom: visibleForwardLinks };
  }),

  /**
   * Search notes by title for the [[ autocomplete in the editor.
   * Returns minimal data, capped at 10 results.
   */
  search: protectedProcedure
    .input(z.object({ query: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const q = input.query.trim();
      if (q.length === 0) return [];

      return ctx.db.note.findMany({
        where: {
          AND: [visibilityWhere(userId), { title: { contains: q, mode: 'insensitive' } }],
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { id: true, title: true },
      });
    }),

  /**
   * Create a new note. Defaults to PRIVATE visibility.
   * Optional projectId/clientId attaches the note to that entity.
   */
  create: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1).default('Untitled'),
        contentJson: tiptapJsonSchema.optional(),
        visibility: NoteVisibilityEnum.default('PRIVATE'),
        projectId: z.string().optional(),
        clientId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const contentJson = input.contentJson ?? { type: 'doc', content: [{ type: 'paragraph' }] };
      const contentText = extractPlainText(contentJson);

      const note = await ctx.db.note.create({
        data: {
          title: input.title,
          contentJson: contentJson as Prisma.InputJsonValue,
          contentText,
          authorId: userId,
          visibility: input.visibility,
          projectId: input.projectId,
          clientId: input.clientId,
        },
      });
      // Only team-visible notes produce feed entries — private notes should stay private.
      if (input.visibility !== 'PRIVATE') {
        logActivity(ctx.db, userId, {
          type: 'note_created',
          message: `created note "${note.title}"`,
          entityType: 'Note',
          entityId: note.id,
        });
      }
      return note;
    }),

  /**
   * Update a note's title/content/visibility/attachments.
   * Re-syncs the NoteLink backlink table from the new content.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().min(1).optional(),
        contentJson: tiptapJsonSchema.optional(),
        visibility: NoteVisibilityEnum.optional(),
        projectId: z.string().nullable().optional(),
        clientId: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const existing = await ctx.db.note.findUnique({
        where: { id: input.id },
        include: { shares: true },
      });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' });
      if (!canEdit(existing, userId)) throw new TRPCError({ code: 'FORBIDDEN' });

      // NOTE-01: visibility and project/client re-attach are the AUTHOR's
      // prerogative (mirrors author-only `setShares`). A SHARED-EDIT grantee or a
      // TEAM-note editor may change title/content only — otherwise they could flip
      // a SHARED note to TEAM (company-wide) or PRIVATE (lock the author's other
      // collaborators out). Enforced only when the value actually changes, so a
      // collaborator's ordinary content save (which may echo the current
      // visibility) is never rejected.
      const isAuthorOrAdmin =
        existing.authorId === userId || ctx.session.user.role === 'ADMIN';
      const changesVisibility =
        input.visibility !== undefined && input.visibility !== existing.visibility;
      const changesProject =
        input.projectId !== undefined && input.projectId !== existing.projectId;
      const changesClient =
        input.clientId !== undefined && input.clientId !== existing.clientId;
      if ((changesVisibility || changesProject || changesClient) && !isAuthorOrAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the note author can change its visibility or linked project/client.',
        });
      }

      const data: Prisma.NoteUpdateInput = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.visibility !== undefined) data.visibility = input.visibility;
      if (input.projectId !== undefined) {
        data.project = input.projectId
          ? { connect: { id: input.projectId } }
          : { disconnect: true };
      }
      if (input.clientId !== undefined) {
        data.client = input.clientId ? { connect: { id: input.clientId } } : { disconnect: true };
      }

      let linkedIds: string[] | null = null;
      if (input.contentJson !== undefined) {
        data.contentJson = input.contentJson as Prisma.InputJsonValue;
        data.contentText = extractPlainText(input.contentJson);
        linkedIds = extractLinkedNoteIds(input.contentJson);
      }

      // Apply update + resync backlinks atomically
      const updated = await ctx.db.$transaction(async (tx) => {
        const note = await tx.note.update({ where: { id: input.id }, data });

        if (linkedIds !== null) {
          await tx.noteLink.deleteMany({ where: { fromNoteId: note.id } });
          if (linkedIds.length > 0) {
            // Filter out self-links and any IDs that don't exist
            const validIds = await tx.note.findMany({
              where: { id: { in: linkedIds.filter((id) => id !== note.id) } },
              select: { id: true },
            });
            if (validIds.length > 0) {
              await tx.noteLink.createMany({
                data: validIds.map((v) => ({ fromNoteId: note.id, toNoteId: v.id })),
                skipDuplicates: true,
              });
            }
          }
        }
        return note;
      });

      return updated;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const note = await ctx.db.note.findUnique({ where: { id: input.id } });
      if (!note) throw new TRPCError({ code: 'NOT_FOUND' });
      if (note.authorId !== userId && ctx.session.user.role !== 'ADMIN') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      await ctx.db.note.delete({ where: { id: input.id } });
      return { success: true };
    }),

  /**
   * Replace the share list for a note. Only the author can change shares.
   */
  setShares: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        shares: z.array(z.object({ userId: z.string(), permission: NotePermissionEnum })),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const note = await ctx.db.note.findUnique({ where: { id: input.id } });
      if (!note) throw new TRPCError({ code: 'NOT_FOUND' });
      if (note.authorId !== userId) throw new TRPCError({ code: 'FORBIDDEN' });

      const prevShareCount = await ctx.db.noteShare.count({ where: { noteId: input.id } });

      await ctx.db.$transaction([
        ctx.db.noteShare.deleteMany({ where: { noteId: input.id } }),
        ...(input.shares.length > 0
          ? [
              ctx.db.noteShare.createMany({
                data: input.shares.map((s) => ({ noteId: input.id, ...s })),
                skipDuplicates: true,
              }),
            ]
          : []),
      ]);

      // Only log on net new shares (transitions from 0→N), so toggling permissions doesn't spam the feed.
      if (prevShareCount === 0 && input.shares.length > 0) {
        logActivity(ctx.db, userId, {
          type: 'note_shared',
          message: `shared note "${note.title}" with ${input.shares.length} member${input.shares.length === 1 ? '' : 's'}`,
          entityType: 'Note',
          entityId: input.id,
        });
      }

      return { success: true };
    }),
});
