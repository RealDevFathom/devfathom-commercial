import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import { router, protectedProcedure } from '../trpc';
import { logActivity } from '../activity';
import { notify } from '@/lib/notifications';
import { assertInOrganization, workspaceId } from '../org-refs';

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
 * IMP-NOTE-02 — collect user IDs from Tiptap `mention` nodes, in case a future
 * mention extension emits them (attrs.id). A harmless no-op for the current
 * plain-text editor, which has no mention extension.
 */
function extractMentionNodeUserIds(doc: unknown): string[] {
  const ids = new Set<string>();
  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'mention' && n.attrs && typeof n.attrs === 'object') {
      const attrs = n.attrs as Record<string, unknown>;
      if (typeof attrs.id === 'string') ids.add(attrs.id);
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  }
  walk(doc);
  return Array.from(ids);
}

/**
 * IMP-NOTE-02 — resolve which team members are @mentioned in a note's text.
 *
 * The editor has no Tiptap mention autocomplete, so a mention is just plain
 * text the author types and we resolve on save. Matching is deliberately
 * simple but covers the common forms:
 *   "@FirstnameLastname"  → normalized full name (no spaces)
 *   "@firstname"          → first name (may resolve to several people)
 *   "@local.part"         → email local-part
 *   "@First Last"         → substring match on the full lowercased name
 * Normalization strips non-alphanumerics + lowercases, so "@John.Smith",
 * "@johnsmith" and "@JOHNSMITH" all resolve to John Smith.
 */
function resolveMentionedUserIds(
  text: string,
  team: Array<{ id: string; name: string; email: string }>
): Set<string> {
  const ids = new Set<string>();
  if (!text) return ids;
  const lower = text.toLowerCase();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Contiguous "@token" runs (no spaces): @johnsmith, @john, @john.smith
  const tokens = new Set<string>();
  for (const m of lower.matchAll(/@([a-z0-9._-]{2,40})/g)) {
    const t = norm(m[1]);
    if (t) tokens.add(t);
  }

  for (const u of team) {
    const full = norm(u.name);
    const first = norm(u.name.trim().split(/\s+/)[0] ?? '');
    const local = norm(u.email.split('@')[0] ?? '');
    if (
      (full && tokens.has(full)) ||
      (local && tokens.has(local)) ||
      (first && tokens.has(first))
    ) {
      ids.add(u.id);
      continue;
    }
    // Spaced full-name form: "@john smith"
    const name = u.name.trim().toLowerCase();
    if (name && lower.includes('@' + name)) ids.add(u.id);
  }
  return ids;
}

/**
 * IMP-NOTE-02 — resolve @mentions and SCOPE them to who can actually see the
 * note, so a PRIVATE note can never leak by mentioning someone without access:
 *   PRIVATE → nobody (the author is excluded below regardless)
 *   SHARED  → only users on the share list
 *   TEAM    → any team member
 * The author is always dropped — no self-mentions / self-notifications.
 */
