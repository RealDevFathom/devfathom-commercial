import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PlatformAuditPage from './page';

const mocks = vi.hoisted(() => ({ withPlatformDb: vi.fn() }));

vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));

describe('PlatformAuditPage', () => {
  it('shows a readable actor while retaining the immutable actor ID', async () => {
    const actorId = 'cmscwkkoa00002pcf38o7dx54';
    const db = {
      platformAuditLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'audit-1',
            createdAt: new Date('2026-08-08T05:00:00Z'),
            action: 'organization.module',
            organization: { displayName: 'DevFathom' },
            actorPlatformUserId: actorId,
            actorTenantUserId: null,
            targetType: 'OrganizationModule',
            targetId: 'module-1',
            success: true,
            error: null,
            reason: null,
          },
        ]),
      },
      platformUser: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: actorId,
            name: 'Staging Administrator',
            email: 'admin.staging@devfathom.com',
          },
        ]),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mocks.withPlatformDb.mockImplementation((run: (database: typeof db) => Promise<unknown>) =>
      run(db)
    );

    render(await PlatformAuditPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Staging Administrator')).toBeInTheDocument();
    expect(screen.getByText('admin.staging@devfathom.com')).toBeInTheDocument();
    expect(screen.getByTitle(`Actor ID: ${actorId}`)).toHaveTextContent(actorId);
  });
});
