// @vitest-environment node
// Opt in: RUN_INVITE_POSTGRES=1 npx vitest run src/lib/ai/tools/people.invite.postgres.test.ts
// Uses the local pg container only to provision/clean a disposable database and role.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import type { AssistantHelpers } from '@/lib/ai/context';
import { hashInviteToken } from '@/lib/invite-token';

vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://www.devfathom.com',
  sendEmail: vi.fn(),
  templates: {
    inviteMember: vi.fn(() => ({ subject: 'Invite', html: 'email html', text: 'email text' })),
  },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
import { sendEmail, templates } from '@/lib/email';
import { buildPeopleTools } from './people';

const enabled = process.env.RUN_INVITE_POSTGRES === '1';
describe.skipIf(!enabled)('actual people tool with isolated local Postgres', () => {
  const database = `invite_regression_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(32).toString('hex');
  const schema = 'invite_regression';
  let pool: pg.Pool;
  let db: PrismaClient;
  let roleCreated = false;
  let databaseCreated = false;
  function admin(sql: string) {
    // Neither the command arguments nor output contain credentials. No secret files are read.
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        'pg',
        'sh',
        '-c',
        'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}"',
      ],
      { input: sql, stdio: ['pipe', 'ignore', 'ignore'] }
    );
  }
  beforeAll(async () => {
    admin(`CREATE ROLE "${database}" LOGIN PASSWORD '${password}';`);
    roleCreated = true;
    admin(`CREATE DATABASE "${database}" OWNER "${database}";`);
    databaseCreated = true;
    pool = new pg.Pool({
      host: 'localhost',
      port: 5432,
      user: database,
      password,
      database,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 5000,
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    // Minimal tables mirror the scalar fields of the three Prisma models used here.
    // External domain relations are intentionally omitted from this disposable fixture.
    await pool.query(`
CREATE TYPE "Role" AS ENUM ('ADMIN','EMPLOYEE','HR');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE','INACTIVE','ON_LEAVE','INVITED');
CREATE TABLE "users" (
"id" text NOT NULL PRIMARY KEY,
"organizationId" text NOT NULL DEFAULT 'test-org',
"organizationRoleId" text,
"name" text NOT NULL,
"email" text NOT NULL,
"password" text,
"role" "Role" NOT NULL DEFAULT 'EMPLOYEE',
"department" text NOT NULL,
"title" text NOT NULL,
"avatar" text,
"phone" text,
"bio" text,
"skills" text[] NOT NULL DEFAULT '{}',
"startDate" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
"lastActiveAt" timestamp(3),
"tokenVersion" integer NOT NULL DEFAULT 0,
"passwordChangedAt" timestamp(3),
"mustChangePassword" boolean NOT NULL DEFAULT false,
"preferences" jsonb,
"notificationPrefs" jsonb,
"twoFactorSecret" text,
"twoFactorEnabledAt" timestamp(3),
"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" timestamp(3) NOT NULL
);
CREATE TABLE "invitations" (
"id" text NOT NULL PRIMARY KEY,
"organizationId" text NOT NULL DEFAULT 'test-org',
"userId" text NOT NULL UNIQUE,
"email" text NOT NULL,
"tokenHash" text NOT NULL UNIQUE,
"invitedById" text,
"expiresAt" timestamp(3) NOT NULL,
"acceptedAt" timestamp(3),
"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" timestamp(3) NOT NULL
);
CREATE TABLE "organization_departments" (
"id" text NOT NULL PRIMARY KEY,
"organizationId" text NOT NULL DEFAULT 'test-org',
"key" text NOT NULL,
"name" text NOT NULL,
"active" boolean NOT NULL DEFAULT true,
"sortOrder" integer NOT NULL DEFAULT 0,
"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" timestamp(3) NOT NULL
);
    `);
    db = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), log: [] });
    await db.organizationDepartment.create({ data: { key: 'ENGINEERING', name: 'Engineering' } });
  }, 30000);
  afterAll(async () => {
    try {
      if (db) await db.$disconnect();
    } finally {
      try {
        if (pool) await pool.end();
      } finally {
        if (databaseCreated) admin(`DROP DATABASE "${database}" WITH (FORCE);`);
        if (roleCreated) admin(`DROP ROLE "${database}";`);
      }
    }
  });

  it.each([false, true])(
    'create and reinvite preserve emailFailure=%s without disclosing credentials',
    async (emailFailure) => {
      const email = `member-${emailFailure}@example.com`;
      let previousHash: string | undefined;
      let previousId: string | undefined;
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        for (const reInvite of [false, true]) {
          vi.mocked(sendEmail).mockReset();
          vi.mocked(templates.inviteMember).mockClear();
          if (emailFailure)
            vi.mocked(sendEmail).mockRejectedValueOnce(new Error('delivery unavailable'));
          const audit = vi.fn();
          const helpers = {
            db,
            isAdmin: true,
            isAdminOrHr: true,
            ctx: { userId: 'admin', name: 'Admin' },
            audit,
          } as unknown as AssistantHelpers;
          const tool = buildPeopleTools(helpers).inviteMember as unknown as {
            execute: (input: Record<string, unknown>) => Promise<unknown>;
          };
          const result = await tool.execute({
            name: 'Alex Carter',
            email,
            department: 'ENGINEERING',
            title: 'Engineer',
            role: 'EMPLOYEE',
          });
          expect(result).toStrictEqual({
            name: 'Alex Carter',
            email,
            role: 'Employee',
            department: 'Engineering',
            emailed: !emailFailure,
          });
          const mailInput = vi.mocked(templates.inviteMember).mock.calls[0][0];
          const token = new URL(mailInput.acceptUrl).pathname.split('/').at(-1)!;
          expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
          const user = await db.user.findFirstOrThrow({ where: { email } });
          const invitation = await db.invitation.findUniqueOrThrow({ where: { userId: user.id } });
          expect(invitation.tokenHash === hashInviteToken(token)).toBe(true);
          expect(user.status).toBe('INVITED');
          expect(user.password).toBeNull();
          expect(invitation.acceptedAt).toBeNull();
          expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
          if (reInvite) {
            expect(user.id).toBe(previousId);
            expect(invitation.tokenHash === previousHash).toBe(false);
          }
          expect(await db.user.count({ where: { email } })).toBe(1);
          expect(audit).toHaveBeenCalledOnce();
          expect(audit.mock.calls[0][0].metadata.reInvite).toBe(reInvite);
          expect(sendEmail).toHaveBeenCalledExactlyOnceWith({
            to: { email, name: 'Alex Carter' },
            subject: 'Invite',
            html: 'email html',
            text: 'email text',
          });
          const serialized = JSON.stringify({ result, audit: audit.mock.calls });
          for (const secret of [
            token,
            invitation.tokenHash,
            mailInput.acceptUrl,
            previousHash,
          ].filter(Boolean) as string[])
            expect(serialized.includes(secret)).toBe(false);
          expect(/inviteUrl|tokenHash|acceptUrl/.test(serialized)).toBe(false);
          previousHash = invitation.tokenHash;
          previousId = user.id;
          // Exercise replacement of a previously accepted invitation, too.
          await db.invitation.update({
            where: { userId: user.id },
            data: { acceptedAt: new Date() },
          });
        }
      } finally {
        log.mockRestore();
      }
    }
  );
});
