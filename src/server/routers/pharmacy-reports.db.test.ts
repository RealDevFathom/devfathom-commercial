// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { withPlatformDb, withOrganizationDefaults, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { db } from '@/lib/db';
import { seedDepartments } from '@/lib/test-support/departments';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { ALL_ACTIONS } from '@/lib/abac/policies';
import { AGENCY_ROLE_TEMPLATES, roleTemplatesForVertical } from '@/lib/vertical-catalog';
import { toAuditJson } from '@/server/audit';
import { pharmacyReportsRouter } from './pharmacy-reports';
import type { TRPCContext } from '../trpc';

vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

const org = `pv_${randomUUID().replaceAll('-', '')}`;
const id = (s: string) => `${org}_${s}`;
const pin = '846291';
const audit = { detail: {} };
let transaction: ScopedDb;
function withTenantDb<T>(organizationId: string, work: (tx: ScopedDb) => Promise<T>) {
  return withOrganizationDefaults(transaction, organizationId, work);
}
function act<T>(
  person: string,
  run: (api: ReturnType<typeof pharmacyReportsRouter.createCaller>) => Promise<T>,
  failAudit = false
) {
  audit.detail = {};
  return withTenantDb(org, (tx) =>
    run(
      pharmacyReportsRouter.createCaller({
        db: failAudit
          ? new Proxy(tx, {
              get(target, key) {
                if (key === '$transaction')
                  return (work: (db: ScopedDb) => Promise<unknown>) =>
                    work(
                      new Proxy(target, {
                        get(inner, model) {
                          if (model === 'auditLog')
                            return {
                              create: (args: { data: Record<string, unknown> }) =>
                                inner.auditLog.create({
                                  data: { ...args.data, actorId: id('missing_actor') } as never,
                                }),
                            };
                          return Reflect.get(inner, model);
                        },
                      })
                    );
                return Reflect.get(target, key);
              },
            })
          : tx,
        entitlements: { organizationId: org, enabledModules: ['pharmacy-reports'], modules: [] },
        session: {
          expires: 'later',
          user: {
            id: id(person),
            role: person === 'owner' ? 'ADMIN' : 'EMPLOYEE',
            status: 'ACTIVE',
            organizationId: org,
          },
        },
        organization: { id: org },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit,
      } as unknown as TRPCContext)
    )
  );
}
const transition = { id: id('report'), branchId: id('branch'), state: 'READY' as const };
const exportInput = {
  branchId: id('branch'),
  from: new Date('2026-01-01'),
  to: new Date('2027-01-01'),
};
const ownerAuthorization = { staffProfileId: id('staff'), pin };