function computeMentionTargets(opts: {
  contentText: string;
  contentJson: unknown;
  visibility: string;
  authorId: string;
  shareUserIds: string[];
  team: Array<{ id: string; name: string; email: string }>;
}): string[] {
  const resolved = resolveMentionedUserIds(opts.contentText, opts.team);
  for (const id of extractMentionNodeUserIds(opts.contentJson)) resolved.add(id);

  let canSee: (id: string) => boolean;
  if (opts.visibility === 'TEAM') {
    const teamIds = new Set(opts.team.map((u) => u.id));
    canSee = (id) => teamIds.has(id);
  } else if (opts.visibility === 'SHARED') {
    const shareSet = new Set(opts.shareUserIds);
    canSee = (id) => shareSet.has(id);
  } else {
    canSee = () => false; // PRIVATE
  }
  return [...resolved].filter((id) => id !== opts.authorId && canSee(id));
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

/**
 * IMP-NOTE-01: keep at most this many revisions per note. After each new snapshot
 * is inserted we prune anything beyond the most-recent N, so history stays bounded.
 */
const REVISION_RETENTION = 50;

/**
 * IMP-NOTE-01: snapshot a note's CURRENT (about-to-be-replaced) title/content into
 * a NoteRevision, then prune older snapshots past REVISION_RETENTION. Always run
 * inside the caller's transaction so the snapshot and the update commit atomically.
 */
async function snapshotAndPrune(
  tx: Prisma.TransactionClient,
  current: { id: string; title: string; contentJson: Prisma.JsonValue; contentText: string },
  editedById: string
) {
  await tx.noteRevision.create({
    data: {
      noteId: current.id,
      title: current.title,
      // Note.contentJson is a non-nullable Json column, so this is always a value.
      contentJson: current.contentJson as Prisma.InputJsonValue,
      contentText: current.contentText,
      editedById,
    },
  });
  const stale = await tx.noteRevision.findMany({
    where: { noteId: current.id },
    orderBy: { createdAt: 'desc' },
    skip: REVISION_RETENTION,
    select: { id: true },
  });
  if (stale.length > 0) {
    await tx.noteRevision.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
  }
}

/**
 * IMP-NOTE-01: load a note and assert the caller may VIEW it — the same gate used
 * by `getById` (author OR TEAM OR a SHARED viewer on the share list). Returns the
 * note (with shares) so callers can reuse it. Throws NOT_FOUND / FORBIDDEN.
 */
async function loadViewableNote(tx: Prisma.TransactionClient, noteId: string, userId: string) {
  const note = await tx.note.findUnique({
    where: { id: noteId },
    include: { shares: true },
  });
  if (!note) throw new TRPCError({ code: 'NOT_FOUND' });
  const isAuthor = note.authorId === userId;
  const isTeam = note.visibility === 'TEAM';
  const isSharedWithMe =
    note.visibility === 'SHARED' && note.shares.some((s) => s.userId === userId);
  if (!isAuthor && !isTeam && !isSharedWithMe) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return note;
}

/**
 * Shared list-row projection so `list` and `notesMentioningMe` return the exact
 * same shape — and therefore the same inferred client type, letting the UI
 * render both with one row component.
 */
const noteListSelect = {
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
} satisfies Prisma.NoteSelect;

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
        select: noteListSelect,
      });
    }),

  /**
   * IMP-NOTE-02: notes that @mention the caller, newest first. Still gated by
   * visibility — a NoteMention is only ever persisted for someone who can see
   * the note, but we re-check here as defense-in-depth (e.g. if a note later
   * flips to PRIVATE without its mention rows being re-derived).
   */
  notesMentioningMe: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    return ctx.db.note.findMany({
      where: {
        AND: [visibilityWhere(userId), { mentions: { some: { userId } } }],
      },
      orderBy: { updatedAt: 'desc' },
      select: noteListSelect,
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
        // IMP-NOTE-02: people @mentioned in this note (already scoped to who can
        // see it). Safe to return to any viewer who passed the visibility check.
        mentions: {
          include: { user: { select: { id: true, name: true, avatar: true } } },
          orderBy: { createdAt: 'asc' },
        },
        // Outgoing forward-links and incoming backlinks
        linksFrom: {
          include: {
            // IMP-NOTE-04: include the viewer's own share row so SHARED links can
            // be resolved against their actual access instead of being dropped.
            toNote: {
              select: {
                id: true,
                title: true,
                authorId: true,
                visibility: true,
                shares: { where: { userId }, select: { userId: true } },
              },
            },
          },
        },
        linksTo: {
          include: {
            fromNote: {
              select: {
                id: true,
                title: true,
                authorId: true,
                visibility: true,
                shares: { where: { userId }, select: { userId: true } },
              },
            },
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
      // IMP-NOTE-04: resolve SHARED backlinks against the viewer's actual shares
      // (the share row was included above) instead of dropping legitimate links.
      if (f.visibility === 'SHARED' && f.shares.length > 0) return true;
      return false;
    });
    // Same visibility filter for OUTGOING links: a user can craft a noteLink to
    // any note id, so the forward-link must not leak a private note's title.
    const visibleForwardLinks = note.linksFrom.filter((l) => {
      const t = l.toNote;
      if (t.authorId === userId) return true;
      if (t.visibility === 'TEAM') return true;
      if (t.visibility === 'SHARED' && t.shares.length > 0) return true;
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
      const orgId = workspaceId(ctx);
      await assertInOrganization(ctx.db.project, orgId, [input.projectId]);
      await assertInOrganization(ctx.db.client, orgId, [input.clientId]);
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

      // IMP-NOTE-02: derive @mentions and notify them. A brand-new note has no
      // shares yet, so PRIVATE/SHARED resolve to nobody; only a TEAM note can
      // mention people at creation time. All targets are "new" → notify all.
      const team = await ctx.db.user.findMany({
        select: { id: true, name: true, email: true },
      });
      const mentionIds = computeMentionTargets({
        contentText,
        contentJson,
        visibility: input.visibility,
        authorId: userId,
        shareUserIds: [],
        team,
      });
      if (mentionIds.length > 0) {
        await ctx.db.noteMention.createMany({
          data: mentionIds.map((uid) => ({ noteId: note.id, userId: uid })),
          skipDuplicates: true,
        });
        notify(ctx.db, mentionIds, {
          type: 'mention',
          title: 'You were mentioned in a note',
          message: `${ctx.session.user.name} mentioned you in "${note.title}"`,
          entityType: 'Note',
          entityId: note.id,
        });
      }

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
      const orgId = workspaceId(ctx);
      await assertInOrganization(ctx.db.project, orgId, [input.projectId]);
      await assertInOrganization(ctx.db.client, orgId, [input.clientId]);

      // Apply update + resync backlinks + mentions atomically
      const { note: updated, toAdd } = await ctx.db.$transaction(async (tx) => {
        // Serialize the full read/snapshot/write sequence for this note. Without
        // this lock, two editors can both snapshot the same old value and one of
        // their edits is then absent from both the live note and its history.
        const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "notes"
          WHERE "id" = ${input.id} AND "organizationId" = ${orgId}
          FOR UPDATE
        `;
        if (lockedRows.length === 0) throw new TRPCError({ code: 'NOT_FOUND' });

        const existing = await tx.note.findFirst({
          where: { id: input.id, organizationId: orgId },
          include: { shares: true, mentions: true },
        });
        if (!existing) throw new TRPCError({ code: 'NOT_FOUND' });
        if (!canEdit(existing, userId)) throw new TRPCError({ code: 'FORBIDDEN' });

        const isAuthorOrAdmin = existing.authorId === userId || ctx.session.user.role === 'ADMIN';
        const changesVisibility =
          input.visibility !== undefined && input.visibility !== existing.visibility;
        const changesProject =
          input.projectId !== undefined && input.projectId !== existing.projectId;
        const changesClient = input.clientId !== undefined && input.clientId !== existing.clientId;
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

        const team = await tx.user.findMany({
          where: { organizationId: orgId },
          select: { id: true, name: true, email: true },
        });
        const effectiveText =
          input.contentJson !== undefined
            ? extractPlainText(input.contentJson)
            : existing.contentText;
        const effectiveJson =
          input.contentJson !== undefined ? input.contentJson : existing.contentJson;
        const targets = computeMentionTargets({
          contentText: effectiveText,
          contentJson: effectiveJson,
          visibility: input.visibility ?? existing.visibility,
          authorId: existing.authorId,
          shareUserIds: existing.shares.map((share) => share.userId),
          team,
        });
        const targetSet = new Set(targets);
        const existingMentionIds = existing.mentions.map((mention) => mention.userId);
        const existingSet = new Set(existingMentionIds);
        const toAdd = targets.filter((id) => !existingSet.has(id));
        const toRemove = existingMentionIds.filter((id) => !targetSet.has(id));

        const titleChanged = input.title !== undefined && input.title !== existing.title;
        const contentChanged =
          input.contentJson !== undefined &&
          JSON.stringify(input.contentJson) !== JSON.stringify(existing.contentJson);

        // IMP-NOTE-01: snapshot the CURRENT content BEFORE it's overwritten, so
        // this edit is diffable and restorable. Runs in the same transaction as
        // the update, then prunes to the most recent REVISION_RETENTION.
        if (titleChanged || contentChanged) {
          await snapshotAndPrune(tx, existing, userId);
        }

        const note = await tx.note.update({
          where: { id: input.id, organizationId: orgId },
          data,
        });

        if (linkedIds !== null) {
          await tx.noteLink.deleteMany({ where: { fromNoteId: note.id } });
          if (linkedIds.length > 0) {
            // Filter out self-links and any IDs that don't exist
            const validIds = await tx.note.findMany({
              where: {
                id: { in: linkedIds.filter((id) => id !== note.id) },
                organizationId: orgId,
              },
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

        if (toRemove.length > 0) {
          await tx.noteMention.deleteMany({
            where: { noteId: note.id, userId: { in: toRemove } },
          });
        }
        if (toAdd.length > 0) {
          await tx.noteMention.createMany({
            data: toAdd.map((uid) => ({ noteId: note.id, userId: uid })),
            skipDuplicates: true,
          });
        }
        return { note, toAdd };
      });

      // Notify only the newly added mentions (fire-and-forget, post-commit).
      if (toAdd.length > 0) {
        notify(ctx.db, toAdd, {
          type: 'mention',
          title: 'You were mentioned in a note',
          message: `${ctx.session.user.name} mentioned you in "${updated.title}"`,
          entityType: 'Note',
          entityId: updated.id,
        });
      }

      return updated;
    }),

  /**
   * IMP-NOTE-01: list a note's version history, newest first. Access-checked with
   * the same visibility gate as `getById` — anyone who can see the note can see
   * who edited it and when (not the full content; that's `getRevision`).
   */
  getNoteRevisions: protectedProcedure
    .input(z.object({ noteId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      await loadViewableNote(ctx.db, input.noteId, userId);
      return ctx.db.noteRevision.findMany({
        where: { noteId: input.noteId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          createdAt: true,
          editedBy: { select: { id: true, name: true } },
        },
      });
    }),

  /**
   * IMP-NOTE-01: full content of a single revision, for the read-only preview.
   * Access-checked via the revision's parent note (same visibility gate).
   */
  getRevision: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const rev = await ctx.db.noteRevision.findUnique({
        where: { id: input.id },
        include: { editedBy: { select: { id: true, name: true } } },
      });
      if (!rev) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadViewableNote(ctx.db, rev.noteId, userId);
      return rev;
    }),

  /**
   * IMP-NOTE-01: restore a note to a previous revision. Author/admin only (the
   * same gate as deleting or changing visibility). The CURRENT content is itself
   * snapshotted first, so a restore is undoable. Re-derives @mentions + backlinks
   * from the restored content so the note's derived tables stay consistent; no
   * mention notifications are sent on restore (we don't re-ping people for old
   * content).
   */
  restoreRevision: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const rev = await ctx.db.noteRevision.findUnique({ where: { id: input.id } });
      if (!rev) throw new TRPCError({ code: 'NOT_FOUND' });

      const note = await ctx.db.note.findUnique({
        where: { id: rev.noteId },
        include: { shares: true, mentions: true },
      });
      if (!note) throw new TRPCError({ code: 'NOT_FOUND' });

      if (note.authorId !== userId && ctx.session.user.role !== 'ADMIN') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the note author can restore a previous version.',
        });
      }

      // Re-derive @mentions for the restored content, scoped to the note's
      // current visibility/shares (mirrors `update`). The author is always
      // dropped inside computeMentionTargets.
      const team = await ctx.db.user.findMany({
        select: { id: true, name: true, email: true },
      });
      const targets = computeMentionTargets({
        contentText: rev.contentText,
        contentJson: rev.contentJson,
        visibility: note.visibility,
        authorId: note.authorId,
        shareUserIds: note.shares.map((s) => s.userId),
        team,
      });
      const targetSet = new Set(targets);
      const existingMentionIds = note.mentions.map((m) => m.userId);
      const existingSet = new Set(existingMentionIds);
      const toAdd = targets.filter((id) => !existingSet.has(id));
      const toRemove = existingMentionIds.filter((id) => !targetSet.has(id));
      const linkedIds = extractLinkedNoteIds(rev.contentJson);

      return ctx.db.$transaction(async (tx) => {
        // Snapshot the CURRENT content first so the restore is itself undoable.
        await snapshotAndPrune(tx, note, userId);

        const next = await tx.note.update({
          where: { id: note.id },
          data: {
            title: rev.title,
            contentJson: rev.contentJson as Prisma.InputJsonValue,
            contentText: rev.contentText,
          },
        });

        // Resync backlinks from the restored content.
        await tx.noteLink.deleteMany({ where: { fromNoteId: note.id } });
        if (linkedIds.length > 0) {
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

        // Resync mentions to match the restored content.
        if (toRemove.length > 0) {
          await tx.noteMention.deleteMany({
            where: { noteId: note.id, userId: { in: toRemove } },
          });
        }
        if (toAdd.length > 0) {
          await tx.noteMention.createMany({
            data: toAdd.map((uid) => ({ noteId: note.id, userId: uid })),
            skipDuplicates: true,
          });
        }

        return next;
      });
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
