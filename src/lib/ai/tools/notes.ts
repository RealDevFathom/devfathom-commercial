import { tool } from 'ai';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { AssistantHelpers, ToolSet } from '@/lib/ai/context';

// Every query in this file goes through `h.db` (the shared Prisma client) so the
// authorization context stays bound to the acting user.

// Note visibility + permission — mirror `src/server/routers/notes.ts` (the
// source of truth) EXACTLY. The DB enum is PRIVATE/SHARED/TEAM; PRIVATE is the
// "own only" bucket the assistant brief calls "OWN".
const NoteVisibilityEnum = z.enum(['PRIVATE', 'SHARED', 'TEAM']);
const NotePermissionEnum = z.enum(['VIEW', 'EDIT']);

// ───────────────────────────── Tiptap helpers ──────────────────────────────
// Notes are stored as Tiptap JSON (`contentJson`) plus a plain-text extract
// (`contentText`) used for search. The assistant works in plain text, so we
// convert text → a minimal Tiptap doc and derive `contentText` the same way the
// notes router does. These mirror `extractPlainText` / `extractLinkedNoteIds`
// from notes.ts so the backlink + search behaviour is identical.

/** Build a minimal Tiptap doc (one paragraph per line) from plain text. */
function textToTiptapDoc(text: string): Prisma.InputJsonValue {
  const blocks = text
    .split(/\r?\n/)
    .map((line) =>
      line.length > 0
        ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
        : { type: 'paragraph' }
    );
  return { type: 'doc', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] };
}

/** Extract plain text from Tiptap JSON for the `contentText` search column. */
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

/** Collect ids from `noteLink` nodes — keeps the NoteLink backlink table in sync. */
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
 * Can `userId` edit this note? Mirrors `canEdit` in notes.ts EXACTLY:
 * - the author always can,
 * - TEAM notes are collaboratively editable by anyone,
 * - SHARED notes only by people granted an EDIT share.
 * NOTE: admin is NOT special here — a human admin can't edit via tRPC either.
 */
function canEditNote(
  note: {
    authorId: string;
    visibility: string;
    shares: Array<{ userId: string; permission: string }>;
  },
  userId: string
): boolean {
  if (note.authorId === userId) return true;
  if (note.visibility === 'TEAM') return true;
  if (note.visibility === 'SHARED') {
    return note.shares.some((s) => s.userId === userId && s.permission === 'EDIT');
  }
  return false;
}

