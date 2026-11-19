// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
// The schema owner builds the fixture and applies the migration; every checked
// behaviour runs on the restricted runtime connection (`url`) under forced RLS.
const ownerUrl = process.env.OWNER_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261118124900_task_label_board_boundary/migration.sql',
  'utf8'
);

(url ? describe : describe.skip)('task label board invariant on PostgreSQL', () => {
  let client: Client;
  let owner: Client;
  let schema: string;
  type Snapshot = Record<'tasks' | 'labels' | 'columns' | 'links', Record<string, unknown>[]>;
  let beforeRepair: Snapshot;
  let afterRepair: Snapshot;
  // Reads or writes every tenant's rows, with platform scope that ends at COMMIT.
  const acrossTenants = async <T>(connection: Client, work: () => Promise<T>) => {
    await connection.query('BEGIN');
    try {
      await connection.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      return await work();
    } finally {
      await connection.query('COMMIT');
    }
  };
  const snapshot = (): Promise<Snapshot> =>
    acrossTenants(owner, async () => {
      const rows = async (sql: string) => (await owner.query(sql)).rows;
      return {
        tasks: await rows('SELECT * FROM tasks ORDER BY id'),
        labels: await rows('SELECT * FROM labels ORDER BY id'),
        columns: await rows('SELECT * FROM columns ORDER BY id'),
        links: await rows('SELECT * FROM task_labels ORDER BY id'),
      };
    });
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
  const backups = () =>
    acrossTenants(
      client,
      async () =>
        (
          await client.query(
            `SELECT id, "organizationId", "taskId", "labelId", "taskBoardId", "labelBoardId"
             FROM task_label_board_repair_backups ORDER BY id`
          )
        ).rows
    );

  beforeEach(async () => {
    schema = `labels_${randomUUID().replaceAll('-', '')}`;
    client = new Client({ connectionString: url });
    owner = ownerUrl ? new Client({ connectionString: ownerUrl }) : client;
    await client.connect();
    if (owner !== client) await owner.connect();
    const {
      rows: [role],
    } = await client.query(
      'SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect({ rolsuper: role.rolsuper, rolbypassrls: role.rolbypassrls }).toEqual({
      rolsuper: false,
      rolbypassrls: false,
    });
    await owner.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    await owner.query(`
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
    `);
    // The production tenant boundary on every table the migration touches.
    for (const table of ['columns', 'labels', 'tasks', 'task_labels']) {
      await owner.query(`
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON ${table}
          USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
          WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))`);
    }
    // Legacy rows of two tenants, written before the migration installs its guards.
    await acrossTenants(owner, () =>
      owner.query(`
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
    `)
    );
    beforeRepair = await snapshot();
    await owner.query(migration);
    afterRepair = await snapshot();
    // Start each case from an empty link table.
    await acrossTenants(owner, () => owner.query('DELETE FROM task_labels'));
    if (owner !== client) {
      const runtime = `"${String(role.name).replaceAll('"', '""')}"`;
      await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${runtime};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${runtime}`);
    }
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("SELECT set_config('app.current_organization_id', 'org-a', false)");
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
    if (owner !== client) await owner.end();
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
    expect(
      backedUp.map(({ id, organizationId, taskId, labelId }) => ({
        id,
        organizationId,
        taskId,
        labelId,
      }))
    ).toEqual(removed);

    await attach(client);
    await owner.query(migration);
    expect(await links()).toEqual([{ id: 'link' }]);
    expect(await backups()).toEqual(expected);
    expect(
      (await owner.query("SELECT current_setting('app.is_platform_admin', true) AS value")).rows[0]
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
        {
          connectionString: url,
          options: `-c search_path=${schema} -c app.current_organization_id=org-a`,
        },
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
    // Labels and tasks themselves survive the move, in every tenant.
    await acrossTenants(client, async () => {
      expect((await client.query('SELECT id FROM labels ORDER BY id')).rows).toHaveLength(4);
      expect((await client.query('SELECT id FROM tasks ORDER BY id')).rows).toHaveLength(2);
    });
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

(url ? describe : describe.skip)('task label board invariant on the migrated tables', () => {
  it('guards attachments and backs up moved labels for the restricted runtime role', async () => {
    const client = new Client({ connectionString: url });
    const id = (name: string) => `${name}_${randomUUID().replaceAll('-', '')}`;
    const [org, user, project, boardA, boardB, columnA, columnB, labelA, labelB, task, link] = [
      'org',
      'user',
      'project',
      'board_a',
      'board_b',
      'column_a',
      'column_b',
      'label_a',
      'label_b',
      'task',
      'link',
    ].map(id);
    const tenant = (organization: string) =>
      client.query("SELECT set_config('app.current_organization_id', $1, true)", [organization]);
    const attach = (label: string, linkId = link) =>
      client.query(
        'INSERT INTO task_labels (id, "organizationId", "taskId", "labelId") VALUES ($1, $2, $3, $4)',
        [linkId, org, task, label]
      );
    await client.connect();
    try {
      const {
        rows: [role],
      } = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO public');
      // Only creating the organization row needs platform scope.
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await client.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
         VALUES ($1, $1, 'Task label test', 'Task label test', now())`,
        [org]
      );
      await client.query("SELECT set_config('app.is_platform_admin', '', true)");
      await tenant(org);
      await client.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'ENGINEERING', 'Engineering', now())`,
        [id('department'), org]
      );
      await client.query(
        `INSERT INTO users (id, "organizationId", name, email, department, title, "updatedAt")
         VALUES ($1, $2, 'Actor', $3, 'ENGINEERING', 'Tester', now())`,
        [user, org, `${user}@example.test`]
      );
      await client.query(
        `INSERT INTO projects (id, "organizationId", name, type, "updatedAt")
         VALUES ($1, $2, 'Project', 'INTERNAL', now())`,
        [project, org]
      );
      for (const [board, column, label] of [
        [boardA, columnA, labelA],
        [boardB, columnB, labelB],
      ]) {
        await client.query(
          `INSERT INTO boards (id, "organizationId", name, "projectId", "updatedAt")
           VALUES ($1, $2, 'Board', $3, now())`,
          [board, org, project]
        );
        await client.query(
          `INSERT INTO columns (id, "organizationId", name, "boardId", "order", "updatedAt")
           VALUES ($1, $2, 'To Do', $3, 0, now())`,
          [column, org, board]
        );
        await client.query(
          `INSERT INTO labels (id, "organizationId", name, color, "boardId")
           VALUES ($1, $2, 'Label', '#000000', $3)`,
          [label, org, board]
        );
      }
      await client.query(
        `INSERT INTO tasks (id, "organizationId", title, "columnId", "order", "createdById", "updatedAt")
         VALUES ($1, $2, 'Task', $3, 0, $4, now())`,
        [task, org, columnA, user]
      );

      await client.query('SAVEPOINT foreign_board');
      await expect(attach(labelB)).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT foreign_board');
      await attach(labelA);
      await client.query('UPDATE tasks SET "columnId" = $1 WHERE id = $2', [columnB, task]);
      expect((await client.query('SELECT id FROM task_labels WHERE id = $1', [link])).rows).toEqual(
        []
      );
      const backup =
        'SELECT "taskBoardId", "labelBoardId" FROM task_label_board_repair_backups WHERE id = $1';
      expect((await client.query(backup, [link])).rows).toEqual([
        { taskBoardId: boardB, labelBoardId: boardA },
      ]);
      // The backup row stays inside its tenant.
      await tenant(id('other_org'));
      expect((await client.query(backup, [link])).rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
