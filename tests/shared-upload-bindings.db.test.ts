// @vitest-environment node
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it } from 'vitest';

const owner = process.env.UPLOAD_REGISTRY_TEST_OWNER_URL;
it.skipIf(!owner)(
  'backfills live references once and keeps the original write-once trigger',
  async () => {
    const url = new URL(owner!);
    expect(['localhost', '127.0.0.1']).toContain(url.hostname);
    expect(url.pathname).toMatch(/_test$/);
    const db = new pg.Client({ connectionString: owner });
    await db.connect();
    try {
      expect(
        (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'))
          .rows
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      // Session-local source records; both registry tables, constraints, policies
      // and the trigger are created by the original migration in this schema.
      await db.query(`
      CREATE TEMP TABLE clients(id text, "organizationId" text, logo text, "createdAt" timestamp default now());
      -- PostgreSQL resolves trigger functions in named schemas, even for
      -- temporary tables. Use the installed write-once trigger function.
      SET search_path TO pg_temp, public;
      CREATE TEMP TABLE project_files(id text,"organizationId" text,url text,"uploadedById" text,"createdAt" timestamp);
      CREATE TEMP TABLE task_attachments (LIKE project_files);
      CREATE TEMP TABLE contracts(id text,"organizationId" text,"fileUrl" text,"createdAt" timestamp);
      CREATE TEMP TABLE messages(id text,"organizationId" text,"deletedAt" timestamp);
      CREATE TEMP TABLE message_attachments(id text,"messageId" text,"organizationId" text,url text,"createdAt" timestamp default now());
      CREATE TEMP TABLE pharmacy_branch_regulatory_profiles(id text,"branchId" text,"organizationId" text,"licenceEvidenceFileRef" text,"qualifiedPersonCoverageRosterRef" text,"createdAt" timestamp default now());
      INSERT INTO clients(id,"organizationId",logo) VALUES ('client','org','/api/files/logo.png');
      INSERT INTO messages VALUES ('message','org',NULL);
      INSERT INTO message_attachments(id,"messageId","organizationId",url) VALUES ('attachment','message','org','/api/files/chat.pdf'),('extra','message','org','/api/files/logo.png');
      INSERT INTO pharmacy_branch_regulatory_profiles(id,"branchId","organizationId","licenceEvidenceFileRef","qualifiedPersonCoverageRosterRef")
        VALUES ('v1','branch','org','/api/files/licence.pdf','/api/files/roster.pdf');
    `);
      const migration = (name: string) =>
        readFile('prisma/migrations/' + name + '/migration.sql', 'utf8');
      await db.query(await migration('20261117090100_uploaded_file_registry'));
      const update = await migration('20261126010200_claim_shared_uploads');
      await db.query(update);
      await db.query("SET app.current_organization_id = 'org'");
      const snapshot = async () =>
        (await db.query('SELECT * FROM uploaded_files ORDER BY name')).rows;
      const first = await snapshot();
      expect(first.map((row) => [row.name, row.ownerType, row.ownerId, row.uploadedById])).toEqual([
        ['chat.pdf', 'CHAT_ATTACHMENT', 'attachment', null],
        ['licence.pdf', 'PHARMACY_LICENCE_EVIDENCE', 'branch', null],
        ['logo.png', 'CLIENT_LOGO', 'client', null],
        ['roster.pdf', 'PHARMACY_COVERAGE_ROSTER', 'branch', null],
      ]);
      const extras = async () =>
        (await db.query('SELECT * FROM uploaded_file_legacy_bindings ORDER BY id')).rows;
      const extra = await extras();
      expect(extra).toEqual([
        expect.objectContaining({
          name: 'logo.png',
          ownerType: 'CHAT_ATTACHMENT',
          ownerId: 'extra',
        }),
      ]);
      await db.query(update);
      expect(await snapshot()).toEqual(first);
      expect(await extras()).toEqual(extra);
      await expect(
        db.query("UPDATE uploaded_files SET \"ownerId\"='second' WHERE name='logo.png'")
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await db.end();
    }
  }
);
