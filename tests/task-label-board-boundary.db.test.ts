// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261118124900_task_label_board_boundary/migration.sql',
  'utf8'
);

(url ? describe : describe.skip)('task label board invariant on PostgreSQL', () => {
  let client: Client;
  let schema: string;
  type Snapshot = Record<'tasks' | 'labels' | 'columns' | 'links', Record<string, unknown>[]>;
  let beforeRepair: Snapshot;
  let afterRepair: Snapshot;
  const snapshot = async (): Promise<Snapshot> => {
    const rows = async (sql: string) => (await client.query(sql)).rows;
    return {
      tasks: await rows('SELECT * FROM tasks ORDER BY id'),
      labels: await rows('SELECT * FROM labels ORDER BY id'),
      columns: await rows('SELECT * FROM columns ORDER BY id'),
      links: await rows('SELECT * FROM task_labels ORDER BY id'),
    };
  };
  const connect = async () => {
    const connection = new Client({ connectionString: url });
    await connection.connect();
    await connection.query(`SET search_path TO "${schema}"`);
    await connection.query("SELECT set_config('app.current_organization_id', 'org-a', false)");
    return connection;
  };
  const attach = (connection: Client, label = 'label-a', id = 'link') =>
    connection.query(
      'INSERT INTO task_labels (id, "organizationId", "taskId", "labelId") VALUES ($1, $2, $3, $4)',
      [id, 'org-a', 'task-a', label]
    );
  const move = (connection: Client, column = 'column-b') =>
    connection.query('UPDATE tasks SET "columnId" = $1 WHERE id = $2', [column, 'task-a']);
  const links = async () => (await client.query('SELECT id FROM task_labels ORDER BY id')).rows;
  const backups = async () => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      return (
        await client.query(
          `SELECT id, "organizationId", "taskId", "labelId", "taskBoardId", "labelBoardId"
           FROM task_label_board_repair_backups ORDER BY id`
        )
      ).rows;
    } finally {
      await client.query('COMMIT');
    }
  };

  beforeEach(async () => {
    schema = `labels_${randomUUID().replaceAll('-', '')}`;
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE columns (id text PRIMARY KEY, "organizationId" text NOT NULL, "boardId" text NOT NULL);
      CREATE TABLE labels (id text PRIMARY KEY, "organizationId" text NOT NULL, "boardId" text NOT NULL, name text);
      CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
      CREATE TABLE tasks (id text PRIMARY KEY, "organizationId" text NOT NULL,
        "columnId" text NOT NULL REFERENCES columns, "updatedAt" timestamp NOT NULL DEFAULT '2026-11-01',
        title text NOT NULL DEFAULT 'Task', description text, "order" integer NOT NULL DEFAULT 0,
        priority "Priority" NOT NULL DEFAULT 'MEDIUM', "dueDate" timestamp, "createdById" text NOT NULL DEFAULT 'actor',
        "parentId" text, "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE task_labels (id text PRIMARY KEY, "organizationId" text NOT NULL,
        "taskId" text NOT NULL REFERENCES tasks, "labelId" text NOT NULL REFERENCES labels,
        UNIQUE ("taskId", "labelId"));
      ALTER TABLE columns ADD UNIQUE ("organizationId", id);
      ALTER TABLE tasks ADD UNIQUE ("organizationId", id);
      ALTER TABLE labels ADD UNIQUE ("organizationId", id);
      ALTER TABLE tasks ADD FOREIGN KEY ("organizationId", "columnId")
        REFERENCES columns ("organizationId", id) DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE task_labels ADD FOREIGN KEY ("organizationId", "taskId")
        REFERENCES tasks ("organizationId", id) DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE task_labels ADD FOREIGN KEY ("organizationId", "labelId")
        REFERENCES labels ("organizationId", id) DEFERRABLE INITIALLY DEFERRED;
      INSERT INTO columns VALUES ('column-a', 'org-a', 'board-a'), ('column-a2', 'org-a', 'board-a'),
        ('column-b', 'org-a', 'board-b'), ('other-column', 'org-b', 'other-board');
      INSERT INTO labels VALUES ('label-a', 'org-a', 'board-a', 'A'), ('label-a2', 'org-a', 'board-a', 'A2'),
        ('label-b', 'org-a', 'board-b', 'Private'), ('other-label', 'org-b', 'other-board', 'Other');
      INSERT INTO tasks (id, "organizationId", "columnId") VALUES ('task-a', 'org-a', 'column-a'), ('task-b', 'org-a', 'column-b');
      INSERT INTO task_labels VALUES ('legacy-invalid-a', 'org-a', 'task-a', 'label-b'),
        ('legacy-invalid-b', 'org-a', 'task-b', 'label-a'),
        ('legacy-valid-a', 'org-a', 'task-a', 'label-a'),
        ('legacy-valid-a2', 'org-a', 'task-a', 'label-a2'),
        ('legacy-valid-b', 'org-a', 'task-b', 'label-b');
    `);
    beforeRepair = await snapshot();
    await client.query(migration);
    afterRepair = await snapshot();
    // Start each case from an empty link table.
    await client.query('DELETE FROM task_labels');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });

  it('backs up and removes only legacy wrong-board links, and can be applied again', async () => {
    const expected = [
      {
        id: 'legacy-invalid-a',
        organizationId: 'org-a',
        taskId: 'task-a',
        labelId: 'label-b',
        taskBoardId: 'board-a',
        labelBoardId: 'board-b',
      },
      {
        id: 'legacy-invalid-b',
        organizationId: 'org-a',
        taskId: 'task-b',
        labelId: 'label-a',
        taskBoardId: 'board-b',
        labelBoardId: 'board-a',
      },
    ];
    // Tasks, labels, columns and every valid link are byte-for-byte untouched.
    expect(afterRepair.tasks).toEqual(beforeRepair.tasks);
    expect(afterRepair.labels).toEqual(beforeRepair.labels);
    expect(afterRepair.columns).toEqual(beforeRepair.columns);
    expect(afterRepair.links).toEqual(
      beforeRepair.links.filter((link) => String(link.id).startsWith('legacy-valid'))
    );
    // The backup holds every removed row, and nothing else.
    const removed = beforeRepair.links.filter(
      (link) => !afterRepair.links.some((kept) => kept.id === link.id)
    );
    const backedUp = await backups();
    expect(backedUp).toEqual(expected);
    expect(backedUp.map(({ id, organizationId, taskId, labelId }) => ({
      id,
      organizationId,
      taskId,
      labelId,
    }))).toEqual(removed);

    await attach(client);
    await client.query(migration);
    expect(await links()).toEqual([{ id: 'link' }]);
    expect(await backups()).toEqual(expected);
    expect(
      (await client.query("SELECT current_setting('app.is_platform_admin', true) AS value")).rows[0]
        .value
    ).not.toBe('true');
  });

  it.each(['label-b', 'other-label', 'missing'])(
    'rejects direct attachment of %s',
    async (label) => {
      await expect(attach(client, label)).rejects.toMatchObject({ code: '23514' });
      expect(await links()).toEqual([]);
    }
  );

  it('rejects replacing either side of an existing link with a foreign-board object', async () => {
    await attach(client);
    await expect(
      client.query(`UPDATE task_labels SET "labelId" = 'label-b'`)
    ).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(`UPDATE task_labels SET "taskId" = 'task-b'`)).rejects.toMatchObject({
      code: '23514',
    });
    expect(await links()).toEqual([{ id: 'link' }]);
  });

  it('allows multiple same-board labels and same-board moves without changing the task timestamp', async () => {
    await client.query(`INSERT INTO task_labels VALUES
      ('link', 'org-a', 'task-a', 'label-a'), ('link2', 'org-a', 'task-a', 'label-a2')`);
    expect(
      (await client.query(`SELECT "updatedAt"::text AS value FROM tasks WHERE id = 'task-a'`))
        .rows[0].value
    ).toBe('2026-11-01 00:00:00');
    await move(client, 'column-a2');
    expect(await links()).toHaveLength(2);
  });

  it('supports Prisma nested creation and removes labels on a Prisma task move', async () => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: url, options: `-c search_path=${schema}` },
        { schema }
      ),
    });
    try {
      const task = await prisma.task.create({
        data: {
          title: 'Nested labels',
          columnId: 'column-a',
          organizationId: 'org-a',
          order: 0,
          createdById: 'actor',
          labels: { create: { labelId: 'label-a', organizationId: 'org-a' } },
        },
        select: { id: true, labels: { select: { labelId: true } } },
      });
      expect(task.labels).toEqual([{ labelId: 'label-a' }]);
      await prisma.task.update({
        where: { id: task.id },
        data: { columnId: 'column-b' },
        select: { id: true },
      });
      expect(await links()).toEqual([]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('removes source-board labels on single and bulk task moves, backing each one up', async () => {
    const repairBackups = (await backups()).map((row) => row.id);
    const moveBackups = async () =>
      (await backups()).filter((row) => !repairBackups.includes(row.id));
    await attach(client);
    await move(client);
    expect(await links()).toEqual([]);
    expect(await moveBackups()).toEqual([
      {
        id: 'link',
        organizationId: 'org-a',
        taskId: 'task-a',
        labelId: 'label-a',
        taskBoardId: 'board-b',
        labelBoardId: 'board-a',
      },
    ]);
    await client.query(
      `INSERT INTO task_labels VALUES ('link3', 'org-a', 'task-a', 'label-b'), ('link2', 'org-a', 'task-b', 'label-b')`
    );
    await client.query(`UPDATE tasks SET "columnId" = 'column-a' WHERE id IN ('task-a', 'task-b')`);
    expect(await links()).toEqual([]);
    expect((await moveBackups()).map((row) => row.id)).toEqual(['link', 'link2', 'link3']);
    // Labels and tasks themselves survive the move.
    expect((await client.query('SELECT id FROM labels ORDER BY id')).rows).toHaveLength(4);
    expect((await client.query('SELECT id FROM tasks ORDER BY id')).rows).toHaveLength(2);
  });

  it.each(['columns', 'labels'])(
    'rejects reparenting %s but permits unchanged board ownership',
    async (table) => {
      await attach(client);
      await client.query(`UPDATE ${table} SET "boardId" = "boardId"`);
      await expect(
        client.query(`UPDATE ${table} SET "boardId" = 'board-b' WHERE "boardId" = 'board-a'`)
      ).rejects.toMatchObject({ code: '23514' });
      expect(await links()).toEqual([{ id: 'link' }]);
    }
  );

  it.each(['attach-first', 'move-first'])(
    'serializes concurrent attachments and moves: %s',
    async (order) => {
      const other = await connect();
      try {
        await client.query('BEGIN');
        if (order === 'attach-first') await attach(client);
        else await move(client);
        const {
          rows: [{ pid }],
        } = await other.query('SELECT pg_backend_pid() AS pid');
        let settled = false;
        const pending = (order === 'attach-first' ? move(other) : attach(other))
          .then(
            () => ({ code: 'ok' }),
            (error: { code: string }) => error
          )
          .finally(() => {
            settled = true;
          });
        // Observe PostgreSQL's lock wait, rather than assuming the query started.
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const { rows } = await client.query(
            'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
            [pid]
          );
          if (rows[0].blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        expect(settled).toBe(false);
        await client.query('COMMIT');
        expect((await pending).code).toBe(order === 'attach-first' ? 'ok' : '23514');
        expect(await links()).toEqual([]);
      } finally {
        await client.query('ROLLBACK');
        await other.end();
      }
    }
  );

  it.each(['attach-first', 'move-first'])(
    'rejects stale repeatable-read snapshots: %s',
    async (order) => {
      const other = await connect();
      try {
        await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await other.query('SELECT * FROM tasks');
        if (order === 'attach-first') await attach(client);
        else await move(client);
        await expect(order === 'attach-first' ? move(other) : attach(other)).rejects.toMatchObject({
          code: '40001',
        });
        await other.query('ROLLBACK');
        expect(await links()).toEqual(order === 'attach-first' ? [{ id: 'link' }] : []);
      } finally {
        await other.query('ROLLBACK');
        await other.end();
      }
    }
  );
});
