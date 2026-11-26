/** @vitest-environment node */
import { randomBytes } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Action } from '@/lib/abac';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import type { PharmacyFixture, RoleKey } from './pharmacy-role-tasks.fixture';
import type { tasks } from './pharmacy-role-tasks.jobs';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
type Job = keyof ReturnType<typeof tasks>;
const jobs: Job[] = [
  'sell',
  'prescription',
  'controlled',
  'catalogue',
  'import',
  'raisePurchase',
  'approvePurchase',
  'receive',
  'adjust',
  'closeShift',
  'closeDay',
  'supplierPayment',
  'reports',
  'discount',
  'team',
  'controlledReturn',
  'refund',
];
// A new job or built-in role needs an explicit contract. These expectations are
// independent of the templates used to provision the accounts.
const duties: Record<RoleKey, readonly Job[]> = {
  owner: [
    'sell',
    'raisePurchase',
    'approvePurchase',
    'receive',
    'adjust',
    'closeShift',
    'closeDay',
    'supplierPayment',
    'reports',
    'discount',
    'team',
    'refund',
  ],
  'owner-operator': [
    'sell',
    'prescription',
    'controlled',
    'catalogue',
    'import',
    'raisePurchase',
    'approvePurchase',
    'receive',
    'adjust',
    'closeShift',
    'closeDay',
    'supplierPayment',
    'reports',
    'discount',
    'team',
    'controlledReturn',
    'refund',
  ],
  pharmacist: ['prescription', 'controlled', 'catalogue', 'import', 'closeDay'],
  'pharmacist-cashier': [
    'sell',
    'prescription',
    'controlled',
    'catalogue',
    'import',
    'closeShift',
    'closeDay',
    'discount',
  ],
  manager: [
    'raisePurchase',
    'approvePurchase',
    'receive',
    'adjust',
    'closeShift',
    'closeDay',
    'reports',
  ],
  cashier: ['sell', 'closeShift', 'discount'],
  procurement: ['raisePurchase', 'receive'],
  inventory: ['adjust'],
  finance: ['reports'],
  auditor: ['reports'],
};
const roles = Object.keys(duties) as RoleKey[];
// Compound jobs have a separate owner decision from the right named by one step.
const compoundGates: Partial<
  Record<Job, Partial<Record<RoleKey, readonly [held: Action, missing: Action]>>>
> = {
  supplierPayment: { finance: ['finance:manage', 'admin:access'] },
  controlledReturn: {
    owner: ['pharmacy:procurement', 'pharmacy:dispense'],
    manager: ['pharmacy:procurement', 'reports:financial'],
    procurement: ['pharmacy:procurement', 'reports:financial'],
    pharmacist: ['pharmacy:dispense', 'pharmacy:procurement'],
    'pharmacist-cashier': ['pharmacy:dispense', 'pharmacy:procurement'],
  },
  refund: {
    manager: ['pharmacy:manage', 'admin:access'],
    finance: ['finance:manage', 'admin:access'],
  },
};
const reviewerRefusal =
  'Ask a catalogue reviewer to decide this edit. When nobody else holds catalogue review permission, a pharmacy owner can approve it with their own approval code or PIN.';
function refusal(role: RoleKey, job: Job) {
  switch (job) {
    case 'prescription':
      if (role === 'owner' || role === 'cashier')
        return 'Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.';
      break;
    case 'controlled':
      if (role === 'owner' || role === 'cashier')
        return 'You do not have permission to dispense a controlled medicine.';
      break;
    case 'catalogue':
      return reviewerRefusal;
    case 'import':
      return role === 'owner'
        ? reviewerRefusal
        : 'Your role cannot open the catalogue queue. Ask a catalogue editor to submit the change or a catalogue reviewer to decide it.';
    case 'closeDay':
      return 'Day-close permission is required to reconcile and close a day.';
    case 'controlledReturn':
      if (role === 'owner') return 'Permission to change controlled stock is required.';
      break;
  }
  return 'You do not have permission for this action.';
}
describe.skipIf(!databaseUrl)('built-in pharmacy roles', () => {
  beforeAll(async () => {
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    await assertRlsEnforcingRole(withPlatformDb);
    const [connection] = await withPlatformDb(
      (db) =>
        db.$queryRaw<
          { major: number; rolcreaterole: boolean }[]
        >`SELECT current_setting('server_version_num')::int/10000 AS major,rolcreaterole FROM pg_roles WHERE rolname=current_user`
    );
    expect(connection).toEqual({ major: 16, rolcreaterole: false });
  });
  it('covers every shipped template', () =>
    expect(roles.toSorted()).toEqual(PHARMACY_ROLE_TEMPLATES.map((t) => t.key).sort()));
  describe.each(roles)('%s', (role) => {
    let fixture: PharmacyFixture;
    let run: ReturnType<typeof tasks>;
    beforeAll(async () => {
      const { setupRole } = await import('./pharmacy-role-tasks.fixture');
      fixture = await setupRole(role);
      run = (await import('./pharmacy-role-tasks.jobs')).tasks(fixture);
    }, 60_000);
    afterAll(async () => {
      if (!fixture) return;
      const { retirePharmacyRegulatoryRules } =
        await import('@/lib/test-support/pharmacy-regulatory');
      const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
      await retirePharmacyRegulatoryRules(withPlatformDb, [fixture.rulesId]);
    });
    it.each(jobs)(
      '%s',
      async (job) => {
        const gates = compoundGates[job]?.[role];
        if (gates) {
          const [held, missing] = gates;
          expect(fixture.names(held), held).toBe(true);
          // Shipped Finance grants themselves also require the tenant ADMIN role.
          expect(await fixture.holds(held), held).toBe(role !== 'finance');
          expect(await fixture.holds(missing), missing).toBe(false);
        }
        const attempt = run[job]();
        if (duties[role].includes(job)) await attempt;
        else
          await expect(attempt).rejects.toMatchObject({
            code: 'FORBIDDEN',
            message: refusal(role, job),
          });
      },
      30_000
    );
  });
});
