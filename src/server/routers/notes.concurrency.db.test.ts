/**
 * @vitest-environment node
 *
 * Regression coverage for note saves against a real, migrated PostgreSQL database.
 * The test deliberately holds the note row from a separate connection, then queues
 * two router updates behind that lock. This proves the router's FOR NO KEY UPDATE—not a
 * transaction mock—serializes the read/snapshot/write sequence.
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { notify } from '@/lib/notifications';
import { db } from '@/lib/db';
import { createTenantDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { notesRouter } from './notes';

// Only an explicitly configured disposable database may receive test fixtures.
const databaseUrl = process.env.TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
let setup: Client | undefined;
let runtimeRole: string | undefined;

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'text', text }] });

function caller(
  userId: string,
  organizationId: string,
  scoped = createTenantDb(organizationId, userId)
) {
  return notesRouter.createCaller({
    db: scoped,
    session: {
      expires: 'later',
      user: {
        id: userId,
        name: userId,
        role: 'EMPLOYEE',
        department: 'ENGINEERING',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: { id: organizationId },
    entitlements: { organizationId, enabledModules: [], modules: [], limits: {} },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

async function waitForBlockedSaves(monitor: Client, baseline: number, count: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await monitor.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FOR NO KEY UPDATE%'
          AND query LIKE '%notes%'`
    );
    if (result.rows[0]!.count >= baseline + count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} note saves to contend on the PostgreSQL lock`);
}

suite('notes.update PostgreSQL concurrency', () => {
  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    const { rows } = await setup.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    const runtimeUrl = new URL(databaseUrl!);
    if (rows[0]!.rolsuper || rows[0]!.rolbypassrls) {
      // An admin URL may prepare fixtures, but router calls must still exercise RLS.
      runtimeRole = `notes_test_${randomUUID().replaceAll('-', '')}`;
      await setup.query(`CREATE ROLE "${runtimeRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await setup.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
      await setup.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}"`
      );
      await setup.query(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${runtimeRole}"`
      );
      runtimeUrl.searchParams.set(
        'options',
        `${runtimeUrl.searchParams.get('options') ?? ''} -c role=${runtimeRole}`.trim()
      );
    }
    process.env.DATABASE_URL = runtimeUrl.toString();
    await withTenantDb('notes_test_probe', async (tx) => {
      expect(
        await tx.$queryRaw`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    });
  });

  afterAll(async () => {
    await db.$disconnect();
    if (runtimeRole) {
      await setup?.query(`DROP OWNED BY "${runtimeRole}"`);
      await setup?.query(`DROP ROLE "${runtimeRole}"`);
    }
    await setup?.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('preserves both accepted edits across live content and revision history', async () => {
    const sql = new Client({ connectionString: databaseUrl });
    const blocker = new Client({ connectionString: databaseUrl });
    const suffix = randomUUID();
    const organizationId = `notes_concurrency_${suffix}`;
    const departmentId = `department_${suffix}`;
    const authorId = `author_${suffix}`;
    const editorBId = `editor_b_${suffix}`;
    const editorCId = `editor_c_${suffix}`;
    const noteId = `note_${suffix}`;
    const saves: Promise<unknown>[] = [];

    await Promise.all([sql.connect(), blocker.connect()]);
    try {
      await sql.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
      await blocker.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
      await sql.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
         VALUES ($1, $1, 'Notes concurrency test', 'Notes concurrency test', now())`,
        [organizationId]
      );
      await sql.query(
        `INSERT INTO organization_departments
           (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'ENGINEERING', 'Engineering', now())`,
        [departmentId, organizationId]
      );
      for (const [id, name] of [
        [authorId, 'Author'],
        [editorBId, 'Editor B'],
        [editorCId, 'Editor C'],
      ]) {
        await sql.query(
          `INSERT INTO users
             (id, "organizationId", name, email, department, title, "updatedAt")
           VALUES ($1, $2, $3, $4, 'ENGINEERING', 'Test editor', now())`,
          [id, organizationId, name, `${id}@example.test`]
        );
      }
      await sql.query(
        `INSERT INTO notes
           (id, "organizationId", title, "contentJson", "contentText", "authorId", visibility, "updatedAt")
         VALUES ($1, $2, 'Shared plan', $3::jsonb, 'A', $4, 'TEAM', now())`,
        [noteId, organizationId, JSON.stringify(doc('A')), authorId]
      );

      const baseline = Number(
        (
          await sql.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE '%FOR NO KEY UPDATE%' AND query LIKE '%notes%'`
          )
        ).rows[0]!.count
      );
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM notes WHERE id = $1 FOR UPDATE', [noteId]);

      const saveB = caller(editorBId, organizationId).update({
        id: noteId,
        contentJson: doc('B'),
      });
      saves.push(saveB);
      await waitForBlockedSaves(sql, baseline, 1);
      const saveC = caller(editorCId, organizationId).update({
        id: noteId,
        contentJson: doc('C'),
      });
      saves.push(saveC);
      await waitForBlockedSaves(sql, baseline, 2);
      await blocker.query('COMMIT');
      await Promise.all([saveB, saveC]);

      const note = await sql.query<{ contentText: string }>(
        `SELECT "contentText" FROM notes WHERE id = $1`,
        [noteId]
      );
      const revisions = await sql.query<{
        contentText: string;
        editedById: string;
        organizationId: string;
      }>(
        `SELECT "contentText", "editedById", "organizationId" FROM note_revisions
          WHERE "noteId" = $1 ORDER BY "createdAt", id`,
        [noteId]
      );
      expect(note.rows).toEqual([{ contentText: 'C' }]);
      expect(revisions.rows).toEqual([
        { contentText: 'A', editedById: editorBId, organizationId },
        { contentText: 'B', editedById: editorCId, organizationId },
      ]);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await Promise.allSettled(saves);
      await sql.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
      await Promise.all([sql.end(), blocker.end()]);
    }
  }, 15_000);

  it('saves mutually linked notes concurrently without a foreign-key lock deadlock', async () => {
    const sql = new Client({ connectionString: databaseUrl });
    const suffix = randomUUID();
    const organizationId = `notes_links_${suffix}`;
    const authorId = `author_${suffix}`;
    const noteA = `note_a_${suffix}`;
    const noteB = `note_b_${suffix}`;
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let barrierTimedOut = false;
    const timer = setTimeout(() => {
      barrierTimedOut = true;
      release();
    }, 5_000);
    const saves: Promise<unknown>[] = [];

    await sql.connect();
    try {
      await sql.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
      await sql.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
         VALUES ($1, $1, 'Linked notes test', 'Linked notes test', now())`,
        [organizationId]
      );
      await sql.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1, $2, 'ENGINEERING', 'Engineering', now())`,
        [`department_${suffix}`, organizationId]
      );
      await sql.query(
        `INSERT INTO users (id, "organizationId", name, email, department, title, "updatedAt")
         VALUES ($1, $2, 'Author', $3, 'ENGINEERING', 'Test editor', now())`,
        [authorId, organizationId, `${authorId}@example.test`]
      );
      for (const id of [noteA, noteB]) {
        await sql.query(
          `INSERT INTO notes
             (id, "organizationId", title, "contentJson", "contentText", "authorId", visibility, "updatedAt")
           VALUES ($1, $2, 'Linked plan', $3::jsonb, 'original', $4, 'TEAM', now())`,
          [id, organizationId, JSON.stringify(doc('original')), authorId]
        );
      }

      const save = (id: string, targetId: string) =>
        withTenantDb(
          organizationId,
          async (tx) => {
            // Pause after each router lock actually succeeds, so both note rows
            // are locked before either save inserts its link to the other row.
            const synchronized: ScopedDb = new Proxy(tx, {
              get(target, key, receiver) {
                if (key === '$transaction') {
                  return (run: (inner: ScopedDb) => Promise<unknown>) => run(synchronized);
                }
                if (key === '$queryRaw') {
                  return async (...args: Parameters<ScopedDb['$queryRaw']>) => {
                    const rows = await target.$queryRaw(...args);
                    if (++arrived === 2) release();
                    await barrier;
                    return rows;
                  };
                }
                const value = Reflect.get(target, key, receiver) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
            return caller(authorId, organizationId, synchronized).update({
              id,
              contentJson: {
                type: 'doc',
                content: [
                  { type: 'text', text: 'linked edit' },
                  { type: 'noteLink', attrs: { id: targetId } },
                ],
              },
            });
          },
          { userId: authorId, timeout: 10_000 }
        );
      saves.push(save(noteA, noteB), save(noteB, noteA));
      const results = await Promise.allSettled(saves);
      expect(barrierTimedOut).toBe(false);
      expect(arrived).toBe(2);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const notes = await sql.query<{ contentText: string }>(
        `SELECT "contentText" FROM notes WHERE id = ANY($1)`,
        [[noteA, noteB]]
      );
      expect(notes.rows).toEqual([{ contentText: 'linked edit' }, { contentText: 'linked edit' }]);
      const links = await sql.query<{ fromNoteId: string; toNoteId: string }>(
        `SELECT "fromNoteId", "toNoteId" FROM note_links
         WHERE "organizationId" = $1 ORDER BY "fromNoteId"`,
        [organizationId]
      );
      expect(links.rows).toEqual([
        { fromNoteId: noteA, toNoteId: noteB },
        { fromNoteId: noteB, toNoteId: noteA },
      ]);
      const revisions = await sql.query<{ noteId: string; contentText: string }>(
        `SELECT "noteId", "contentText" FROM note_revisions
         WHERE "organizationId" = $1 ORDER BY "noteId"`,
        [organizationId]
      );
      expect(revisions.rows).toEqual([
        { noteId: noteA, contentText: 'original' },
        { noteId: noteB, contentText: 'original' },
      ]);
    } finally {
      clearTimeout(timer);
      release();
      await Promise.allSettled(saves);
      await sql.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
      await sql.end();
    }
  }, 15_000);

  it('rejects a foreign-tenant note before reading or mutating related data', async () => {
    vi.mocked(notify).mockClear();
    const sql = new Client({ connectionString: databaseUrl });
    const suffix = randomUUID();
    const attackerOrgId = `notes_attacker_${suffix}`;
    const victimOrgId = `notes_victim_${suffix}`;
    const attackerDepartmentId = `attacker_department_${suffix}`;
    const victimDepartmentId = `victim_department_${suffix}`;
    const attackerId = `attacker_${suffix}`;
    const victimId = `victim_${suffix}`;
    const victimNoteId = `victim_note_${suffix}`;
    const victimLinkedNoteId = `victim_linked_note_${suffix}`;

    await sql.connect();
    try {
      await sql.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
      for (const [organizationId, departmentId, label] of [
        [attackerOrgId, attackerDepartmentId, 'Attacker'],
        [victimOrgId, victimDepartmentId, 'Victim'],
      ]) {
        await sql.query(
          `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
           VALUES ($1, $1, $2, $2, now())`,
          [organizationId, label]
        );
        await sql.query(
          `INSERT INTO organization_departments
             (id, "organizationId", key, name, "updatedAt")
           VALUES ($1, $2, 'ENGINEERING', 'Engineering', now())`,
          [departmentId, organizationId]
        );
      }
      for (const [id, organizationId, name] of [
        [attackerId, attackerOrgId, 'Attacker'],
        [victimId, victimOrgId, 'Victim'],
      ]) {
        await sql.query(
          `INSERT INTO users
             (id, "organizationId", name, email, department, title, "updatedAt")
           VALUES ($1, $2, $3, $4, 'ENGINEERING', 'Test editor', now())`,
          [id, organizationId, name, `${id}@example.test`]
        );
      }
      for (const [id, title] of [
        [victimNoteId, 'Victim note'],
        [victimLinkedNoteId, 'Victim linked note'],
      ]) {
        await sql.query(
          `INSERT INTO notes
             (id, "organizationId", title, "contentJson", "contentText", "authorId", visibility, "updatedAt")
           VALUES ($1, $2, $3, $4::jsonb, 'original', $5, 'TEAM', now())`,
          [id, victimOrgId, title, JSON.stringify(doc('original')), victimId]
        );
      }

      await expect(
        caller(attackerId, attackerOrgId).update({
          id: victimNoteId,
          title: 'compromised',
          contentJson: doc(`@Victim [[${victimLinkedNoteId}]]`),
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const note = await sql.query<{ title: string; contentText: string }>(
        `SELECT title, "contentText" FROM notes WHERE id = $1`,
        [victimNoteId]
      );
      const links = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM note_links WHERE "fromNoteId" = $1`,
        [victimNoteId]
      );
      const mentions = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM note_mentions WHERE "noteId" = $1`,
        [victimNoteId]
      );
      const revisions = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM note_revisions WHERE "noteId" = $1`,
        [victimNoteId]
      );
      expect(note.rows).toEqual([{ title: 'Victim note', contentText: 'original' }]);
      expect(links.rows[0]!.count).toBe(0);
      expect(mentions.rows[0]!.count).toBe(0);
      expect(revisions.rows[0]!.count).toBe(0);
      expect(vi.mocked(notify)).not.toHaveBeenCalled();
    } finally {
      await sql.query('DELETE FROM organizations WHERE id = ANY($1)', [
        [attackerOrgId, victimOrgId],
      ]);
      await sql.end();
    }
  });
});
