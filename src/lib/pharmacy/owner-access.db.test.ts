// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { withOrganizationDefaults, withPlatformDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';
import { AGENCY_ROLE_TEMPLATES, PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { can, subjectFromSession } from '@/lib/abac';
import { ALL_ACTIONS } from '@/lib/abac/policies';
import { assignedRegisterBranchIds } from './controlled-register';
import { pharmacySafetyRouter } from '@/server/routers/pharmacy-safety';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import type { TRPCContext } from '@/server/trpc';

vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
afterAll(() => db.$disconnect());

describe('shared owner capabilities and automatic branch scope (PostgreSQL)', () => {
  it('covers default roles, existing owners, new branches, safety/reports and isolation', async () => {
    expect(Boolean(process.env.DATABASE_URL)).toBe(true);
    const org = `owner_${randomUUID().replaceAll('-', '')}`;
    const rollback = new Error('rollback owner regression');
    try {
      await withPlatformDb(
        async (platform) => {
          for (const organizationId of [org, `${org}_foreign`]) {
            await platform.organization.create({
              data: {
                id: organizationId,
                slug: organizationId,
                legalName: organizationId,
                displayName: organizationId,
                vertical: 'PHARMACY',
                status: 'ACTIVE',
                deploymentMode: 'SHARED',
              },
            });
          }
          await withOrganizationDefaults(platform, `${org}_foreign`, async (tx) => {
            await tx.pharmacyBranch.create({
              data: {
                id: `${org}_foreign_branch`,
                code: 'FOREIGN',
                name: 'Foreign',
                addressLine: 'Road',
                city: 'Lahore',
                provinceCode: 'PB',
              },
            });
          });
          await withOrganizationDefaults(platform, org, async (tx) => {
            await seedDepartments(tx, [org], ['LEADERSHIP']);
            for (const key of ['owner', 'admin', 'cashier']) {
              const template = [...PHARMACY_ROLE_TEMPLATES, ...AGENCY_ROLE_TEMPLATES].find(
                (r) => r.key === key
              )!;
              await tx.organizationRole.create({
                data: {
                  id: `${org}_${key}`,
                  key,
                  name: template.name,
                  isSystem: template.isSystem,
                  permissions: {
                    create: template.capabilities.map((capability) => ({
                      capability,
                      effect: 'ALLOW',
                    })),
                  },
                },
              });
            }
            const user = await tx.user.create({
              data: {
                id: `${org}_user`,
                name: 'Owner regression',
                email: `${org}@example.test`,
                role: 'EMPLOYEE',
                department: 'LEADERSHIP',
                title: 'Owner',
                organizationRoleId: `${org}_owner`,
              },
            });
            const context = {
              db: tx,
              entitlements: {
                organizationId: org,
                enabledModules: ['pharmacy-safety', 'pharmacy-reports'],
                modules: [],
              },
              session: { expires: 'later', user },
              organization: { id: org },
              support: null,
              requestMeta: { ip: null, userAgent: null },
              audit: { detail: {} },
            } as unknown as TRPCContext;
            const safety = pharmacySafetyRouter.createCaller(context);
            const reports = pharmacyReportsRouter.createCaller(context);
            const branch = async (key: string, active = true) =>
              tx.pharmacyBranch.create({
                data: {
                  id: `${org}_${key}`,
                  code: key,
                  name: key,
                  active,
                  addressLine: 'Road',
                  city: 'Lahore',
                  provinceCode: 'PB',
                },
              });
            const first = await branch('first');
            const inactive = await branch('inactive', false);
            for (const key of ['owner', 'admin', 'tenant-admin']) {
              await tx.user.update({
                where: { id: user.id },
                data: {
                  role: key === 'tenant-admin' ? 'ADMIN' : 'EMPLOYEE',
                  organizationRoleId: key === 'tenant-admin' ? null : `${org}_${key}`,
                },
              });
              for (const action of ALL_ACTIONS)
                expect(
                  await can(subjectFromSession(user), action, undefined, { db: tx }),
                  `${key}: ${action}`
                ).toBe(true);
              expect(await assignedRegisterBranchIds(tx, org, user.id)).toEqual([first.id]);
              expect((await safety.branches()).map((b) => b.id)).toEqual([first.id]);
              expect(await safety.controlledRegister({ branchId: first.id })).toMatchObject({
                entries: [],
              });
              expect(
                await reports.exportPharmacovigilanceDrap({
                  branchId: first.id,
                  from: new Date('2026-01-01'),
                  to: new Date('2027-01-01'),
                })
              ).toMatchObject({ reports: [] });
            }
            // Existing tenant owners do not need their old permissions rewritten.
            await tx.organizationRolePermission.deleteMany({
              where: { organizationRoleId: `${org}_owner` },
            });
            await tx.user.update({
              where: { id: user.id },
              data: { role: 'EMPLOYEE', organizationRoleId: `${org}_owner` },
            });
            for (const action of ALL_ACTIONS)
              expect(await can(user, action, undefined, { db: tx }), action).toBe(true);
            const second = await branch('new');
            expect(new Set(await assignedRegisterBranchIds(tx, org, user.id))).toEqual(
              new Set([first.id, second.id])
            );
            expect(new Set((await safety.branches()).map((b) => b.id))).toEqual(
              new Set([first.id, second.id])
            );
            expect(
              await reports.exportPharmacovigilanceDrap({
                branchId: second.id,
                from: new Date('2026-01-01'),
                to: new Date('2027-01-01'),
              })
            ).toMatchObject({ reports: [] });
            expect(await tx.pharmacyBranchAssignment.count({ where: { userId: user.id } })).toBe(0);
            for (const branchId of [inactive.id, `${org}_foreign_branch`]) {
              await expect(safety.controlledRegister({ branchId })).rejects.toMatchObject({
                code: 'FORBIDDEN',
              });
              await expect(
                reports.exportPharmacovigilanceDrap({
                  branchId,
                  from: new Date('2026-01-01'),
                  to: new Date('2027-01-01'),
                })
              ).rejects.toMatchObject({ code: 'FORBIDDEN' });
            }
            expect(await assignedRegisterBranchIds(tx, `${org}_foreign`, user.id)).toEqual([]);
            expect(
              await can(
                { ...user, organizationId: `${org}_foreign` },
                'pharmacy:safety',
                undefined,
                { db: tx }
              )
            ).toBe(false);
            await tx.userPermissionOverride.create({
              data: {
                userId: user.id,
                capability: 'pharmacy:*',
                effect: 'DENY',
                reason: 'Owner deny regression',
              },
            });
            await expect(safety.branches()).rejects.toMatchObject({ code: 'FORBIDDEN' });
            await expect(
              reports.exportPharmacovigilanceDrap({
                branchId: first.id,
                from: new Date('2026-01-01'),
                to: new Date('2027-01-01'),
              })
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
            await tx.userPermissionOverride.deleteMany({ where: { userId: user.id } });
            await tx.user.update({ where: { id: user.id }, data: { status: 'INACTIVE' } });
            expect(await assignedRegisterBranchIds(tx, org, user.id)).toEqual([]);
            for (const action of ALL_ACTIONS)
              expect(await can(user, action, undefined, { db: tx }), action).toBe(false);
            await tx.user.update({
              where: { id: user.id },
              data: { status: 'ACTIVE', organizationRoleId: `${org}_cashier` },
            });
            expect(await assignedRegisterBranchIds(tx, org, user.id)).toEqual([]);
            await tx.pharmacyBranchAssignment.create({
              data: { userId: user.id, branchId: first.id },
            });
            expect(await assignedRegisterBranchIds(tx, org, user.id)).toEqual([first.id]);
            for (const action of [
              'pharmacy:safety',
              'pharmacy:dispense',
              'pharmacy:catalogue-review',
            ] as const)
              expect(await can(user, action, undefined, { db: tx })).toBe(false);
          });
          throw rollback;
        },
        { timeout: 30000 }
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }, 30000);
});