afterAll(() => db.$disconnect());
describe('pharmacovigilance PostgreSQL authorization and review', () => {
  it('enforces denial, owner scope, fresh solo PIN and independent staffed review', async () => {
    expect(Boolean(process.env.DATABASE_URL)).toBe(true);
    const credentialHash = await hashOperatorCredential('PIN', pin);
    const rollback = new Error('rollback synthetic pharmacovigilance fixture');
    try {
      await withPlatformDb(
        async (tx) => {
          transaction = tx;
          await tx.organization.create({
            data: {
              id: org,
              slug: org,
              legalName: org,
              displayName: org,
              vertical: 'PHARMACY',
              status: 'ACTIVE',
              deploymentMode: 'SHARED',
            },
          });
          await withTenantDb(org, async (tx) => {
            await seedDepartments(tx, [org], ['LEADERSHIP']);
            await tx.organizationRole.create({
              data: {
                id: id('role'),
                key: 'safety',
                name: 'Safety',
                permissions: {
                  create: [{ capability: 'pharmacy:safety', effect: 'ALLOW' }],
                },
              },
            });
            for (const key of ['owner', 'admin']) {
              await tx.organizationRole.create({
                data: {
                  id: id(key + '_role'),
                  key,
                  name: key,
                  isSystem: true,
                  permissions: {
                    create: [...roleTemplatesForVertical('PHARMACY'), ...AGENCY_ROLE_TEMPLATES]
                      .find((r) => r.key === key)!
                      .capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
                  },
                },
              });
            }
            await tx.organizationRole.create({
              data: {
                id: id('all_role'),
                key: 'all',
                name: 'All grants',
                permissions: {
                  create: ALL_ACTIONS.map((capability) => ({ capability, effect: 'ALLOW' })),
                },
              },
            });
            for (const person of ['owner', 'reviewer', 'denied']) {
              await tx.user.create({
                data: {
                  id: id(person),
                  name: person,
                  email: `${id(person)}@example.test`,
                  department: 'LEADERSHIP',
                  title: person,
                  role: person === 'owner' ? 'ADMIN' : 'EMPLOYEE',
                  organizationRoleId:
                    person === 'owner'
                      ? id('owner_role')
                      : person === 'denied'
                        ? undefined
                        : id('role'),
                },
              });
            }
            await tx.pharmacyBranch.create({
              data: {
                id: id('branch'),
                code: 'PV',
                name: 'PV',
                addressLine: '1 Road',
                city: 'Lahore',
                provinceCode: 'PB',
              },
            });
            await tx.restaurantStaffProfile.create({
              data: {
                id: id('staff'),
                userId: id('owner'),
                displayName: 'Owner',
                credentials: { create: { type: 'PIN', credentialHash } },
              },
            });
            await tx.pharmacyPharmacovigilanceReport.create({
              data: {
                id: id('report'),
                branchId: id('branch'),
                kind: 'ADVERSE_DRUG_REACTION',
                state: 'UNDER_REVIEW',
                occurredAt: new Date('2026-10-01'),
                assertedDescription: 'Synthetic regression report',
                createdByUserId: id('owner'),
              },
            });
          });
          await expect(
            act('denied', (api) => api.exportPharmacovigilanceDrap(exportInput))
          ).rejects.toMatchObject({ code: 'FORBIDDEN' });
          await expect(
            act('reviewer', (api) => api.exportPharmacovigilanceDrap(exportInput))
          ).rejects.toMatchObject({ code: 'FORBIDDEN' });
          expect(
            (await act('owner', (api) => api.exportPharmacovigilanceDrap(exportInput))).reports
          ).toHaveLength(1);
          for (const roleId of ['admin_role', 'all_role', 'owner_role']) {
            await withTenantDb(org, (tx) =>
              tx.user.update({
                where: { id: id('owner') },
                data: { organizationRoleId: id(roleId) },
              })
            );
            expect(
              (await act('owner', (api) => api.exportPharmacovigilanceDrap(exportInput))).reports
            ).toHaveLength(1);
          }
          await withTenantDb(org, (tx) =>
            tx.userPermissionOverride.create({
              data: {
                userId: id('owner'),
                capability: 'pharmacy:*',
                effect: 'DENY',
                reason: 'Synthetic PV denial',
              },
            })
          );
          await expect(
            act('owner', (api) => api.exportPharmacovigilanceDrap(exportInput))
          ).rejects.toMatchObject({ code: 'FORBIDDEN' });
          await withTenantDb(org, (tx) =>
            tx.userPermissionOverride.deleteMany({ where: { userId: id('owner') } })
          );
          expect(
            await act('owner', (api) => api.transitionPharmacovigilanceReport(transition))
          ).toHaveProperty('blocked');
          expect(
            await act('owner', (api) =>
              api.transitionPharmacovigilanceReport({
                ...transition,
                ownerAuthorization: { ...ownerAuthorization, pin: '000000' },
              })
            )
          ).toHaveProperty('blocked');
          await withTenantDb(org, async (tx) => {
            expect(
              (
                await tx.restaurantOperatorCredential.findFirstOrThrow({
                  where: { staffProfileId: id('staff') },
                })
              ).failedAttempts
            ).toBe(1);
            expect(
              (
                await tx.pharmacyPharmacovigilanceReport.findUniqueOrThrow({
                  where: { id: id('report') },
                })
              ).state
            ).toBe('UNDER_REVIEW');
          });
          // Neither a locked nor a revoked credential can approve with a valid PIN.
          await withTenantDb(org, (tx) =>
            tx.restaurantOperatorCredential.updateMany({
              where: { staffProfileId: id('staff') },
              data: { lockedUntil: new Date(Date.now() + 60000) },
            })
          );
          expect(
            await act('owner', (api) =>
              api.transitionPharmacovigilanceReport({ ...transition, ownerAuthorization })
            )
          ).toHaveProperty('blocked');
          await withTenantDb(org, (tx) =>
            tx.restaurantOperatorCredential.updateMany({
              where: { staffProfileId: id('staff') },
              data: { lockedUntil: null, revokedAt: new Date() },
            })
          );
          expect(
            await act('owner', (api) =>
              api.transitionPharmacovigilanceReport({ ...transition, ownerAuthorization })
            )
          ).toHaveProperty('blocked');
          await withTenantDb(org, (tx) =>
            tx.restaurantOperatorCredential.updateMany({
              where: { staffProfileId: id('staff') },
              data: { revokedAt: null },
            })
          );
          // Emulate the HTTP request transaction: nested scoped transactions reuse
          // the connection, so the request boundary must roll back a thrown error.
          await tx.$executeRawUnsafe('SAVEPOINT pv_failed_request');
          await expect(
            act(
              'owner',
              (api) =>
                api.transitionPharmacovigilanceReport({
                  ...transition,
                  ownerAuthorization,
                }),
              true
            )
          ).rejects.toThrow();
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT pv_failed_request');
          await withTenantDb(org, async (tx) => {
            expect(
              (
                await tx.pharmacyPharmacovigilanceReport.findUniqueOrThrow({
                  where: { id: id('report') },
                })
              ).state
            ).toBe('UNDER_REVIEW');
            expect(
              (
                await tx.restaurantOperatorCredential.findFirstOrThrow({
                  where: { staffProfileId: id('staff') },
                })
              ).failedAttempts
            ).toBe(1);
            expect(
              await tx.auditLog.count({
                where: { action: 'pharmacyReports.soloOwnerSelfApproval' },
              })
            ).toBe(0);
          });
          expect(
            await act('owner', (api) =>
              api.transitionPharmacovigilanceReport({ ...transition, ownerAuthorization })
            )
          ).toMatchObject({
            state: 'READY',
            reviewedByUserId: id('owner'),
            externalSubmissionState: 'NOT_SUBMITTED',
          });
          await withTenantDb(org, async (tx) => {
            const rows = await tx.auditLog.findMany({
              where: { action: 'pharmacyReports.soloOwnerSelfApproval' },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              organizationId: org,
              actorId: id('owner'),
              targetType: 'PharmacyPharmacovigilanceReport',
              targetId: id('report'),
              metadata: {
                branchId: id('branch'),
                staffProfileId: id('staff'),
                reportId: id('report'),
                soloOwnerSelfApproval: true,
                reauthenticationMethod: 'PIN',
                reauthenticatedAt: expect.any(String),
              },
            });
            expect(JSON.stringify(rows)).not.toContain(pin);
          });
          expect(audit.detail).toMatchObject({
            skipInput: true,
            metadata: { soloOwnerSelfApproval: true },
          });
          expect(JSON.stringify(audit)).not.toContain(pin);
          expect(JSON.stringify(toAuditJson({ ownerAuthorization }))).not.toContain(pin);
          await withTenantDb(org, async (tx) => {
            await tx.pharmacyPharmacovigilanceReport.update({
              where: { id: id('report') },
              data: { state: 'UNDER_REVIEW' },
            });
            await tx.restaurantStaffProfile.create({
              data: { userId: id('reviewer'), displayName: 'Reviewer' },
            });
            await tx.pharmacyBranchAssignment.create({
              data: { userId: id('reviewer'), branchId: id('branch') },
            });
          });
          expect(
            await act('owner', (api) =>
              api.transitionPharmacovigilanceReport({ ...transition, ownerAuthorization })
            )
          ).toHaveProperty('blocked');
          expect(
            await act('reviewer', (api) => api.transitionPharmacovigilanceReport(transition))
          ).toMatchObject({ state: 'READY', reviewedByUserId: id('reviewer') });
          expect(
            await act('owner', (api) =>
              api.transitionPharmacovigilanceReport({ ...transition, state: 'SUBMITTED' })
            )
          ).toMatchObject({ state: 'SUBMITTED', reviewedByUserId: id('reviewer') });
          throw rollback;
        },
        { timeout: 30000 }
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }, 30000);
});