export function buildNotesTools(h: AssistantHelpers): ToolSet {
  const tools: ToolSet = {};

  /**
   * The notes a user is allowed to see — mirrors `visibilityWhere` in notes.ts:
   * their own notes, TEAM-wide notes, or SHARED notes shared with them.
   */
  const visibilityWhere: Prisma.NoteWhereInput = {
    OR: [
      { authorId: h.ctx.userId },
      { visibility: 'TEAM' },
      { visibility: 'SHARED', shares: { some: { userId: h.ctx.userId } } },
    ],
  };

  // ───────────────────────────────── READS ─────────────────────────────────
  tools.searchNotes = tool({
    description:
      'Search the knowledge base of written notes / docs (titles + content) that you are allowed to see — your own notes, team-wide notes, and notes shared with you. Optionally scope to a project or client. Use for "do we have notes on <topic>", "find the doc about <X>", "<project> notes".',
    inputSchema: z.object({
      query: z.string().nullish().describe('Text to search in note title/content'),
      projectName: z.string().nullish(),
      clientName: z.string().nullish(),
    }),
    execute: async ({ query, projectName, clientName }) => {
      const filters: Prisma.NoteWhereInput[] = [visibilityWhere];
      if (query) {
        filters.push({
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { contentText: { contains: query, mode: 'insensitive' } },
          ],
        });
      }
      if (projectName) {
        const projects = await h.db.project.findMany({ select: { id: true, name: true } });
        const r = h.resolveNamed(projectName, projects);
        if (r.kind === 'notfound') return { error: `No project matches "${projectName}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which project — ${r.candidates.join(', ')}?` };
        filters.push({ projectId: r.value.id });
      }
      if (clientName) {
        const clients = await h.db.client.findMany({ select: { id: true, name: true } });
        const r = h.resolveNamed(clientName, clients);
        if (r.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };
        filters.push({ clientId: r.value.id });
      }

      const notes = await h.db.note.findMany({
        where: { AND: filters },
        take: 20,
        orderBy: { updatedAt: 'desc' },
        select: {
          title: true,
          contentText: true,
          updatedAt: true,
          visibility: true,
          author: { select: { name: true } },
          project: { select: { name: true } },
          client: { select: { name: true } },
        },
      });
      return notes.map((n) => ({
        title: n.title,
        author: n.author.name,
        project: n.project?.name ?? null,
        client: n.client?.name ?? null,
        visibility: n.visibility,
        updatedAt: n.updatedAt,
        snippet: n.contentText.slice(0, 200),
      }));
    },
  });

  tools.getNote = tool({
    description:
      'Read the FULL content of ONE note / doc, found by its title (fuzzy match) among the notes you can see. Use for "show me the <X> note", "what does the onboarding doc say", "open the note about <topic>". Returns the complete text. Use searchNotes first if you only have a topic.',
    inputSchema: z.object({
      title: z.string().describe('The note title (fuzzy match), e.g. "Onboarding checklist"'),
    }),
    execute: async ({ title }) => {
      const rows = await h.db.note.findMany({
        where: visibilityWhere,
        select: { id: true, title: true },
      });
      const r = h.resolveNamed(
        title,
        rows.map((n) => ({ id: n.id, name: n.title }))
      );
      if (r.kind === 'notfound') return { error: `No note matches "${title}" that you can see.` };
      if (r.kind === 'ambiguous')
        return { needsClarification: `Which note — ${r.candidates.join(', ')}?` };

      const note = await h.db.note.findUnique({
        where: { id: r.value.id },
        select: {
          title: true,
          visibility: true,
          authorId: true,
          contentText: true,
          createdAt: true,
          updatedAt: true,
          author: { select: { name: true } },
          project: { select: { name: true } },
          client: { select: { name: true } },
          shares: { select: { userId: true, permission: true, user: { select: { name: true } } } },
        },
      });
      if (!note) return { error: 'That note was not found.' };

      // Defence-in-depth: re-verify visibility even though resolution was scoped.
      const isAuthor = note.authorId === h.ctx.userId;
      const isTeam = note.visibility === 'TEAM';
      const isSharedWithMe =
        note.visibility === 'SHARED' && note.shares.some((s) => s.userId === h.ctx.userId);
      if (!isAuthor && !isTeam && !isSharedWithMe) {
        return { error: 'You do not have access to that note.' };
      }

      return {
        title: note.title,
        author: note.author.name,
        visibility: note.visibility,
        project: note.project?.name ?? null,
        client: note.client?.name ?? null,
        content: note.contentText,
        editable: canEditNote(note, h.ctx.userId),
        // Only the author (or an admin) sees who a note is shared with.
        sharedWith:
          isAuthor || h.isAdmin
            ? note.shares.map((s) => ({ name: s.user.name, permission: s.permission }))
            : undefined,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        scopeNote: r.interpreted ? `Interpreted "${title}" as ${r.value.name}.` : undefined,
      };
    },
  });

  // ───────────────────────────────── WRITES ────────────────────────────────
  tools.createNote = tool({
    description:
      'Create a new note / doc in the knowledge base, authored by the current user. Provide the body as plain text (paragraphs separated by newlines). Use for "make a note titled X about Y", "write up the meeting notes", "save a doc on <topic>". Set visibility: PRIVATE = only you, TEAM = everyone in the company can view & edit, SHARED = only specific people (then use setNoteShares). Optionally attach it to a project or client by name.',
    inputSchema: z.object({
      title: z.string().nullish().describe('The note title (default "Untitled")'),
      content: z.string().nullish().describe('Note body as plain text (newlines = new paragraphs)'),
      visibility: NoteVisibilityEnum.nullish().describe(
        'PRIVATE (only you), TEAM (whole company, editable), or SHARED (only people you share with). Default PRIVATE.'
      ),
      projectName: z.string().nullish().describe('Attach to this project (fuzzy name match)'),
      clientName: z.string().nullish().describe('Attach to this client (fuzzy name match)'),
    }),
    needsApproval: true,
    execute: async ({
      title: rawTitle,
      content,
      visibility: rawVisibility,
      projectName,
      clientName,
    }) => {
      // .nullish() + execute-side defaults (Groq sends null for omitted optionals).
      const title = (rawTitle && rawTitle.trim()) || 'Untitled';
      const visibility = rawVisibility ?? 'PRIVATE';
      let projectId: string | null = null;
      let clientId: string | null = null;

      if (projectName) {
        const projects = await h.db.project.findMany({ select: { id: true, name: true } });
        const r = h.resolveNamed(projectName, projects);
        if (r.kind === 'notfound') return { error: `No project matches "${projectName}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which project — ${r.candidates.join(', ')}?` };
        projectId = r.value.id;
      }
      if (clientName) {
        const clients = await h.db.client.findMany({ select: { id: true, name: true } });
        const r = h.resolveNamed(clientName, clients);
        if (r.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };
        clientId = r.value.id;
      }

      const contentJson =
        content && content.length > 0
          ? textToTiptapDoc(content)
          : ({ type: 'doc', content: [{ type: 'paragraph' }] } as Prisma.InputJsonValue);
      const contentText = extractPlainText(contentJson);

      const note = await h.db.note.create({
        data: {
          title,
          contentJson,
          contentText,
          authorId: h.ctx.userId,
          visibility,
          projectId,
          clientId,
        },
      });

      // Only non-private notes produce feed entries — mirror notes.create.
      if (visibility !== 'PRIVATE') {
        h.activity({
          type: 'note_created',
          message: `created note "${note.title}"`,
          entityType: 'Note',
          entityId: note.id,
        });
      }
      h.audit({
        category: 'NOTE',
        action: 'note.create',
        operation: 'CREATE',
        description: `created note "${note.title}"`,
        targetType: 'Note',
        targetId: note.id,
        targetLabel: note.title,
        metadata: { visibility, projectId, clientId },
      });

      return {
        title: note.title,
        visibility: note.visibility,
        project: projectName ?? null,
        client: clientName ?? null,
        note:
          visibility === 'SHARED'
            ? 'Created as SHARED — use setNoteShares to grant access to specific people.'
            : undefined,
      };
    },
  });

  tools.updateNote = tool({
    description:
      'Update an existing note / doc, found by its title (fuzzy match). Can change the title, replace the body (plain text), change visibility, or re-attach it to a project/client. Use for "update the <X> note", "change the onboarding doc to say ...", "make the <X> note team-visible". Only the author, anyone for a TEAM note, or someone with EDIT access on a SHARED note may update it. Replacing the body REPLACES the entire content.',
    inputSchema: z.object({
      title: z.string().describe('The current title of the note to update (fuzzy match)'),
      newTitle: z.string().min(1).nullish().describe('A new title'),
      content: z
        .string()
        .nullish()
        .describe('New body as plain text — REPLACES the existing content'),
      visibility: NoteVisibilityEnum.nullish().describe(
        'Change visibility (PRIVATE / TEAM / SHARED)'
      ),
      projectName: z.string().nullish().describe('Re-attach to this project (fuzzy name match)'),
      clientName: z.string().nullish().describe('Re-attach to this client (fuzzy name match)'),
    }),
    needsApproval: true,
    execute: async ({ title, newTitle, content, visibility, projectName, clientName }) => {
      if (
        newTitle == null &&
        content == null &&
        visibility == null &&
        projectName == null &&
        clientName == null
      ) {
        return {
          error: 'Nothing to update — provide a new title, content, visibility, project or client.',
        };
      }

      const rows = await h.db.note.findMany({
        where: visibilityWhere,
        select: { id: true, title: true },
      });
      const r = h.resolveNamed(
        title,
        rows.map((n) => ({ id: n.id, name: n.title }))
      );
      if (r.kind === 'notfound') return { error: `No note matches "${title}" that you can see.` };
      if (r.kind === 'ambiguous')
        return { needsClarification: `Which note — ${r.candidates.join(', ')}?` };

      const existing = await h.db.note.findUnique({
        where: { id: r.value.id },
        include: { shares: true },
      });
      if (!existing) return { error: 'That note was not found.' };
      if (!canEditNote(existing, h.ctx.userId)) {
        return { error: `You do not have permission to edit the note "${existing.title}".` };
      }

      // NOTE-01: visibility + project/client re-attach are author-only (mirrors
      // the tRPC mutation). Editors may change title/content only.
      const isAuthorOrAdmin = existing.authorId === h.ctx.userId || h.isAdmin;
      const changesVisibility = visibility != null && visibility !== existing.visibility;
      if ((changesVisibility || projectName != null || clientName != null) && !isAuthorOrAdmin) {
        return {
          error: `Only the author can change the visibility or linked project/client of "${existing.title}".`,
        };
      }

      const data: Prisma.NoteUpdateInput = {};
      if (newTitle != null) data.title = newTitle;
      if (visibility != null) data.visibility = visibility;

      if (projectName != null) {
        const projects = await h.db.project.findMany({ select: { id: true, name: true } });
        const pr = h.resolveNamed(projectName, projects);
        if (pr.kind === 'notfound') return { error: `No project matches "${projectName}".` };
        if (pr.kind === 'ambiguous')
          return { needsClarification: `Which project — ${pr.candidates.join(', ')}?` };
        data.project = { connect: { id: pr.value.id } };
      }
      if (clientName != null) {
        const clients = await h.db.client.findMany({ select: { id: true, name: true } });
        const cr = h.resolveNamed(clientName, clients);
        if (cr.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (cr.kind === 'ambiguous')
          return { needsClarification: `Which client — ${cr.candidates.join(', ')}?` };
        data.client = { connect: { id: cr.value.id } };
      }

      let linkedIds: string[] | null = null;
      if (content != null) {
        const doc = textToTiptapDoc(content);
        data.contentJson = doc;
        data.contentText = extractPlainText(doc);
        linkedIds = extractLinkedNoteIds(doc);
      }

      // Apply update + resync backlinks atomically — mirrors notes.update.
      const updated = await h.db.$transaction(async (tx) => {
        const note = await tx.note.update({ where: { id: existing.id }, data });
        if (linkedIds !== null) {
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
        }
        return note;
      });

      h.audit({
        category: 'NOTE',
        action: 'note.update',
        operation: 'UPDATE',
        description: `updated note "${updated.title}"`,
        targetType: 'Note',
        targetId: updated.id,
        targetLabel: updated.title,
        changes: {
          ...(newTitle != null ? { title: { before: existing.title, after: newTitle } } : {}),
          ...(visibility != null
            ? { visibility: { before: existing.visibility, after: visibility } }
            : {}),
          ...(content != null ? { content: { before: '(text)', after: '(updated)' } } : {}),
        },
      });

      return {
        title: updated.title,
        visibility: updated.visibility,
        scopeNote: r.interpreted ? `Interpreted "${title}" as ${r.value.name}.` : undefined,
      };
    },
  });

  tools.deleteNote = tool({
    description:
      'Delete a note / doc permanently, found by its title (fuzzy match). Use for "delete the <X> note", "remove the doc about <topic>". Only the author (or an admin) can delete a note. This cannot be undone.',
    inputSchema: z.object({
      title: z.string().describe('The title of the note to delete (fuzzy match)'),
    }),
    needsApproval: true,
    execute: async ({ title }) => {
      const rows = await h.db.note.findMany({
        where: visibilityWhere,
        select: { id: true, title: true },
      });
      const r = h.resolveNamed(
        title,
        rows.map((n) => ({ id: n.id, name: n.title }))
      );
      if (r.kind === 'notfound') return { error: `No note matches "${title}" that you can see.` };
      if (r.kind === 'ambiguous')
        return { needsClarification: `Which note — ${r.candidates.join(', ')}?` };

      const note = await h.db.note.findUnique({
        where: { id: r.value.id },
        select: { id: true, title: true, authorId: true },
      });
      if (!note) return { error: 'That note was not found.' };
      // Author or admin only — mirrors notes.delete.
      if (note.authorId !== h.ctx.userId && !h.isAdmin) {
        return { error: `You can only delete notes you authored.` };
      }

      await h.db.note.delete({ where: { id: note.id } });

      h.audit({
        category: 'NOTE',
        action: 'note.delete',
        operation: 'DELETE',
        description: `deleted note "${note.title}"`,
        targetType: 'Note',
        targetId: note.id,
        targetLabel: note.title,
      });

      return { success: true, title: note.title };
    },
  });

  tools.setNoteShares = tool({
    description:
      'Set who a note / doc is shared with and at what level (VIEW or EDIT), by note title + people\'s names. Use for "share the <X> note with Aisha and Bob", "give Aisha edit access to the onboarding doc", "stop sharing the <X> note" (pass an empty list). This REPLACES the note\'s entire share list. Only the note\'s author can change shares. Shares only grant access when the note\'s visibility is SHARED.',
    inputSchema: z.object({
      title: z.string().describe('The title of the note to share (fuzzy match)'),
      shares: z
        .array(
          z.object({
            person: z.string().describe('The person\'s name to share with (e.g. "Aisha")'),
            permission: NotePermissionEnum.nullish().describe(
              'VIEW (read-only) or EDIT. Default VIEW.'
            ),
          })
        )
        .describe(
          'The complete new set of people to share with — REPLACES any existing shares. Empty array removes all shares.'
        ),
    }),
    needsApproval: true,
    execute: async ({ title, shares }) => {
      const rows = await h.db.note.findMany({
        where: visibilityWhere,
        select: { id: true, title: true },
      });
      const r = h.resolveNamed(
        title,
        rows.map((n) => ({ id: n.id, name: n.title }))
      );
      if (r.kind === 'notfound') return { error: `No note matches "${title}" that you can see.` };
      if (r.kind === 'ambiguous')
        return { needsClarification: `Which note — ${r.candidates.join(', ')}?` };

      const note = await h.db.note.findUnique({
        where: { id: r.value.id },
        select: { id: true, title: true, authorId: true, visibility: true },
      });
      if (!note) return { error: 'That note was not found.' };
      // Only the author can change shares — mirrors notes.setShares.
      if (note.authorId !== h.ctx.userId) {
        return { error: "Only the note's author can change who it is shared with." };
      }

      // Resolve each person; dedupe by userId (last permission wins).
      const resolved = new Map<
        string,
        { userId: string; name: string; permission: 'VIEW' | 'EDIT' }
      >();
      for (const s of shares) {
        const pr = await h.resolvePerson(s.person, { includeInactive: true });
        if (pr.kind === 'notfound') return { error: `No team member matches "${s.person}".` };
        if (pr.kind === 'ambiguous')
          return { needsClarification: `Which person did you mean — ${pr.candidates.join(', ')}?` };
        resolved.set(pr.value.id, {
          userId: pr.value.id,
          name: pr.value.name,
          permission: s.permission ?? 'VIEW',
        });
      }
      const shareData = [...resolved.values()];

      const prevShares = await h.db.noteShare.findMany({
        where: { noteId: note.id },
        select: { userId: true },
      });
      const prevShareCount = prevShares.length;
      const prevUserIds = new Set(prevShares.map((s) => s.userId));

      await h.db.$transaction([
        h.db.noteShare.deleteMany({ where: { noteId: note.id } }),
        ...(shareData.length > 0
          ? [
              h.db.noteShare.createMany({
                data: shareData.map((s) => ({
                  noteId: note.id,
                  userId: s.userId,
                  permission: s.permission,
                })),
                skipDuplicates: true,
              }),
            ]
          : []),
      ]);

      // Only log on net new shares (0→N) — mirror notes.setShares (no feed spam).
      if (prevShareCount === 0 && shareData.length > 0) {
        h.activity({
          type: 'note_shared',
          message: `shared note "${note.title}" with ${shareData.length} member${shareData.length === 1 ? '' : 's'}`,
          entityType: 'Note',
          entityId: note.id,
        });
      }

      // Notify the people newly granted access (skip self & those already shared).
      const newlyAdded = shareData
        .filter((s) => !prevUserIds.has(s.userId) && s.userId !== h.ctx.userId)
        .map((s) => s.userId);
      if (newlyAdded.length > 0) {
        h.notifyUsers(newlyAdded, {
          type: 'note_shared',
          title: 'A note was shared with you',
          message: `${h.ctx.name ?? 'Someone'} shared the note "${note.title}" with you.`,
          entityType: 'Note',
          entityId: note.id,
        });
      }

      h.audit({
        category: 'NOTE',
        action: 'note.setShares',
        operation: 'UPDATE',
        description: `set shares on note "${note.title}" (${shareData.length} ${shareData.length === 1 ? 'person' : 'people'})`,
        targetType: 'Note',
        targetId: note.id,
        targetLabel: note.title,
        metadata: { shares: shareData.map((s) => ({ name: s.name, permission: s.permission })) },
      });

      return {
        title: note.title,
        sharedWith: shareData.map((s) => ({ name: s.name, permission: s.permission })),
        warning:
          note.visibility !== 'SHARED' && shareData.length > 0
            ? `This note's visibility is ${note.visibility}. Shares only grant access when visibility is SHARED — use updateNote to set it.`
            : undefined,
      };
    },
  });

  return tools;
}
