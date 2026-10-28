// @vitest-environment node
/** PR 268: real router, Prisma, PostgreSQL RLS, PIN hashing and durable attribution.
 * Run with DATABASE_URL and, if it is privileged, TEST_RUNTIME_ROLE naming an
 * existing NOSUPERUSER/NOBYPASSRLS application role. Fixtures always roll back.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withPlatformDb, withOrganizationDefaults, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { restaurantSopExecutionRouter } from './restaurant-sop-execution';
import { packageByKey } from '@/lib/vertical-catalog';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { resolveRestaurantActor } from '@/server/restaurant-actor';
import { toAuditJson } from '@/server/audit';

async function scenario(
  run: (
    db: ScopedDb,
    ids: Record<string, string>,
    caller: (user: string) => ReturnType<typeof restaurantSopExecutionRouter.createCaller>
  ) => Promise<void>
) {
  if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL is required for SOP security regressions');
  const prefix = `sop268_${randomUUID().replaceAll('-', '')}`;
  const ids = Object.fromEntries(
    [
      'org',
      'home',
      'remote',
      'owner',
      'other',
      'ownerUser',
      'otherUser',
      'template',
      'version',
      'step',
      'assignment',
      'occurrence',
      'occurrenceStep',
    ].map((key) => [key, `${prefix}_${key}`])
  );
  const rollback = new Error('rollback successful security fixture');
  try {
    await withPlatformDb(
      async (platform) => {
        await platform.organization.create({
          data: {
            id: ids.org,
            slug: prefix,
            legalName: prefix,
            displayName: prefix,
            status: 'ACTIVE',
            vertical: 'RESTAURANT',
          },
        });
        await withOrganizationDefaults(platform, ids.org!, async (db) => {
          try {
            await db.organizationDepartment.create({
              data: { key: 'OPERATIONS', name: 'Operations' },
            });
            for (const id of [ids.ownerUser!, ids.otherUser!]) {
              await db.user.create({
                data: {
                  id,
                  name: id,
                  email: `${id.toLowerCase()}@example.test`,
                  role: id === ids.ownerUser ? 'ADMIN' : 'EMPLOYEE',
                  department: 'OPERATIONS',
                  title: 'Operator',
                },
              });
            }
            const staffRole = await db.organizationRole.create({
              data: {
                key: 'sop-staff',
                name: 'SOP staff',
                permissions: {
                  create: [{ capability: 'sop:complete' }, { capability: 'sop:verify' }],
                },
              },
            });
            await db.user.update({
              where: { id: ids.otherUser },
              data: { organizationRoleId: staffRole.id },
            });
            await db.restaurantBranch.createMany({
              data: [
                { id: ids.home, name: 'Home' },
                { id: ids.remote, name: 'Remote' },
              ],
            });
            await db.restaurantStaffProfile.createMany({
              data: [
                {
                  id: ids.owner,
                  userId: ids.ownerUser,
                  displayName: 'Owner',
                  primaryBranchId: ids.home,
                },
                {
                  id: ids.other,
                  userId: ids.otherUser,
                  displayName: 'Other',
                  primaryBranchId: ids.remote,
                },
              ],
            });
            await db.restaurantOperatorCredential.create({
              data: {
                staffProfileId: ids.owner!,
                type: 'PIN',
                credentialHash: await hashOperatorCredential('PIN', '4821'),
              },
            });
            await db.restaurantSopTemplate.create({
              data: { id: ids.template, name: 'Security checklist' },
            });
            await db.restaurantSopTemplateVersion.create({
              data: { id: ids.version, templateId: ids.template!, versionNumber: 1 },
            });
            await db.restaurantSopTemplateStep.create({
              data: { id: ids.step, templateVersionId: ids.version!, stepOrder: 1, title: 'Check' },
            });
            await db.restaurantSopAssignment.create({
              data: {
                id: ids.assignment,
                branchId: ids.home!,
                templateId: ids.template!,
                startDate: new Date('2026-10-28'),
                daysOfWeek: [],
                assigneeTargetType: 'PERSON',
                assigneeStaffProfileId: ids.owner,
              },
            });
            await db.restaurantSopOccurrence.create({
              data: {
                id: ids.occurrence,
                assignmentId: ids.assignment!,
                templateVersionId: ids.version!,
                branchId: ids.home!,
                businessDate: new Date('2026-10-28'),
                dueAt: new Date(),
                windowEndsAt: new Date(Date.now() + 3_600_000),
                assignedStaffProfileId: ids.owner,
              },
            });
            await db.restaurantSopOccurrenceStep.create({
              data: {
                id: ids.occurrenceStep,
                occurrenceId: ids.occurrence!,
                templateStepId: ids.step!,
              },
            });
            const role = process.env.TEST_RUNTIME_ROLE;
            if (role) {
              if (!/^[a-z][a-z0-9_]*$/.test(role)) throw new Error('Invalid TEST_RUNTIME_ROLE');
              // Transactional fixture grant: use ordinary application DML privileges;
              // FORCE RLS remains enabled, and these grants roll back with the fixture.
              await db.$executeRawUnsafe(
                `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`
              );
              await db.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
            }
            const [runtime] = await db.$queryRawUnsafe<
              { rolsuper: boolean; rolbypassrls: boolean }[]
            >('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
            expect(runtime).toEqual({ rolsuper: false, rolbypassrls: false });
            const pkg = packageByKey('restaurant-enterprise')!;
            const caller = (user: string) =>
              restaurantSopExecutionRouter.createCaller({
                db,
                session: {
                  expires: 'later',
                  user: {
                    id: user,
                    role: user === ids.ownerUser ? 'ADMIN' : 'EMPLOYEE',
                    status: 'ACTIVE',
                    organizationId: ids.org,
                    department: 'OPERATIONS',
                  },
                },
                organization: null,
                support: null,
                entitlements: {
                  organizationId: ids.org,
                  enabledModules: [...pkg.moduleKeys],
                  limits: { ...pkg.defaultLimits },
                  activeSeats: 2,
                  seatLimit: 50,
                  modules: [],
                },
                requestMeta: { ip: null, userAgent: null },
                audit: { detail: {}, db },
              } as never);
            await run(db, ids, caller);
            throw rollback;
          } catch (error) {
            if (error !== rollback)
              console.error(
                'SOP database regression failure',
                (error as { code?: string }).code,
                (
                  error as {
                    meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } };
                  }
                ).meta?.driverAdapterError?.cause?.originalMessage
              );
            throw error;
          }
        });
      },
      { timeout: 60_000 }
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe('PR 268 SOP security against local Postgres', () => {
  it('enforces tenant RLS even for an owner', async () => {
    await scenario(async (db, ids) => {
      await db.$executeRawUnsafe(
        "SELECT set_config('app.current_organization_id', 'absent_sop268_tenant', true)"
      );
      expect(await db.restaurantBranch.findMany()).toEqual([]);
      await db.$executeRawUnsafe(
        "SELECT set_config('app.current_organization_id', $1, true)",
        ids.org
      );
    });
  }, 30_000);
  it('allows a branch-only owner to PIN-approve a waiver with durable evidence', async () => {
    await scenario(async (db, ids) => {
      await db.user.update({ where: { id: ids.ownerUser }, data: { role: 'EMPLOYEE' } });
      const role = await db.restaurantJobRole.create({
        data: { key: 'owner', name: 'Branch owner' },
      });
      await db.restaurantStaffJobRole.create({
        data: { staffProfileId: ids.owner!, branchId: ids.home!, jobRoleId: role.id },
      });
      await db.restaurantSopOccurrence.update({
        where: { id: ids.occurrence },
        data: { status: 'MISSED' },
      });
      const { waiveOccurrence } = await import('@/lib/restaurant/sop-verification');
      await waiveOccurrence(db, {
        occurrenceId: ids.occurrence!,
        actorStaffProfileId: ids.owner!,
        approvingStaffProfileId: ids.owner!,
        approvalPin: '4821',
        reason: 'Emergency',
      });
      const audit = await db.restaurantCoAuthorization.findFirstOrThrow();
      expect(audit).toMatchObject({
        actingStaffProfileId: ids.owner,
        approvingStaffProfileId: ids.owner,
        reason: '[SOLO_OWNER_PIN_REAUTH] Emergency',
      });
    });
  }, 30_000);

  it('blocks caller actor spoofing and preserves the full owner execution lifecycle', async () => {
    await scenario(async (db, ids, caller) => {
      await db.restaurantStaffProfile.update({
        where: { id: ids.other },
        data: { primaryBranchId: ids.home },
      });
      const owner = caller(ids.ownerUser!);
      const attacker = caller(ids.otherUser!);
      await expect(
        attacker.start({ occurrenceId: ids.occurrence!, actorStaffProfileId: ids.owner })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await owner.start({ occurrenceId: ids.occurrence!, actorStaffProfileId: ids.other });
      await expect(
        attacker.completeStep({
          occurrenceId: ids.occurrence!,
          templateStepId: ids.step!,
          actorStaffProfileId: ids.owner,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        attacker.attachEvidence({
          occurrenceId: ids.occurrence!,
          uploaderStaffProfileId: ids.owner,
          contentHashHex: 'a'.repeat(64),
          mimeType: 'image/jpeg',
          sizeBytes: 1,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await owner.attachEvidence({
        occurrenceId: ids.occurrence!,
        uploaderStaffProfileId: ids.other,
        contentHashHex: 'a'.repeat(64),
        mimeType: 'image/jpeg',
        sizeBytes: 1,
      });
      await owner.completeStep({
        occurrenceId: ids.occurrence!,
        templateStepId: ids.step!,
        actorStaffProfileId: ids.other,
      });
      await expect(
        attacker.submit({ occurrenceId: ids.occurrence!, actorStaffProfileId: ids.owner })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await owner.submit({ occurrenceId: ids.occurrence!, actorStaffProfileId: ids.other });
      expect(
        (
          await db.restaurantSopEvidence.findFirstOrThrow({
            where: { occurrenceId: ids.occurrence },
          })
        ).uploaderStaffProfileId
      ).toBe(ids.owner);
      expect(
        (
          await db.restaurantSopOccurrenceStep.findUniqueOrThrow({
            where: { id: ids.occurrenceStep },
          })
        ).completedByStaffProfileId
      ).toBe(ids.owner);
      await attacker.reject({ occurrenceId: ids.occurrence!, actorStaffProfileId: ids.owner });
      expect(
        (
          await db.restaurantSopVerification.findFirstOrThrow({
            where: { occurrenceId: ids.occurrence },
          })
        ).actorStaffProfileId
      ).toBe(ids.other);
    });
  }, 30_000);

  it('allows automatic owner access to another active tenant branch', async () => {
    await scenario(async (db, ids) => {
      const ctx = {
        db,
        session: {
          user: { id: ids.ownerUser, organizationId: ids.org, role: 'ADMIN', status: 'ACTIVE' },
        },
        entitlements: { organizationId: ids.org },
        requestMeta: { ip: null },
      };
      await expect(resolveRestaurantActor(ctx as never, [ids.remote!])).resolves.toEqual({
        staffProfileId: ids.owner,
      });
    });
  }, 30_000);

  it('requires an actual PIN and stores solo approval evidence without the PIN', async () => {
    await scenario(async (db, ids, caller) => {
      await db.restaurantSopOccurrence.update({
        where: { id: ids.occurrence },
        data: { status: 'SUBMITTED' },
      });
      const owner = caller(ids.ownerUser!);
      await expect(owner.verify({ occurrenceId: ids.occurrence! })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        owner.verify({ occurrenceId: ids.occurrence!, approvalPin: '9999' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await db.restaurantCoAuthorization.count()).toBe(0);
      await owner.verify({
        occurrenceId: ids.occurrence!,
        actorStaffProfileId: ids.other,
        approvalPin: '4821',
      });
      const decision = await db.restaurantSopVerification.findFirstOrThrow({
        where: { occurrenceId: ids.occurrence },
        include: { coAuthorization: true },
      });
      expect(decision.actorStaffProfileId).toBe(ids.owner);
      expect(decision.coAuthorization).toMatchObject({
        actingStaffProfileId: ids.owner,
        approvingStaffProfileId: ids.owner,
        reason: expect.stringContaining('[SOLO_OWNER_PIN_REAUTH]'),
      });
      expect(JSON.stringify(decision)).not.toContain('4821');
      expect(toAuditJson({ approvalPin: '4821' })).toEqual({ approvalPin: '[REDACTED]' });
      const audits = await db.auditLog.findMany({
        where: { actorId: ids.ownerUser, action: 'verify' },
      });
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(audits)).not.toContain('4821');
      expect(
        audits.some((row) => (row.input as Record<string, unknown>)?.approvalPin === '[REDACTED]')
      ).toBe(true);
    });
  }, 30_000);

  it('denies multi-staff self-approval and records the distinct verifier from session', async () => {
    await scenario(async (db, ids, caller) => {
      await db.restaurantStaffProfile.update({
        where: { id: ids.other },
        data: { primaryBranchId: ids.home },
      });
      await db.restaurantSopOccurrence.update({
        where: { id: ids.occurrence },
        data: { status: 'SUBMITTED' },
      });
      await expect(
        caller(ids.ownerUser!).verify({ occurrenceId: ids.occurrence!, approvalPin: '4821' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await db.restaurantSopVerification.count()).toBe(0);
      await caller(ids.otherUser!).verify({
        occurrenceId: ids.occurrence!,
        actorStaffProfileId: ids.owner,
      });
      expect(
        (
          await db.restaurantSopVerification.findFirstOrThrow({
            where: { occurrenceId: ids.occurrence },
          })
        ).actorStaffProfileId
      ).toBe(ids.other);
    });
  }, 30_000);
});
