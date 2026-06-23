import { createHash } from 'node:crypto';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { assertProjectAccess } from '../authz';
import { TRPCError } from '@trpc/server';
import { trelloBoardSchema, trelloColorMap } from '@/types/trello';

// TRELLO-01: a non-parseable date string in a Trello export (`new Date(...)` →
// Invalid Date) previously crashed the whole transactional import. Parse safely
// and drop bad values instead.
function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export const trelloImportRouter = router({
  importBoard: protectedProcedure
    .input(
      z.object({
        trelloJson: z.unknown(),
        projectId: z.string(),
        memberMapping: z.record(z.string(), z.string()), // trelloMemberId -> hubUserId
        includeArchived: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // AuthZ: only a member (or admin) of the target project may import into it.
      // Without this, any employee could import a board into ANY project by id.
      await assertProjectAccess(ctx, input.projectId);

      // Whitelist of real project members. Imported attribution (task assignees,
      // comment authorship) is constrained to this set so a caller-supplied
      // memberMapping cannot forge authorship or assign tasks to arbitrary users.
      const projectMemberIds = new Set(
        (
          await ctx.db.projectMember.findMany({
            where: { projectId: input.projectId },
            select: { userId: true },
          })
        ).map((m) => m.userId)
      );

      // Validate the Trello JSON
      const parsed = trelloBoardSchema.safeParse(input.trelloJson);
      if (!parsed.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            "This doesn't look like a valid Trello export. Please export your board from Trello > Menu > Print and Export > Export as JSON.",
        });
      }

      const trello = parsed.data;

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

      const existing = await ctx.db.board.findUnique({ where: { trelloBoardId: boardKey } });
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

      // Run entire import in a transaction
      const result = await ctx.db.$transaction(async (tx) => {
        // 1. Create the board
        const board = await tx.board.create({
          data: {
            name: trello.name,
            description: trello.desc || null,
            projectId: input.projectId,
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
        for (const card of cards) {
          const columnId = card.closed ? archivedColumnId : listIdMap.get(card.idList);

          if (!columnId) continue;

          const orderInColumn = columnOrder.get(columnId) ?? 0;
          columnOrder.set(columnId, orderInColumn + 1);

          const task = await tx.task.create({
            data: {
              title: card.name,
              description: card.desc || null,
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
          for (const comment of cardComments) {
            // Only attribute a comment to a real member of the target project;
            // otherwise fall back to the importer. Prevents audit-trail forgery.
            const mappedUserId = comment.memberCreator
              ? input.memberMapping[comment.memberCreator.id]
              : undefined;
            const userId =
              mappedUserId && projectMemberIds.has(mappedUserId)
                ? mappedUserId
                : ctx.session.user.id;

            await tx.taskComment.create({
              data: {
                content: comment.data.text || '',
                taskId: task.id,
                userId,
                // TRELLO-01: fall back to "now" if the comment timestamp is unparseable.
                createdAt: safeDate(comment.date) ?? new Date(),
              },
            });
          }

          tasksCreated++;
        }

        return {
          boardId: board.id,
          boardName: board.name,
          columnsCreated: lists.length + (archivedColumnId ? 1 : 0),
          tasksCreated,
          labelsCreated: uniqueLabels.length,
        };
      });

      return result;
    }),
});
