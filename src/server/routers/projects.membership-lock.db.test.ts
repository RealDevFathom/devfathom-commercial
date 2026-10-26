import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = `${process.pid}-${Date.now()}`;
const organizationId = `membership-lock-org-${suffix}`;
const projectId = `membership-lock-project-${suffix}`;

describeIfDatabase('project membership lock', () => {
  beforeAll(async () => {
    const { db } = await import('@/lib/db');
    await db.$executeRaw`
      INSERT INTO "organizations" ("id", "slug", "legalName", "displayName", "createdAt", "updatedAt")
      VALUES (${organizationId}, ${organizationId}, 'Membership lock test', 'Membership lock test', NOW(), NOW())
    `;
    await db.$executeRaw`
      INSERT INTO "projects" ("id", "organizationId", "name", "status", "type", "techStack", "createdAt", "updatedAt")
      VALUES (${projectId}, ${organizationId}, 'Membership lock test', 'ACTIVE', 'INTERNAL', ARRAY[]::text[], NOW(), NOW())
    `;
  });

  afterAll(async () => {
    const { db } = await import('@/lib/db');
    await db.$executeRaw`DELETE FROM "organizations" WHERE "id" = ${organizationId}`;
  });

  it('serializes concurrent membership mutation critical sections for one project', async () => {
    const [{ db }, { lockProjectMembershipChanges }] = await Promise.all([
      import('@/lib/db'),
      import('./projects'),
    ]);
    let releaseFirst!: () => void;
    let firstLocked!: () => void;
    let secondAttempted!: () => void;
    const release = new Promise<void>((resolve) => (releaseFirst = resolve));
    const locked = new Promise<void>((resolve) => (firstLocked = resolve));
    const attempted = new Promise<void>((resolve) => (secondAttempted = resolve));
    const order: string[] = [];

    const first = db.$transaction(async (tx) => {
      await lockProjectMembershipChanges(tx, projectId);
      order.push('first locked');
      firstLocked();
      await release;
      order.push('first released');
    });
    await locked;

    const second = db.$transaction(async (tx) => {
      secondAttempted();
      await lockProjectMembershipChanges(tx, projectId);
      order.push('second locked');
    });
    await attempted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(['first locked']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first locked', 'first released', 'second locked']);
  });
});
