// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261026120000_enforce_task_assignee_membership/migration.sql',
  'utf8'
);

const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase('task-assignee project membership database invariant', () => {
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
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES projects);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL REFERENCES boards);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL REFERENCES columns);
        CREATE TABLE project_members (
          id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES projects, "userId" text NOT NULL
        );
        CREATE TABLE task_assignees (
          id text PRIMARY KEY, "taskId" text NOT NULL REFERENCES tasks, "userId" text NOT NULL
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
        CREATE TABLE projects (id text PRIMARY KEY);
        CREATE TABLE boards (id text PRIMARY KEY, "projectId" text NOT NULL REFERENCES projects);
        CREATE TABLE columns (id text PRIMARY KEY, "boardId" text NOT NULL REFERENCES boards);
        CREATE TABLE tasks (id text PRIMARY KEY, "columnId" text NOT NULL REFERENCES columns);
        CREATE TABLE project_members (id text PRIMARY KEY, "projectId" text NOT NULL, "userId" text NOT NULL);
        CREATE TABLE task_assignees (id text PRIMARY KEY, "taskId" text NOT NULL, "userId" text NOT NULL);
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
});
