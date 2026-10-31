import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PlatformAuditPage from './page';

const mocks = vi.hoisted(() => ({
  requirePlatformRead: vi.fn().mockResolvedValue({ role: 'SUPER_ADMIN' }),
  withPlatformDb: vi.fn(),
}));

vi.mock('@/lib/platform/page-access', () => ({
  requirePlatformRead: mocks.requirePlatformRead,
}));
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
    };
    mocks.withPlatformDb.mockImplementation((run: (database: typeof db) => Promise<unknown>) =>
      run(db)
    );

    render(await PlatformAuditPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Staging Administrator')).toBeInTheDocument();
    expect(screen.getByText('admin.staging@devfathom.com')).toBeInTheDocument();
    expect(screen.getByTitle(`Actor ID: ${actorId}`)).toHaveTextContent(actorId);
    expect(screen.getByRole('region', { name: 'Audit records' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('link', { name: 'Export this page (CSV)' })).toHaveAttribute(
      'download',
      'platform-audit.csv'
    );
  });

  it('combines filters and stable pagination while escaping exported formulas', async () => {
    const createdAt = new Date('2026-09-20T12:00:00Z');
    const findMany = vi.fn().mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({
        id: `audit-${String(101 - i).padStart(3, '0')}`,
        createdAt,
        action: 'organization.update',
        organizationId: 'org-1',
        organization: { displayName: 'Example' },
        actorPlatformUserId: null,
        actorTenantUserId: null,
        targetType: 'Organization',
        targetId: 'org-1',
        success: true,
        reason: '=HYPERLINK("https://example.invalid")',
        error: null,
      }))
    );
    const platformActors = vi.fn().mockResolvedValue([{ id: 'platform-match' }]);
    const tenantActors = vi.fn().mockResolvedValue([{ id: 'tenant-match' }]);
    mocks.withPlatformDb.mockImplementation((run) =>
      run({
        platformAuditLog: { findMany },
        platformUser: { findMany: platformActors },
        user: { findMany: tenantActors },
      })
    );
    const cursor = Buffer.from(JSON.stringify({ createdAt, id: 'audit-999' })).toString(
      'base64url'
    );
    render(
      await PlatformAuditPage({
        searchParams: Promise.resolve({
          q: 'update',
          org: 'org-1',
          actor: 'actor-1',
          action: 'organization.update',
          outcome: 'success',
          from: '2026-09-20',
          through: '2026-09-20',
          cursor,
        }),
      })
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        where: expect.objectContaining({
          organizationId: 'org-1',
          action: 'organization.update',
          success: true,
          createdAt: { gte: new Date('2026-09-20'), lt: new Date('2026-09-21') },
          AND: [
            { OR: [{ actorPlatformUserId: 'actor-1' }, { actorTenantUserId: 'actor-1' }] },
            { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'audit-999' } }] },
          ],
          OR: expect.arrayContaining([{ action: { contains: 'update', mode: 'insensitive' } }]),
        }),
      })
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { actorPlatformUserId: { in: ['platform-match'] } },
            { actorTenantUserId: { in: ['tenant-match'] } },
          ]),
        }),
      })
    );
    for (const actors of [platformActors, tenantActors]) {
      expect(actors).toHaveBeenCalledWith({
        where: {
          OR: [
            { name: { contains: 'update', mode: 'insensitive' } },
            { email: { contains: 'update', mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
    }
    expect(screen.getByLabelText('Search')).toHaveAttribute(
      'placeholder',
      'Search actor, action, target, or reason'
    );
    expect(screen.getByLabelText('Outcome')).toBeInTheDocument();
    expect(screen.getByText('100 records on this page. Dates use UTC.')).toBeInTheDocument();
    const older = new URL(
      screen.getByRole('link', { name: 'Older records' }).getAttribute('href')!,
      'http://localhost'
    );
    expect(older.searchParams.get('org')).toBe('org-1');
    expect(
      JSON.parse(Buffer.from(older.searchParams.get('cursor')!, 'base64url').toString())
    ).toEqual({
      createdAt: createdAt.toISOString(),
      id: 'audit-002',
    });
    const csv = decodeURIComponent(
      screen.getByRole('link', { name: 'Export this page (CSV)' }).getAttribute('href')!
    );
    expect(csv).toContain(`'` + '=HYPERLINK(""https://example.invalid"")');
    expect(csv).toContain('audit-002');
    expect(csv).not.toContain('audit-001');
  });

  it.each([true, false])(
    'keeps platform actor precedence when that account exists: %s',
    async (exists) => {
      const platformActor = {
        id: 'platform-actor',
        name: 'Platform Operator',
        email: 'platform@example.test',
      };
      const tenantActor = {
        id: 'tenant-actor',
        name: 'Tenant Operator',
        email: 'tenant@example.test',
      };
      const findMany = vi.fn().mockResolvedValue([
        {
          id: 'historical-support',
          createdAt: new Date('2026-09-20T12:00:00Z'),
          action: 'support.enter',
          actorPlatformUserId: platformActor.id,
          actorTenantUserId: tenantActor.id,
          success: true,
        },
      ]);
      mocks.withPlatformDb.mockImplementation((run) =>
        run({
          platformAuditLog: { findMany },
          platformUser: { findMany: vi.fn().mockResolvedValue(exists ? [platformActor] : []) },
          user: { findMany: vi.fn().mockResolvedValue([tenantActor]) },
        })
      );

      render(await PlatformAuditPage({ searchParams: Promise.resolve({}) }));
      expect(screen.getByTitle(`Actor ID: ${platformActor.id}`)).toHaveTextContent(
        platformActor.id
      );
      expect(screen.queryByText(tenantActor.name)).not.toBeInTheDocument();
      expect(screen.queryByText(tenantActor.email)).not.toBeInTheDocument();
      expect(
        screen.getByText(exists ? platformActor.name : 'Deleted or unavailable actor')
      ).toBeInTheDocument();
    }
  );

  it('shows the tenant identity when it is the only actor', async () => {
    const actor = { id: 'tenant-only', name: 'Tenant Operator', email: 'tenant@example.test' };
    mocks.withPlatformDb.mockImplementation((run) =>
      run({
        platformAuditLog: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'tenant-audit',
              createdAt: new Date('2026-09-20T12:00:00Z'),
              actorPlatformUserId: null,
              actorTenantUserId: actor.id,
              action: 'tenant.update',
              success: true,
            },
          ]),
        },
        user: { findMany: vi.fn().mockResolvedValue([actor]) },
      })
    );
    render(await PlatformAuditPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(actor.name)).toBeInTheDocument();
    expect(screen.getByText(actor.email)).toBeInTheDocument();
    expect(screen.getByTitle(`Actor ID: ${actor.id}`)).toHaveTextContent(actor.id);
  });

  it.each([
    { from: '2026-02-30' },
    { cursor: 'broken' },
    { from: '2026-09-22', through: '2026-09-20' },
  ])('fails closed for invalid filters %j', async (query) => {
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.withPlatformDb.mockImplementation((run) => run({ platformAuditLog: { findMany } }));
    render(await PlatformAuditPage({ searchParams: Promise.resolve(query) }));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: [] } }) })
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid date range or pagination cursor');
    expect(screen.queryByRole('link', { name: 'Export this page (CSV)' })).not.toBeInTheDocument();
  });

  it('checks authorization before querying or exporting', async () => {
    mocks.withPlatformDb.mockClear();
    mocks.requirePlatformRead.mockRejectedValueOnce(new Error('denied'));
    await expect(PlatformAuditPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'denied'
    );
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
    expect(mocks.requirePlatformRead).toHaveBeenLastCalledWith('/platform/audit');
  });
});
