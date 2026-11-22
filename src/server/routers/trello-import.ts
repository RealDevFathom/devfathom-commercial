import { createHash } from 'node:crypto';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { assertProjectAccess } from '../authz';
import { TRPCError } from '@trpc/server';
import { trelloBoardSchema, trelloColorMap } from '@/types/trello';
import { trelloRawLimit, trelloRecordLimit } from '@/types/trello-import-limits';
import { uploadNameFromRef } from '@/lib/uploads/registry';
import { acquireTrelloImportLocks } from '@/server/trello-import-locks';

// TRELLO-01: a non-parseable date string in a Trello export (`new Date(...)` →
// Invalid Date) previously crashed the whole transactional import. Parse safely
// and drop bad values instead.
function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// IMP-TRELLO-02 helpers — the Task model has no cover/custom-field columns, so
// this extra Trello data is folded into the task description as clean lines.
// Everything below is intentionally lenient (`unknown` inputs, never throws).

function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : null;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

// Render a Trello custom-field value object ({ text } / { number } / { date } /
// { checked }, or a dropdown option's value) into a display string.
function valueText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if ('checked' in v) {
    const c = asText(v.checked);
    if (c === 'true') return '✓';
    if (c === 'false') return '✗';
    if (c) return c;
  }
  return (
    asText(v.text) ??
    asText(v.number) ??
    asText(v.date) ??
    asText(Object.values(v).find((x) => x !== null && x !== undefined))
  );
}

// A card cover is shown as its color name or image URL, if either is present.
function coverToText(cover: unknown): string | null {
  if (!cover || typeof cover !== 'object') return null;
  const c = cover as Record<string, unknown>;
  return asText(c.color) ?? asText(c.url);
}

// Resolve one card custom-field item to a value string. Dropdown items reference
// an option id on the board-level field definition; tolerate a missing field def.
function customFieldText(
  item: unknown,
  options: ReadonlyMap<string, unknown> | undefined
): string | null {
  const it = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
  if (typeof it.idValue === 'string' && it.idValue) {
    return valueText(options?.get(it.idValue));
  }
  return valueText(it.value);
}

