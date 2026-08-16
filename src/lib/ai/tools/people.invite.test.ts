/**
 * D20 — the assistant's `inviteMember` tool is a user-creation path too, so it
 * must refuse a differently-cased duplicate with a stated message rather than
 * letting the composite unique index surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  invitationUpsert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  sendEmail: vi.fn(),
  templates: { inviteMember: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })) },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));

import { buildPeopleTools } from './people';
import type { AssistantHelpers } from '@/lib/ai/context';

const db = {
  user: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update },
  invitation: { upsert: mocks.invitationUpsert },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      user: { create: mocks.create, update: mocks.update },
      invitation: { upsert: mocks.invitationUpsert },
    }),
};

function inviteTool() {
  const helpers = {
    db,
    isAdmin: true,
    isHr: false,
    isAdminOrHr: true,
    ctx: { userId: 'user_admin', name: 'Admin' },
    can: vi.fn(async () => true),
    audit: vi.fn(),
  } as unknown as AssistantHelpers;
  const tools = buildPeopleTools(helpers);
  return tools.inviteMember as unknown as {
    execute: (input: Record<string, unknown>) => Promise<{ error?: string }>;
  };
}

const base = {
  name: 'Alex Carter',
  department: 'ENGINEERING',
  title: 'Engineer',
  role: 'EMPLOYEE',
};

describe('assistant inviteMember duplicate guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});
  });

  it.each([['ALEX@COMPANY.COM'], ['Alex@Company.com'], ['  alex@company.com  ']])(
    'refuses %j when alex@company.com is already a member',
    async (email) => {
      mocks.findFirst.mockResolvedValue({ id: 'user_1', status: 'ACTIVE' });

      const result = await inviteTool().execute({ ...base, email });

      expect(result.error).toBe('A user with this email already exists.');
      expect(mocks.findFirst).toHaveBeenCalledWith({
        where: { email: 'alex@company.com' },
        select: { id: true, status: true },
      });
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

  it('stores the canonical form for a genuinely new member', async () => {
    mocks.findFirst.mockResolvedValue(null);

    await inviteTool().execute({ ...base, email: 'New.Person@Company.COM' });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'new.person@company.com' }),
      })
    );
  });
});
