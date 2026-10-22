import { beforeEach, describe, expect, it, vi } from 'vitest';

const PASSWORD_CANARY = 'PASSWORD_HASH_CANARY_413';
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), role: 'ADMIN' }));
vi.mock('@/lib/api-auth', () => ({ withApiAuth: (_scope: string, handler: (ctx: unknown) => Promise<Response>) => () => handler({ userRole: mocks.role, db: { user: { findMany: mocks.findMany } } }) }));
vi.mock('@/lib/authz', () => ({ isAdmin: (role: string) => role === 'ADMIN' }));
import { GET } from './route';
const stored = { id: 'user_1', name: 'Canary User', email: 'canary@example.com', role: 'EMPLOYEE', title: 'Engineer', avatar: null, department: 'ENGINEERING', phone: null, bio: null, skills: [], status: 'ACTIVE', startDate: new Date('2026-01-01'), password: PASSWORD_CANARY };
beforeEach(() => { vi.clearAllMocks(); mocks.findMany.mockImplementation(async ({ select }) => [Object.fromEntries(Object.keys(select).map((key) => [key, stored[key as keyof typeof stored]]))]); });
describe('/api/v1/team response boundary', () => {
  it.each(['ADMIN', 'EMPLOYEE'])('never serializes a password hash for a %s token', async (role) => {
    mocks.role = role;
    const response = await GET(new Request('https://example.test/api/v1/team'));
    const serialized = await response.text();
    expect(serialized).not.toContain(PASSWORD_CANARY);
    expect(JSON.parse(serialized).data[0]).not.toHaveProperty('password');
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ password: expect.anything() }) }));
  });
});
