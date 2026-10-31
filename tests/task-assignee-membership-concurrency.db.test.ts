// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261026120000_enforce_task_assignee_membership/migration.sql',
  'utf8'
);

// Minimal projection of the existing audit table used by the cleanup SQL.
const auditTable = `CREATE TABLE audit_logs (
  id text PRIMARY KEY, "organizationId" text NOT NULL, "actorType" text,
  source text, category text, operation text, action text,
  "targetType" text, "targetId" text, metadata jsonb
);`;

const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase('task-assignee project membership database invariant', () => {
  it('does not let a pre-trigger writer escape the migration cleanup', async () => {
    const schema = `task_membership_${randomUUID().replaceAll('-', '')}`;
    const setup = new pg.Client({ connectionString: databaseUrl });
    const writer = new pg.Client({ connectionString: databaseUrl });
    const migrator = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), writer.connect(), migrator.connect()]);

    try {
      await setup.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      await setup.query(`
        ${auditTable}
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL);
        CREATE TABLE project_members (id text PRIMARY KEY, "projectId" text NOT NULL, "userId" text NOT NULL);
        CREATE TABLE task_assignees (id text PRIMARY KEY, "taskId" text NOT NULL, "userId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        INSERT INTO projects VALUES ('project');
        INSERT INTO boards VALUES ('board', 'project');
        INSERT INTO columns VALUES ('column', 'board');
        INSERT INTO tasks VALUES ('task', 'column');
      `);
      await Promise.all([
        writer.query(`SET search_path TO "${schema}"`),
        migrator.query(`SET search_path TO "${schema}"`),
      ]);

      // This transaction represents a writer which began before trigger
      // installation. The migration must wait for it before taking its cleanup
      // snapshot, rather than allowing its invalid row to commit in a gap.
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO task_assignees VALUES ('invalid', 'task', 'outsider')`);
      const deployment = migrator.query(migration);
      const beforeCommit = await Promise.race([
        deployment.then(() => 'migrated'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(beforeCommit).toBe('blocked');

      await writer.query('COMMIT');
      await expect(deployment).resolves.toBeDefined();
      expect((await setup.query(`SELECT * FROM task_assignees`)).rows).toEqual([]);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await migrator.query('ROLLBACK').catch(() => undefined);
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await Promise.all([setup.end(), writer.end(), migrator.end()]);
    }
  });

  it('removes pre-existing invalid assignments when the migration is applied', async () => {
    const schema = `task_membership_${randomUUID().replaceAll('-', '')}`;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      await client.query(`
        ${auditTable}
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL);
        CREATE TABLE project_members (id text PRIMARY KEY, "projectId" text NOT NULL, "userId" text NOT NULL);
        CREATE TABLE task_assignees (id text PRIMARY KEY, "taskId" text NOT NULL, "userId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        INSERT INTO projects VALUES ('project');
        INSERT INTO boards VALUES ('board', 'project');
        INSERT INTO columns VALUES ('column', 'board');
        INSERT INTO tasks VALUES ('task', 'column');
        INSERT INTO task_assignees VALUES ('invalid', 'task', 'outsider');
        ${migration}
      `);
      const remaining = await client.query(`SELECT * FROM task_assignees`);
      expect(remaining.rows).toEqual([]);
      const audit = await client.query(`SELECT "organizationId", action, "targetId", metadata FROM audit_logs`);
      expect(audit.rows).toEqual([expect.objectContaining({
        organizationId: 'organization',
        action: 'task.assignee_membership_cleanup',
        targetId: 'task',
        metadata: expect.objectContaining({ userId: 'outsider', reason: 'migration_cleanup' }),
      })]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });

  it('cleans assignments when a membership identity or project changes', async () => {
    const schema = `task_membership_${randomUUID().replaceAll('-', '')}`;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      await client.query(`
        ${auditTable}
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL);
        CREATE TABLE project_members (id text PRIMARY KEY, "projectId" text NOT NULL, "userId" text NOT NULL);
        CREATE TABLE task_assignees (id text PRIMARY KEY, "taskId" text NOT NULL, "userId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        ${migration}
        INSERT INTO projects VALUES ('project'), ('other-project');
        INSERT INTO boards VALUES ('board', 'project');
        INSERT INTO columns VALUES ('column', 'board');
        INSERT INTO tasks VALUES ('task', 'column');
        INSERT INTO project_members VALUES ('membership', 'project', 'user');
        INSERT INTO task_assignees VALUES ('assignment', 'task', 'user');
        UPDATE project_members SET "projectId" = 'other-project' WHERE id = 'membership';
      `);
      const remaining = await client.query(`SELECT * FROM task_assignees`);
      expect(remaining.rows).toEqual([]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });

  it('keeps assignments when a membership update does not change its identity', async () => {
    const schema = `task_membership_${randomUUID().replaceAll('-', '')}`;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      await client.query(`
        ${auditTable}
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL);
        CREATE TABLE project_members (id text PRIMARY KEY, "projectId" text NOT NULL, "userId" text NOT NULL);
        CREATE TABLE task_assignees (id text PRIMARY KEY, "taskId" text NOT NULL, "userId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        ${migration}
        INSERT INTO projects VALUES ('project');
        INSERT INTO boards VALUES ('board', 'project');
        INSERT INTO columns VALUES ('column', 'board');
        INSERT INTO tasks VALUES ('task', 'column');
        INSERT INTO project_members VALUES ('membership', 'project', 'user');
        INSERT INTO task_assignees VALUES ('assignment', 'task', 'user');
        UPDATE project_members
           SET "projectId" = "projectId", "userId" = "userId"
         WHERE id = 'membership';
      `);
      const remaining = await client.query(`SELECT id FROM task_assignees`);
      expect(remaining.rows).toEqual([{ id: 'assignment' }]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });

  it('serializes assignment against concurrent membership removal', async () => {
    const schema = `task_membership_${randomUUID().replaceAll('-', '')}`;
    const setup = new pg.Client({ connectionString: databaseUrl });
    const assigner = new pg.Client({ connectionString: databaseUrl });
    const remover = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), assigner.connect(), remover.connect()]);

    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`SET search_path TO "${schema}"`);
      await setup.query(`
        ${auditTable}
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES projects);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL REFERENCES boards);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL REFERENCES columns);
        CREATE TABLE project_members (
          id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES projects, "userId" text NOT NULL
        );
        CREATE TABLE task_assignees (
          id text PRIMARY KEY, "taskId" text NOT NULL REFERENCES tasks, "userId" text NOT NULL,
          "organizationId" text NOT NULL DEFAULT 'organization'
        );
        ${migration}
        INSERT INTO projects VALUES ('project');
        INSERT INTO boards VALUES ('board', 'project');
        INSERT INTO columns VALUES ('column', 'board');
        INSERT INTO tasks VALUES ('task', 'column');
        INSERT INTO project_members VALUES ('membership', 'project', 'user');
      `);
      await Promise.all([
        assigner.query(`SET search_path TO "${schema}"`),
        remover.query(`SET search_path TO "${schema}"`),
      ]);

      await assigner.query('BEGIN');
      await assigner.query(`INSERT INTO task_assignees VALUES ('assignment', 'task', 'user')`);
      const removal = remover.query(
        `DELETE FROM project_members WHERE id = 'membership' RETURNING id`
      );

      // The membership row lock taken by the assignment trigger makes removal
      // wait until the assigning transaction has a final outcome.
      const beforeCommit = await Promise.race([
        removal.then(() => 'removed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(beforeCommit).toBe('blocked');

      await assigner.query('COMMIT');
      await expect(removal).resolves.toMatchObject({ rowCount: 1 });
      const remaining = await setup.query(`SELECT * FROM task_assignees`);
      expect(remaining.rows).toEqual([]);
    } finally {
      await assigner.query('ROLLBACK').catch(() => undefined);
      await remover.query('ROLLBACK').catch(() => undefined);
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await Promise.all([setup.end(), assigner.end(), remover.end()]);
    }
  });

  it('rejects assignment when concurrent membership removal wins', async () => {
    const schema = `task_membership_${randomUUID().replaceAll('-', '')}`;
    const setup = new pg.Client({ connectionString: databaseUrl });
    const assigner = new pg.Client({ connectionString: databaseUrl });
    const remover = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), assigner.connect(), remover.connect()]);

    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`SET search_path TO "${schema}"`);
      await setup.query(`
        ${auditTable}
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES projects);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL REFERENCES boards);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL REFERENCES columns);
        CREATE TABLE project_members (id text PRIMARY KEY, "projectId" text NOT NULL, "userId" text NOT NULL);
        CREATE TABLE task_assignees (id text PRIMARY KEY, "taskId" text NOT NULL, "userId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        ${migration}
        INSERT INTO projects VALUES ('project');
        INSERT INTO boards VALUES ('board', 'project');
        INSERT INTO columns VALUES ('column', 'board');
        INSERT INTO tasks VALUES ('task', 'column');
        INSERT INTO project_members VALUES ('membership', 'project', 'user');
      `);
      await Promise.all([
        assigner.query(`SET search_path TO "${schema}"`),
        remover.query(`SET search_path TO "${schema}"`),
      ]);

      await remover.query('BEGIN');
      await remover.query(`DELETE FROM project_members WHERE id = 'membership'`);
      const assignment = assigner.query(
        `INSERT INTO task_assignees VALUES ('assignment', 'task', 'user')`
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await remover.query('COMMIT');
      await expect(assignment).rejects.toMatchObject({ code: '23514' });
    } finally {
      await assigner.query('ROLLBACK').catch(() => undefined);
      await remover.query('ROLLBACK').catch(() => undefined);
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await Promise.all([setup.end(), assigner.end(), remover.end()]);
    }
  });

  it('cleans an assignment when it wins the race against a task move', async () => {
    const schema = `task_membership_${randomUUID().replaceAll('-', '')}`;
    const setup = new pg.Client({ connectionString: databaseUrl });
    const assigner = new pg.Client({ connectionString: databaseUrl });
    const mover = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), assigner.connect(), mover.connect()]);
    try {
      await setup.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      await setup.query(`
        ${auditTable}
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL);
        CREATE TABLE project_members (id text PRIMARY KEY, "projectId" text NOT NULL, "userId" text NOT NULL);
        CREATE TABLE task_assignees (id text PRIMARY KEY, "taskId" text NOT NULL, "userId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        ${migration}
        INSERT INTO projects VALUES ('source'), ('destination');
        INSERT INTO boards VALUES ('source-board', 'source'), ('destination-board', 'destination');
        INSERT INTO columns VALUES ('source-column', 'source-board'), ('destination-column', 'destination-board');
        INSERT INTO tasks VALUES ('task', 'source-column');
        INSERT INTO project_members VALUES ('membership', 'source', 'user');
      `);
      await Promise.all([
        assigner.query(`SET search_path TO "${schema}"`),
        mover.query(`SET search_path TO "${schema}"`),
      ]);
      await assigner.query('BEGIN');
      await assigner.query(`INSERT INTO task_assignees VALUES ('assignment', 'task', 'user')`);
      const move = mover.query(
        `UPDATE tasks SET "columnId" = 'destination-column' WHERE id = 'task' RETURNING id`
      );
      const beforeCommit = await Promise.race([
        move.then(() => 'moved'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(beforeCommit).toBe('blocked');
      await assigner.query('COMMIT');
      await expect(move).resolves.toMatchObject({ rowCount: 1 });
      expect((await setup.query(`SELECT * FROM task_assignees`)).rows).toEqual([]);
    } finally {
      await assigner.query('ROLLBACK').catch(() => undefined);
      await mover.query('ROLLBACK').catch(() => undefined);
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await Promise.all([setup.end(), assigner.end(), mover.end()]);
    }
  });

  it('rejects an assignment when a concurrent task move wins', async () => {
    const schema = `task_membership_${randomUUID().replaceAll('-', '')}`;
    const setup = new pg.Client({ connectionString: databaseUrl });
    const assigner = new pg.Client({ connectionString: databaseUrl });
    const mover = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), assigner.connect(), mover.connect()]);
    try {
      await setup.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
      await setup.query(`
        ${auditTable}
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL);
        CREATE TABLE project_members (id text PRIMARY KEY, "projectId" text NOT NULL, "userId" text NOT NULL);
        CREATE TABLE task_assignees (id text PRIMARY KEY, "taskId" text NOT NULL, "userId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        ${migration}
        INSERT INTO projects VALUES ('source'), ('destination');
        INSERT INTO boards VALUES ('source-board', 'source'), ('destination-board', 'destination');
        INSERT INTO columns VALUES ('source-column', 'source-board'), ('destination-column', 'destination-board');
        INSERT INTO tasks VALUES ('task', 'source-column');
        INSERT INTO project_members VALUES ('membership', 'source', 'user');
      `);
      await Promise.all([
        assigner.query(`SET search_path TO "${schema}"`),
        mover.query(`SET search_path TO "${schema}"`),
      ]);
      await mover.query('BEGIN');
      await mover.query(`UPDATE tasks SET "columnId" = 'destination-column' WHERE id = 'task'`);
      const assignment = assigner.query(
        `INSERT INTO task_assignees VALUES ('assignment', 'task', 'user')`
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await mover.query('COMMIT');
      await expect(assignment).rejects.toMatchObject({ code: '23514' });
    } finally {
      await assigner.query('ROLLBACK').catch(() => undefined);
      await mover.query('ROLLBACK').catch(() => undefined);
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await Promise.all([setup.end(), assigner.end(), mover.end()]);
    }
  });
  it('removes invalid assignments under FORCE ROW LEVEL SECURITY as a non-bypass role', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `task_membership_${suffix}`;
    const role = `task_membership_role_${suffix}`;
    const policy = `USING (current_setting('app.is_platform_admin', true) = 'true'
        OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
      WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
        OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))`;
    const rlsTables = ['audit_logs', 'project_members', 'tasks', 'task_assignees'];
    const admin = new pg.Client({ connectionString: databaseUrl });
    const migrator = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([admin.connect(), migrator.connect()]);
    try {
      // Mirror production: the migration role owns the tables, is not a
      // superuser and has no BYPASSRLS, so FORCE RLS applies to it.
      await admin.query(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS NOLOGIN`);
      await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${role}"`);
      await admin.query(`SET ROLE "${role}"; SET search_path TO "${schema}"`);
      await admin.query(`
        ${auditTable}
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        CREATE TABLE project_members (id text PRIMARY KEY, "projectId" text NOT NULL, "userId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        CREATE TABLE task_assignees (id text PRIMARY KEY, "taskId" text NOT NULL, "userId" text NOT NULL, "organizationId" text NOT NULL DEFAULT 'organization');
        INSERT INTO projects VALUES ('project');
        INSERT INTO boards VALUES ('board', 'project');
        INSERT INTO columns VALUES ('column', 'board');
        INSERT INTO tasks VALUES ('task', 'column');
        INSERT INTO project_members VALUES ('membership', 'project', 'member');
        INSERT INTO task_assignees VALUES ('valid', 'task', 'member');
        INSERT INTO task_assignees VALUES ('invalid', 'task', 'outsider');
        ${rlsTables
          .map(
            (table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON ${table} ${policy};`
          )
          .join('\n')}
      `);

      // A fresh session with no tenant or platform-admin context, as the
      // deployment job runs.
      await migrator.query(`SET ROLE "${role}"; SET search_path TO "${schema}"`);
      await migrator.query(migration);

      await admin.query('BEGIN');
      await admin.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      const remaining = await admin.query(`SELECT id FROM task_assignees ORDER BY id`);
      const audit = await admin.query(`SELECT "organizationId", action, "targetId", metadata FROM audit_logs`);
      await admin.query('COMMIT');
      expect(remaining.rows).toEqual([{ id: 'valid' }]);
      expect(audit.rows).toEqual([expect.objectContaining({
        organizationId: 'organization',
        action: 'task.assignee_membership_cleanup',
        targetId: 'task',
        metadata: expect.objectContaining({ userId: 'outsider', assignmentId: 'invalid', reason: 'migration_cleanup' }),
      })]);
      // The platform-admin flag is transaction-local and must not leak.
      const leaked = await migrator.query(`SELECT current_setting('app.is_platform_admin', true) AS flag`);
      expect(leaked.rows[0].flag ?? '').not.toBe('true');
    } finally {
      await admin.query('ROLLBACK').catch(() => undefined);
      await admin.query('RESET ROLE').catch(() => undefined);
      await migrator.query('RESET ROLE').catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
      await Promise.all([admin.end(), migrator.end()]);
    }
  });
});
