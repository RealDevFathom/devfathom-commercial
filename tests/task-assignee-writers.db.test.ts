// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';

// Exercise the real writers and database trigger in C's migrated test database.
// Membership checks and writes use the real database and tenant scope.
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
vi.mock('@/server/activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({ appUrl: () => 'https://example.test', templates: {} }));
vi.mock('@/server/audit', () => ({
  recordAudit: vi.fn(),
  recordTrpcAudit: vi.fn(),
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));

let tenancy: typeof import('@/lib/tenancy/scoped-db');
let projects: (typeof import('@/server/routers/projects'))['projectsRouter'];
let trello: (typeof import('@/server/routers/trello-import'))['trelloImportRouter'];
let ai: typeof import('@/lib/ai/tools/tasks');
let context: typeof import('@/lib/ai/context');
const organizationId = `assignment_writers_${randomUUID()}`;
const actor = `${organizationId}_admin`;
const member = `${organizationId}_member`;
const departing = `${organizationId}_departing`;
let db: ScopedDb;

function caller(client = db) {
  return projects.createCaller({
    db: client,
    session: { user: { id: actor, role: 'ADMIN', status: 'ACTIVE', organizationId } },
    organization: { id: organizationId },
    entitlements: { enabledModules: ['projects'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

function execute(name: string, input: Record<string, unknown>, client = db, userId = actor) {
  const helpers = context.createAssistantHelpers(
    { organizationId, userId, role: 'ADMIN', name: 'Admin' },
    client
  );
  const tool = ai.buildTasksTools(helpers)[name] as unknown as {
    execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  return tool.execute(input);
}

async function fixture() {
  return tenancy.withTenantDb(organizationId, async (tx) => {
    const project = await tx.project.create({
      data: {
        name: 'Membership writer regression',
        type: 'INTERNAL',
        members: { create: [{ userId: member }, { userId: departing }] },
      },
    });
    const board = await tx.board.create({ data: { name: 'Board', projectId: project.id } });
    const source = await tx.column.create({ data: { name: 'To Do', boardId: board.id, order: 0 } });
    const target = await tx.column.create({ data: { name: 'In Progress', boardId: board.id, order: 1 } });
    for (const columnId of [source.id, target.id]) {
      await tx.columnDefaultAssignee.createMany({
        data: [
          { columnId, userId: member },
          { columnId, userId: departing },
        ],
      });
    }
    await tx.projectMember.delete({
      where: { projectId_userId: { projectId: project.id, userId: departing } },
    });
    const task = await tx.task.create({
      data: {
        title: 'Existing task',
        columnId: source.id,
        order: 0,
        createdById: actor,
        assignees: { create: { userId: member } },
      },
    });
    return { project, board, source, target, task };
  });
}

async function assignees(taskId: string) {
  const rows = await db.taskAssignee.findMany({ where: { taskId }, select: { userId: true } });
  return rows.map((row) => row.userId).sort();
}

// Let validation succeed, then remove the requested member immediately before
// the replacement transaction. The actual trigger must reject the insert, and
// the old assignments must survive the transaction's rollback.
function removeMemberBeforeTransaction(projectId: string) {
  return new Proxy(db, {
    get(target, key) {
      if (key === '$transaction') {
        return async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          await db.projectMember.delete({
            where: { projectId_userId: { projectId, userId: departing } },
          });
          return db.$transaction(run);
        };
      }
      return Reflect.get(target, key);
    },
  });
}

describe.skipIf(!url)('task writers with the project-membership trigger', () => {
  beforeAll(async () => {
    tenancy = await import('@/lib/tenancy/scoped-db');
    projects = (await import('@/server/routers/projects')).projectsRouter;
    trello = (await import('@/server/routers/trello-import')).trelloImportRouter;
    ai = await import('@/lib/ai/tools/tasks');
    context = await import('@/lib/ai/context');
    db = tenancy.createTenantDb(organizationId, actor);
    await tenancy.withPlatformDb(async (tx) => {
      await tx.organization.create({
        data: {
          id: organizationId,
          slug: organizationId.replaceAll('_', '-'),
          legalName: 'Assignment writers',
          displayName: 'Assignment writers',
          status: 'ACTIVE',
        },
      });
      await seedDepartments(tx, [organizationId], ['ENGINEERING']);
      await tx.user.createMany({
        data: [actor, member, departing].map((id) => ({
          id,
          organizationId,
          name: id,
          email: `${id}@example.test`,
          title: 'Engineer',
          department: 'ENGINEERING',
          role: 'ADMIN' as const,
          status: 'ACTIVE' as const,
        })),
      });
      const installed = await tx.$queryRaw<Array<{ tgname: string }>>`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'task_assignees'::regclass
          AND tgname = 'task_assignee_project_membership_check' AND tgenabled <> 'D'
      `;
      expect(installed).toHaveLength(1);
    });
  });

  afterAll(async () => {
    if (!db) return;
    await tenancy.withTenantDb(organizationId, async (tx) => {
      await tx.project.deleteMany({ where: { organizationId } });
      await tx.auditLog.deleteMany({ where: { organizationId } });
      await tx.user.deleteMany({ where: { organizationId } });
    });
    await tenancy.withPlatformDb(async (tx) => {
      await tx.organizationDepartment.deleteMany({ where: { organizationId } });
      await tx.organization.delete({ where: { id: organizationId } });
    });
    await (await import('@/lib/db')).db.$disconnect();
  });

  it('tRPC creation skips stale defaults and retains current owners', async () => {
    const f = await fixture();
    const task = await caller().createTask({ title: 'UI task', columnId: f.source.id });
    expect(await assignees(task.id)).toEqual([member]);
  });

  it('tRPC creation validates explicit assignees separately from defaults', async () => {
    const f = await fixture();
    await expect(
      caller().createTask({
        title: 'Invalid task',
        columnId: f.source.id,
        assigneeIds: [actor],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const task = await caller().createTask({
      title: 'Valid task',
      columnId: f.source.id,
      assigneeIds: [member, member],
    });
    expect(await assignees(task.id)).toEqual([member]);
  });

  it('AI creation works for a nonmember admin and skips stale defaults', async () => {
    const f = await fixture();
    const result = await execute('createTask', { projectId: f.project.id, title: 'AI task' });
    expect(result.error).toBeUndefined();
    expect(await assignees(result.id as string)).toEqual([member]);
  });

  it('AI creation can leave a task unassigned when there are no eligible defaults', async () => {
    const f = await fixture();
    await db.columnDefaultAssignee.deleteMany({ where: { columnId: f.source.id, userId: member } });
    const result = await execute('createTask', { projectId: f.project.id, title: 'Unassigned task' });
    expect(result.error).toBeUndefined();
    expect(await assignees(result.id as string)).toEqual([]);
  });

  it('AI creation still assigns the acting user when they are a project member', async () => {
    const f = await fixture();
    await db.projectMember.create({ data: { projectId: f.project.id, userId: actor } });
    const result = await execute('createTask', { projectId: f.project.id, title: 'My task' });
    expect(await assignees(result.id as string)).toEqual([actor, member].sort());
  });

  it('AI creation rejects an explicitly named nonmember before creating a task', async () => {
    const f = await fixture();
    const result = await execute('createTask', {
      projectId: f.project.id,
      title: 'Rejected task',
      assignees: ['me'],
    });
    expect(result).toEqual({ error: 'All assignees must be members of the project.' });
    expect(await db.task.count({ where: { columnId: f.source.id } })).toBe(1);
  });

  it('AI move skips stale target defaults', async () => {
    const f = await fixture();
    const result = await execute('moveTask', { taskId: f.task.id, columnName: 'In Progress' });
    expect(result.success).toBe(true);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).columnId).toBe(f.target.id);
    expect(await assignees(f.task.id)).toEqual([member]);
  });

  it.each(['replace', 'add'])('AI %s rejects a nonmember without changing assignments', async (mode) => {
    const f = await fixture();
    const result = await execute('setTaskAssignees', {
      taskId: f.task.id,
      assignees: ['me'],
      mode,
    });
    expect(result).toEqual({ error: 'All assignees must be members of the project.' });
    expect(await assignees(f.task.id)).toEqual([member]);
  });

  it.each(['replace', 'add', 'remove'])('AI %s supports valid assignment changes', async (mode) => {
    const f = await fixture();
    await db.projectMember.create({ data: { projectId: f.project.id, userId: actor } });
    await db.taskAssignee.create({ data: { taskId: f.task.id, userId: actor } });
    const result = await execute('setTaskAssignees', { taskId: f.task.id, assignees: ['me'], mode });
    expect(result.success).toBe(true);
    expect(await assignees(f.task.id)).toEqual(
      mode === 'replace' ? [actor] : mode === 'remove' ? [member] : [actor, member].sort()
    );
  });

  it('AI removal of a nonmember is harmless and clearing assignments still works', async () => {
    const f = await fixture();
    await execute('setTaskAssignees', { taskId: f.task.id, assignees: ['me'], mode: 'remove' });
    expect(await assignees(f.task.id)).toEqual([member]);
    await execute('setTaskAssignees', { taskId: f.task.id, assignees: [], mode: 'replace' });
    expect(await assignees(f.task.id)).toEqual([]);
  });

  it.each(['AI', 'tRPC'])('%s replacement rolls back when membership disappears after validation', async (writer) => {
    const f = await fixture();
    await db.projectMember.create({ data: { projectId: f.project.id, userId: departing } });
    const racingDb = removeMemberBeforeTransaction(f.project.id);
    if (writer === 'AI') {
      await expect(
        execute('setTaskAssignees', {
          taskId: f.task.id,
          assignees: ['me'],
          mode: 'replace',
        }, racingDb, departing)
      ).rejects.toThrow();
    } else {
      await expect(
        caller(racingDb).updateTaskAssignees({
          taskId: f.task.id,
          assigneeIds: [departing],
        })
      ).rejects.toThrow();
    }
    expect(await db.projectMember.count({
      where: { projectId: f.project.id, userId: departing },
    })).toBe(0);
    expect(await assignees(f.task.id)).toEqual([member]);
  });

  it.each(['moveTask', 'bulkMoveTasks'])('tRPC %s remains compatible with stale defaults', async (method) => {
    const f = await fixture();
    if (method === 'moveTask') {
      await caller().moveTask({ taskId: f.task.id, targetColumnId: f.target.id, newOrder: 0 });
    } else {
      await caller().bulkMoveTasks({ taskIds: [f.task.id], targetColumnId: f.target.id });
    }
    expect(await assignees(f.task.id)).toEqual([member]);
  });

  it('membership cleanup records each removed assignment in the tenant audit log', async () => {
    const f = await fixture();
    await caller().removeMember({ projectId: f.project.id, userId: member });
    expect(await assignees(f.task.id)).toEqual([]);
    const audit = await db.auditLog.findMany({
      where: { targetId: f.task.id, action: 'task.assignee_membership_cleanup' },
    });
    expect(audit).toEqual([
      expect.objectContaining({
        organizationId,
        actorType: 'SYSTEM',
        actorId: null,
        source: 'SYSTEM',
        operation: 'DELETE',
        metadata: expect.objectContaining({
          reason: 'project_member_departure',
          userId: member,
          projectId: f.project.id,
          initiatingUserId: actor,
        }),
      }),
    ]);
  });

  it('cross-project cleanup records the removed assignee and destination', async () => {
    const source = await fixture();
    const destination = await fixture();
    await db.projectMember.delete({
      where: { projectId_userId: { projectId: destination.project.id, userId: member } },
    });
    await caller().moveTask({
      taskId: source.task.id,
      targetColumnId: destination.target.id,
      newOrder: 0,
    });
    expect(await assignees(source.task.id)).toEqual([]);
    const audit = await db.auditLog.findMany({
      where: { targetId: source.task.id, action: 'task.assignee_membership_cleanup' },
    });
    expect(audit).toEqual([
      expect.objectContaining({
        organizationId,
        metadata: expect.objectContaining({
          reason: 'task_project_move',
          userId: member,
          columnId: destination.target.id,
        }),
      }),
    ]);
  });

  it('Trello import filters mapped nonmembers before the trigger runs', async () => {
    const f = await fixture();
    const importer = trello.createCaller({
      db,
      session: { user: { id: actor, role: 'ADMIN', status: 'ACTIVE', organizationId } },
      organization: { id: organizationId },
      entitlements: { enabledModules: ['projects'] },
      audit: { detail: {} },
      requestMeta: { ip: null, userAgent: null },
    } as never);
    const result = await importer.importBoard({
      projectId: f.project.id,
      memberMapping: { valid: member, stale: departing, admin: actor },
      trelloJson: {
        id: randomUUID(),
        name: 'Imported board',
        lists: [{ id: 'list', name: 'To Do', pos: 0 }],
        cards: [{
          id: 'card',
          name: 'Imported task',
          idList: 'list',
          pos: 0,
          idMembers: ['valid', 'stale', 'admin'],
        }],
      },
    });
    expect(result.tasksCreated).toBe(1);
    const imported = await db.task.findFirstOrThrow({ where: { column: { boardId: result.boardId } } });
    expect(await assignees(imported.id)).toEqual([member]);
  });
});
