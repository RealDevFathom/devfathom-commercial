import { beforeEach, describe, expect, it, vi } from 'vitest';

const PASSWORD_CANARY = 'PASSWORD_HASH_CANARY_413';
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), can: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true), resolveOrganizationEntitlements: vi.fn() }));
vi.mock('@/server/audit', () => ({ ipFromHeaders: vi.fn(() => null), isAuditExcludedPath: vi.fn(() => true), recordTrpcAudit: vi.fn(), annotateAudit: vi.fn(), diffChanges: vi.fn(() => ({})) }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: { accountDeactivated: vi.fn(() => ({ subject: '', html: '', text: '' })) } }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/abac', async () => ({ ...(await vi.importActual('@/lib/abac')), can: mocks.can }));

import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';

const stored = { id: 'member_1', name: 'Canary User', email: 'canary@example.com', role: 'EMPLOYEE', status: 'ACTIVE', password: PASSWORD_CANARY };
const project = (args: { select?: Record<string, unknown> }) => Object.fromEntries(Object.keys(args.select ?? {}).map((key) => [key, stored[key as keyof typeof stored]]));
const caller = () => router({ team: teamRouter }).createCaller({
  db: { user: { findUnique: mocks.findUnique, update: mocks.update, count: mocks.count }, organizationDepartment: { findFirst: vi.fn() } },
  entitlements: { enabledModules: ['hr'], modules: [], activeSeats: 1, seatLimit: 10 },
  session: { expires: 'later', user: { id: 'admin_1', name: 'Admin', role: 'ADMIN', status: 'ACTIVE' } },
  organization: null, support: null, requestMeta: { ip: null, userAgent: null }, audit: { detail: {} },
} as unknown as TRPCContext).team;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockImplementation(async (args) => project(args));
  mocks.update.mockImplementation(async (args) => project(args));
  mocks.can.mockResolvedValue(true);
});

describe('team mutation serialization boundary', () => {
  it.each([
    ['adminUpdateMember', () => caller().adminUpdateMember({ id: 'member_1', title: 'Principal' })],
    ['layOffMember', () => caller().layOffMember({ id: 'member_1', reason: 'Position eliminated' })],
  ])('%s never serializes a stored password hash', async (_name, invoke) => {
    const response = await invoke();
    expect(JSON.stringify(response)).not.toContain(PASSWORD_CANARY);
    expect(response).not.toHaveProperty('password');
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({
      select: expect.not.objectContaining({ password: expect.anything() }),
    }));
  });
});