export const trelloImportRouter = router({
  importBoard: protectedProcedure
    .input(
      z
        .object({
          trelloJson: z.unknown(),
          // IMP-TRELLO-01: import into an EXISTING project (lead/admin only) OR
          // create a brand-new project from the export.
          projectId: z.string().optional(),
          newProjectName: z.string().min(1).optional(),
          memberMapping: z.record(z.string(), z.string()), // trelloMemberId -> hubUserId
          includeArchived: z.boolean().default(false),
        })
        .refine((d) => !!d.projectId || !!d.newProjectName, {
          message: 'Provide a target project or a new project name.',
        })
    )
    .mutation(async ({ ctx, input }) => {
      const limit =
        trelloRawLimit(input) ?? trelloRecordLimit(input.trelloJson, input.includeArchived);
      if (limit) throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: limit });
      const parsed = trelloBoardSchema.safeParse(input.trelloJson);
      if (!parsed.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            "This doesn't look like a valid Trello export. Please export your board from Trello > Menu > Print and Export > Export as JSON.",
        });
      }
      const trello = parsed.data;
      // Repeating a card id would apply the same comments and checklists multiple times.
      if (new Set(trello.cards.map((card) => card.id)).size !== trello.cards.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This Trello export repeats a card ID.',
        });
      }

      // DEV-837: an imported attachment is a link, never one of this workspace's
      // uploads. A `/api/files` reference would bypass the upload registry, so
      // the whole import is refused before anything (even a new project) is
      // written.
      if (
        trello.cards.some((card) =>
          card.attachments.some((attachment) => uploadNameFromRef(attachment.url) !== null)
        )
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'This export links attachments to files uploaded in this workspace. Remove those attachments and try again.',
        });
      }
      // The locks and all import writes live in the same tenant transaction.
      const result = await ctx.db.$transaction(async (tx) => {
        await acquireTrelloImportLocks(tx, ctx.session.user.id, ctx.entitlements.organizationId);
        // IMP-TRELLO-01: resolve the target project. A new project makes the caller
        // its LEAD; importing into an EXISTING one is now lead/admin-only (bulk-
        // mutating a shared board shouldn't be open to every member).
        let projectId: string;
        if (input.newProjectName) {
          const project = await tx.project.create({
            data: {
              name: input.newProjectName,
              type: 'INTERNAL',
              status: 'ACTIVE',
              members: { create: { userId: ctx.session.user.id, role: 'LEAD' } },
            },
            select: { id: true },
          });
          projectId = project.id;
        } else {
          projectId = input.projectId!;
          await assertProjectAccess({ ...ctx, db: tx as typeof ctx.db }, projectId);
          if (ctx.session.user.role !== 'ADMIN') {
            const membership = await tx.projectMember.findUnique({
              where: { projectId_userId: { projectId, userId: ctx.session.user.id } },
              select: { role: true },
            });
            if (membership?.role !== 'LEAD') {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'Only the project lead or an admin can import into an existing project.',
              });
            }
          }
        }

        // Whitelist of real project members. Imported attribution (task assignees,
        // comment authorship) is constrained to this set so a caller-supplied
        // memberMapping cannot forge authorship or assign tasks to arbitrary users.
        const projectMemberIds = new Set(
          (
            await tx.projectMember.findMany({
              where: { projectId },
              select: { userId: true },
            })
          ).map((m) => m.userId)
        );

        // IMP-TRELLO-05: dedup even when the export has no `trello.id`. Without an
        // id we derive a stable synthetic key from the export's shape (name + list
        // names + card count), so re-importing the SAME export is still caught as a
        // duplicate rather than silently creating a second copy.
        const boardKey =
          trello.id ||
          `local:${createHash('sha256')
            .update(
              JSON.stringify({
                name: trello.name,
                lists: trello.lists.map((l) => l.name),
                cards: trello.cards.length,
              })
            )
            .digest('hex')
            .slice(0, 40)}`;

        const existing = await tx.board.findUnique({ where: { trelloBoardId: boardKey } });
        if (existing) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `This board has already been imported as "${existing.name}". Delete the existing board first to re-import.`,
          });
        }

        // Filter lists
        const lists = input.includeArchived
          ? trello.lists.sort((a, b) => a.pos - b.pos)
          : trello.lists.filter((l) => !l.closed).sort((a, b) => a.pos - b.pos);

        // Filter cards
        const cards = input.includeArchived
          ? trello.cards.sort((a, b) => a.pos - b.pos)
          : trello.cards.filter((c) => !c.closed).sort((a, b) => a.pos - b.pos);

        // Build ID maps
        const listIdMap = new Map<string, string>(); // trello list id -> hub column id
        const labelIdMap = new Map<string, string>(); // trello label id -> hub label id

        // 1. Create the board
        const board = await tx.board.create({
          data: {
            name: trello.name,
            description: trello.desc || null,
            projectId,
            trelloBoardId: boardKey,
          },
        });

        // 2. Create labels
        const uniqueLabels = trello.labels.filter((l) => l.name || l.color);
        for (const label of uniqueLabels) {
          const color = label.color ? trelloColorMap[label.color] || '#6E7280' : '#6E7280';
          const created = await tx.label.create({
            data: {
              name: label.name || label.color || 'Label',
              color,
              boardId: board.id,
            },
          });
          labelIdMap.set(label.id, created.id);
        }

        // 3. Create columns from lists
        for (let i = 0; i < lists.length; i++) {
          const list = lists[i];
          const column = await tx.column.create({
            data: {
              name: list.name,
              boardId: board.id,
              order: i,
            },
          });
          listIdMap.set(list.id, column.id);
        }

        // Add "Archived" column if including archived cards
        let archivedColumnId: string | null = null;
        if (input.includeArchived) {
          const archivedCards = trello.cards.filter((c) => c.closed);
          if (archivedCards.length > 0) {
            const col = await tx.column.create({
              data: {
                name: 'Archived',
                boardId: board.id,
                order: lists.length,
              },
            });
            archivedColumnId = col.id;
          }
        }

        // IMP-TRELLO-02: index board-level custom-field definitions by id so a
        // card's customFieldItems can be resolved to "Name: value" lines.
        const customFieldMap = new Map<string, (typeof trello.customFields)[number]>();
        const customFieldOptions = new Map<string, Map<string, unknown>>();
        for (const field of trello.customFields) {
          customFieldMap.set(field.id, field);
          const options = new Map<string, unknown>();
          for (const option of field.options) {
            if (!options.has(option.id)) options.set(option.id, option.value);
          }
          customFieldOptions.set(field.id, options);
        }

        // IMP-TRELLO-02: completed cards (dueComplete) should land in a DONE-like
        // column rather than their original list. Reuse an existing done-like list
        // column when the board already has one; otherwise lazily create a "Done"
        // column the first time a completed card needs it.
        const doneListRegex = /\b(done|complete|completed|finished|shipped)\b/i;
        let doneColumnId: string | null = null;
        for (const list of lists) {
          if (doneListRegex.test(list.name)) {
            doneColumnId = listIdMap.get(list.id) ?? null;
            if (doneColumnId) break;
          }
        }
        let createdDoneColumn = false;
        let completedCount = 0;

        // Build checklist map: cardId -> checklists
        const checklistMap = new Map<string, typeof trello.checklists>();
        for (const cl of trello.checklists) {
          const existing = checklistMap.get(cl.idCard) || [];
          existing.push(cl);
          checklistMap.set(cl.idCard, existing);
        }

        // Build comment map: cardId -> comments
        const commentActions = trello.actions.filter(
          (a) => a.type === 'commentCard' && a.data.card
        );
        const commentMap = new Map<string, typeof commentActions>();
        for (const action of commentActions) {
          const cardId = action.data.card!.id;
          const existing = commentMap.get(cardId) || [];
          existing.push(action);
          commentMap.set(cardId, existing);
        }

        // 4. Create tasks from cards.
        // PROJ-02: assign a per-COLUMN running order (0..n). A single global
        // counter produced gapped orders within a column, which broke moveTask's
        // ordering. `tasksCreated` is kept only for the import count.
        let tasksCreated = 0;
        const columnOrder = new Map<string, number>();
        // IMP-TRELLO-04: record cards we couldn't place so the result can report
        // exactly what was skipped instead of silently dropping them.
        const skippedCards: Array<{ name: string; reason: string }> = [];
        for (const card of cards) {
          let columnId = card.closed ? archivedColumnId : listIdMap.get(card.idList);

          if (!columnId) {
            skippedCards.push({
              name: card.name,
              reason: card.closed
                ? 'archived (and the Archived column was not created)'
                : 'its list was not imported',
            });
            continue;
          }

          // IMP-TRELLO-02: a card marked `dueComplete` in Trello is re-routed to a
          // done-like column so it lands as a completed task (not in its original
          // list). Archived cards keep their Archived placement. Only cards that
          // would otherwise have been placed are re-routed — skip behavior above is
          // unchanged.
          if (!card.closed && card.dueComplete) {
            if (!doneColumnId) {
              const doneCol = await tx.column.create({
                data: {
                  name: 'Done',
                  boardId: board.id,
                  order: lists.length + (archivedColumnId ? 1 : 0),
                },
              });
              doneColumnId = doneCol.id;
              createdDoneColumn = true;
            }
            columnId = doneColumnId;
            completedCount++;
          }

          const orderInColumn = columnOrder.get(columnId) ?? 0;
          columnOrder.set(columnId, orderInColumn + 1);

          // IMP-TRELLO-02: the Task model has no cover/custom-field columns, so we
          // fold that data into the description as clean lines: a "Cover:" header,
          // the original card description, then "Field: value" custom-field lines.
          const coverText = coverToText(card.cover);
          const customFieldLines: string[] = [];
          for (const item of card.customFieldItems) {
            const field = customFieldMap.get(item.idCustomField ?? '');
            const text = customFieldText(item, customFieldOptions.get(item.idCustomField ?? ''));
            if (!text) continue;
            const fieldName = field?.name?.trim() || 'Field';
            customFieldLines.push(`${fieldName}: ${text}`);
          }
          const descriptionBlocks = [
            coverText ? `Cover: ${coverText}` : null,
            card.desc || null,
            customFieldLines.length ? customFieldLines.join('\n') : null,
          ].filter((b): b is string => !!b);
          const description = descriptionBlocks.length ? descriptionBlocks.join('\n\n') : null;

          const task = await tx.task.create({
            data: {
              title: card.name,
              description,
              columnId,
              order: orderInColumn,
              priority: 'MEDIUM',
              dueDate: safeDate(card.due),
              createdById: ctx.session.user.id,
            },
          });

          // Map assignees
          const assigneeIds = card.idMembers
            .map((mid) => input.memberMapping[mid])
            .filter((uid) => uid && projectMemberIds.has(uid));

          if (assigneeIds.length > 0) {
            await tx.taskAssignee.createMany({
              data: assigneeIds.map((userId) => ({ taskId: task.id, userId })),
            });
          }

          // Map labels
          const taskLabelIds = card.labels
            .map((l) => labelIdMap.get(l.id))
            .filter(Boolean) as string[];

          if (taskLabelIds.length > 0) {
            await tx.taskLabel.createMany({
              data: taskLabelIds.map((labelId) => ({ taskId: task.id, labelId })),
            });
          }

          // Create checklists
          const cardChecklists = checklistMap.get(card.id) || [];
          for (let ci = 0; ci < cardChecklists.length; ci++) {
            const cl = cardChecklists[ci];
            const checklist = await tx.taskChecklist.create({
              data: {
                name: cl.name,
                taskId: task.id,
                order: ci,
              },
            });

            if (cl.checkItems.length > 0) {
              await tx.taskChecklistItem.createMany({
                data: cl.checkItems.map((item, idx) => ({
                  text: item.name,
                  completed: item.state === 'complete',
                  checklistId: checklist.id,
                  order: idx,
                })),
              });
            }
          }

          // Create attachments
          if (card.attachments.length > 0) {
            await tx.taskAttachment.createMany({
              data: card.attachments.map((att) => ({
                name: att.name,
                url: att.url,
                taskId: task.id,
              })),
            });
          }

          // Create comments
          const cardComments = commentMap.get(card.id) || [];
          for (let start = 0; start < cardComments.length; start += 1_000) {
            const data = cardComments.slice(start, start + 1_000).map((comment) => {
              // Only attribute a comment to a real member of the target project;
              // otherwise fall back to the importer. Prevents audit-trail forgery.
              const mappedUserId = comment.memberCreator
                ? input.memberMapping[comment.memberCreator.id]
                : undefined;
              const userId =
                mappedUserId && projectMemberIds.has(mappedUserId)
                  ? mappedUserId
                  : ctx.session.user.id;
              return {
                content: comment.data.text || '',
                taskId: task.id,
                userId,
                // TRELLO-01: fall back to "now" if the comment timestamp is unparseable.
                createdAt: safeDate(comment.date) ?? new Date(),
              };
            });
            await tx.taskComment.createMany({ data });
          }

          tasksCreated++;
        }

        return {
          boardId: board.id,
          boardName: board.name,
          columnsCreated: lists.length + (archivedColumnId ? 1 : 0) + (createdDoneColumn ? 1 : 0),
          tasksCreated,
          labelsCreated: uniqueLabels.length,
          // IMP-TRELLO-02: how many completed (dueComplete) cards were routed to
          // the done column.
          completedCount,
          // IMP-TRELLO-04: surface partial-failure / skipped-card detail.
          skippedCount: skippedCards.length,
          skipped: skippedCards.slice(0, 100),
        };
      });

      return result;
    }),
});
