import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock('@/lib/email', () => ({ sendEmail: mocks.sendEmail }));

import { notify } from './notifications';

describe('generic demo notification sink', () => {
  beforeEach(() => mocks.sendEmail.mockReset().mockResolvedValue(undefined));

  it('keeps in-app rows while suppressing email for demo recipients', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const db = {
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'user_normal',
            name: 'Normal User',
            email: 'normal@example.test',
            status: 'ACTIVE',
            notificationPrefs: null,
            organization: { isDemo: false },
          },
          {
            id: 'user_demo',
            name: 'Demo User',
            email: 'customer-entered@example.test',
            status: 'ACTIVE',
            notificationPrefs: null,
            organization: { isDemo: true },
          },
        ]),
      },
      notification: { createMany },
    };

    notify(db as never, ['user_normal', 'user_demo'], {
      type: 'task_assigned',
      title: 'Assigned',
      message: 'A task was assigned.',
      email: (recipient) => ({
        subject: 'Assigned',
        html: `<p>${recipient.name}</p>`,
        text: recipient.name,
      }),
    });

    await vi.waitFor(() => expect(createMany).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.sendEmail).toHaveBeenCalledOnce());
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: 'user_normal' }),
        expect.objectContaining({ userId: 'user_demo' }),
      ],
    });
    expect(mocks.sendEmail.mock.calls[0]?.[0]?.to.email).toBe('normal@example.test');
  });
});
