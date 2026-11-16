// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.TEST_DATABASE_URL;
const client = new Client({ connectionString: url });
const schema = `catalogue_${randomUUID().replaceAll('-', '')}`;
const sql = readFileSync(
  'prisma/migrations/20261117090600_pharmacy_catalogue_approval/migration.sql',
  'utf8'
);

(url ? describe : describe.skip)(
  'DEV-766 catalogue queue migration with restricted runtime',
  () => {
    beforeAll(async () => {
      assertDisposableRlsDatabase(url!);
      await client.connect();
      expect(
        (
          await client.query(
            'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
          )
        ).rows
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      // Minimal existing parent shapes isolate this additive migration from unrelated migrations.
      await client.query(`CREATE TABLE users (id text PRIMARY KEY, "organizationId" text NOT NULL, UNIQUE ("organizationId", id));
      CREATE TABLE pharmacy_medicines (id text PRIMARY KEY, "organizationId" text NOT NULL, UNIQUE ("organizationId", id));
      CREATE TABLE pharmacy_medicine_provenance (id text PRIMARY KEY);
      INSERT INTO users VALUES ('editor-a','org-a'), ('reviewer-a','org-a'), ('editor-b','org-b');
      INSERT INTO pharmacy_medicines VALUES ('med-a','org-a'), ('med-b','org-b');`);
      await client.query(sql);
      await client.query(sql); // Rerun must preserve rows and constraints.
      await client.query("SELECT set_config('app.current_organization_id', 'org-a', false)");
      await client.query(
        `INSERT INTO pharmacy_catalogue_edits (id,"medicineId","editorId",changes,"baseUpdatedAt") VALUES ('edit-a','med-a','editor-a','{"productName":"New soap"}',now())`
      );
    });
    afterAll(async () => {
      await client.end();
    });

    it('forces RLS even for the non-superuser table owner and hides other tenants', async () => {
      expect(
        (
          await client.query(
            `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'pharmacy_catalogue_edits'::regclass`
          )
        ).rows
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      await client.query("SELECT set_config('app.current_organization_id', 'org-b', false)");
      expect((await client.query('SELECT * FROM pharmacy_catalogue_edits')).rows).toEqual([]);
      await expect(
        client.query(
          `INSERT INTO pharmacy_catalogue_edits (id,"organizationId","medicineId","editorId",changes,"baseUpdatedAt") VALUES ('bad-org','org-a','med-a','editor-a','{"rx":true}',now())`
        )
      ).rejects.toMatchObject({ code: '42501' });
      await client.query("SELECT set_config('app.current_organization_id', 'org-a', false)");
    });

    it('rejects cross-tenant medicine and editor references', async () => {
      for (const [id, medicine, editor] of [
        ['cross-med', 'med-b', 'editor-a'],
        ['cross-editor', 'med-a', 'editor-b'],
      ]) {
        await expect(
          client.query(
            `INSERT INTO pharmacy_catalogue_edits (id,"medicineId","editorId",changes,"baseUpdatedAt") VALUES ($1,$2,$3,'{"rx":true}',now())`,
            [id, medicine, editor]
          )
        ).rejects.toMatchObject({ code: '23503' });
      }
    });

    it('preserves proposal authorship/payload and refuses self-approval without PIN evidence', async () => {
      await expect(
        client.query(`UPDATE pharmacy_catalogue_edits SET changes='{"rx":false}' WHERE id='edit-a'`)
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `UPDATE pharmacy_catalogue_edits SET "editorId"='reviewer-a' WHERE id='edit-a'`
        )
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `UPDATE pharmacy_catalogue_edits SET status='APPROVED',"reviewerId"='editor-a',"reviewedAt"=now() WHERE id='edit-a'`
        )
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        (await client.query(`SELECT status FROM pharmacy_catalogue_edits WHERE id='edit-a'`)).rows
      ).toEqual([{ status: 'PENDING' }]);
    });

    it('allows a different reviewer once and retains immutable history', async () => {
      expect(
        (
          await client.query(
            `UPDATE pharmacy_catalogue_edits SET status='APPROVED',"reviewerId"='reviewer-a',"reviewedAt"=now() WHERE id='edit-a' AND status='PENDING'`
          )
        ).rowCount
      ).toBe(1);
      expect(
        (
          await client.query(
            `UPDATE pharmacy_catalogue_edits SET status='REJECTED',"reviewerId"='reviewer-a',"reviewedAt"=now() WHERE id='edit-a' AND status='PENDING'`
          )
        ).rowCount
      ).toBe(0);
      await expect(
        client.query(
          `UPDATE pharmacy_catalogue_edits SET status='PENDING',"reviewerId"=null,"reviewedAt"=null WHERE id='edit-a'`
        )
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('retains proposals when the migration is reapplied', async () => {
      await client.query(sql);
      expect(
        (
          await client.query(
            `SELECT status, "editorId", "reviewerId" FROM pharmacy_catalogue_edits WHERE id='edit-a'`
          )
        ).rows
      ).toEqual([{ status: 'APPROVED', editorId: 'editor-a', reviewerId: 'reviewer-a' }]);
    });
  }
);
