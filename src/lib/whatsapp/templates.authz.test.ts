import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateText: vi.fn(), routeAI: vi.fn() }));
vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('@/lib/ai/router', () => ({ routeAI: mocks.routeAI }));

import { draftWhatsAppTemplate, type WhatsAppTemplatePorts } from './templates';

describe('WhatsApp template central authorization', () => {
  beforeEach(() => vi.resetAllMocks());

  it('honors an explicit user DENY over a role ALLOW', async () => {
    const db = {
      user: {
        findUnique: vi.fn(async () => ({
          organizationRole: {
            permissions: [{ capability: 'customers:manage', effect: 'ALLOW' }],
          },
          permissionOverrides: [{ capability: 'customers:manage', effect: 'DENY' }],
        })),
      },
    };
    const ports = {
      hasConfiguredProviderSecret: vi.fn(async () => true),
    } as unknown as WhatsAppTemplatePorts;

    await expect(
      draftWhatsAppTemplate(
        {
          organizationId: 'org-abbasi',
          actor: { id: 'pharmacist-1', role: 'ADMIN', status: 'ACTIVE' },
          db,
        },
        { kind: 'OFFER' },
        ports
      )
    ).rejects.toThrow('Forbidden');

    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pharmacist-1' } })
    );
    expect(ports.hasConfiguredProviderSecret).not.toHaveBeenCalled();
    expect(mocks.routeAI).not.toHaveBeenCalled();
  });
});
