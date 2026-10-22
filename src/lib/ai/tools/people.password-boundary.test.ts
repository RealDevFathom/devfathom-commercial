import { describe, expect, it, vi } from 'vitest';
const PASSWORD_CANARY = 'PASSWORD_HASH_CANARY_413';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
import { buildPeopleTools } from './people';
import type { AssistantHelpers } from '@/lib/ai/context';
const stored = { id: 'user_1', name: 'Canary User', email: 'canary@example.com', phone: null, title: 'Engineer', department: 'ENGINEERING', role: 'EMPLOYEE', status: 'ACTIVE', skills: ['TypeScript'], bio: null, startDate: new Date('2026-01-01'), projectMembers: [], password: PASSWORD_CANARY };
const project = (select: Record<string, unknown>) => Object.fromEntries(Object.keys(select).map((key) => [key, stored[key as keyof typeof stored]]));
function tools() {
  const db = { user: { findMany: vi.fn(async ({ select }) => [project(select)]), findUnique: vi.fn(async ({ select }) => project(select)) }, task: { findMany: vi.fn(async () => []) }, leaveRequest: { findMany: vi.fn(async () => []) } };
  const helpers = { db, isAdmin: true, isHr: false, isAdminOrHr: true, ctx: { userId: 'admin_1', name: 'Admin' }, resolvePerson: vi.fn(async () => ({ kind: 'found', value: { id: 'user_1', name: 'Canary User' } })), taskVisibility: vi.fn(() => ({})), DONE_COLUMNS: ['Done'], now: vi.fn(() => new Date('2026-10-21')), can: vi.fn(async () => true), audit: vi.fn(), activity: vi.fn(), notifyUsers: vi.fn() } as unknown as AssistantHelpers;
  return { db, tools: buildPeopleTools(helpers) as unknown as Record<string, { execute: (input: Record<string, unknown>) => Promise<unknown> }> };
}
describe('AI people tool response boundaries', () => {
  it.each([['listTeam', {}], ['getTeamMember', { name: 'Canary User' }]])('%s never makes a stored password hash model-visible', async (name, input) => {
    const fixture = tools(); const result = await fixture.tools[name]!.execute(input);
    expect(JSON.stringify(result)).not.toContain(PASSWORD_CANARY);
    for (const query of [fixture.db.user.findMany, fixture.db.user.findUnique]) for (const [args] of query.mock.calls) expect(args.select).not.toHaveProperty('password');
  });
});
