import { beforeEach, describe, expect, it, vi } from 'vitest';

const PASSWORD_CANARY = 'PASSWORD_HASH_CANARY_413';
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), record: vi.fn() }));
const stored = { id: 'user_1', name: 'Canary User', email: 'canary@example.com', role: 'EMPLOYEE', status: 'ACTIVE', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'), password: PASSWORD_CANARY };
const project = ({ select }: { select: Record<string, unknown> }) => Object.fromEntries(Object.keys(select).map((key) => [key, stored[key as keyof typeof stored]]));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/scim', async () => {
  const actual = await vi.importActual<typeof import('@/lib/scim')>('@/lib/scim');
  return { ...actual, recordScimEvent: mocks.record, withScimAuth: async (_request: Request, run: (ctx: unknown) => Promise<Response>) => run({ organizationId: 'org_1', tokenId: 'tok_1', db: { user: { findUnique: mocks.findUnique, findFirst: mocks.findFirst, update: mocks.update } } }) };
});

import { GET, PATCH, PUT } from './route';

const route = { params: Promise.resolve({ id: 'user_1' }) };
const request = (method: string, body?: unknown) => new Request('https://example.test/api/scim/v2/Users/user_1', { method, headers: { 'content-type': 'application/scim+json' }, body: body ? JSON.stringify(body) : undefined });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockImplementation(async (args) => project(args));
  mocks.findFirst.mockResolvedValue(null);
  mocks.update.mockImplementation(async (args) => project(args));
});

describe('SCIM individual user response boundary', () => {
  it.each([
    ['GET', () => GET(request('GET'), route)],
    ['PUT', () => PUT(request('PUT', { userName: 'canary@example.com', displayName: 'Canary User', active: true }), route)],
    ['PATCH', () => PATCH(request('PATCH', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'displayName', value: 'Canary User' }] }), route)],
  ])('%s never serializes a stored password hash', async (_method, invoke) => {
    const response = await invoke();
    const serialized = await response.text();
    expect(serialized).not.toContain(PASSWORD_CANARY);
    expect(JSON.parse(serialized)).not.toHaveProperty('password');
  });
});
