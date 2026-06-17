import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import { trelloBoardSchema, trelloColorMap } from '@/types/trello';

export const trelloImportRouter = router({
  importBoard: protectedProcedure
    .input(z.object({
      trelloJson: z.unknown(),
      projectId: z.string(),
      memberMapping: z.record(z.string(), z.string()), // trelloMemberId -> hubUserId
      includeArchived: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      // Validate the Trello JSON
      const parsed = trelloBoardSchema.safeParse(input.trelloJson);
      if (!parsed.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: "This doesn't look like a valid Trello export. Please export your board from Trello > Menu > Print and Export > Export as JSON.",
        });
      }

      const trello = parsed.data;

      // Check for duplicate import
      if (trello.id) {
        const existing = await ctx.db.board.findUnique({
          where: { trelloBoardId: trello.id },
        });
        if (existing) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `This board has already been imported as "${existing.name}". Delete the existing board first to re-import.`,
          });
        }
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
            trelloBoardId: trello.id || null,
          },
        });

        // 2. Create labels
        const uniqueLabels = trello.labels.filter((l) => l.name || l.color);
        for (const label of uniqueLabels) {
          const color = label.color ? (trelloColorMap[label.color] || '#6E7280') : '#6E7280';
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
        const commentActions = trello.actions.filter((a) => a.type === 'commentCard' && a.data.card);
        const commentMap = new Map<string, typeof commentActions>();
        for (const action of commentActions) {
          const cardId = action.data.card!.id;
          const existing = commentMap.get(cardId) || [];
          existing.push(action);
          commentMap.set(cardId, existing);
        }

        // 4. Create tasks from cards
        let tasksCreated = 0;
        for (const card of cards) {
          const columnId = card.closed
            ? archivedColumnId
            : listIdMap.get(card.idList);

          if (!columnId) continue;

          const task = await tx.task.create({
            data: {
              title: card.name,
              description: card.desc || null,
              columnId,
              order: tasksCreated,
              priority: 'MEDIUM',
              dueDate: card.due ? new Date(card.due) : null,
              createdById: ctx.session.user.id,
            },
          });

          // Map assignees
          const assigneeIds = card.idMembers
            .map((mid) => input.memberMapping[mid])
            .filter(Boolean);

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
            const userId = comment.memberCreator
              ? input.memberMapping[comment.memberCreator.id] || ctx.session.user.id
              : ctx.session.user.id;

            await tx.taskComment.create({
              data: {
                content: comment.data.text || '',
                taskId: task.id,
                userId,
                createdAt: new Date(comment.date),
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
