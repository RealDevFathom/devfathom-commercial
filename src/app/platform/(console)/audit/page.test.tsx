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
            actorPlatformUser: {
              name: 'Staging Administrator',
              email: 'admin.staging@devfathom.com',
            },
            actorTenantUser: null,
            targetType: 'OrganizationModule',
            targetId: 'module-1',
            success: true,
            error: null,
            reason: null,
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

  it('shows a readable tenant actor while retaining the immutable actor ID', async () => {
    const actorId = 'tenant-user-1';
    const db = {
      platformAuditLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'audit-tenant-actor',
            createdAt: new Date('2026-08-08T05:00:00Z'),
            action: 'organization.update',
            organization: { displayName: 'DevFathom' },
            actorPlatformUserId: null,
            actorTenantUserId: actorId,
            actorPlatformUser: null,
            actorTenantUser: {
              name: 'Tenant Administrator',
              email: 'tenant.admin@devfathom.com',
            },
            targetType: 'Organization',
            targetId: 'organization-1',
            success: true,
            error: null,
            reason: null,
          },
        ]),
      },
    };
    mocks.withPlatformDb.mockImplementation((run: (database: typeof db) => Promise<unknown>) =>
      run(db)
    );

    render(await PlatformAuditPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Tenant Administrator')).toBeInTheDocument();
    expect(screen.getByText('tenant.admin@devfathom.com')).toBeInTheDocument();
    expect(screen.getByTitle(`Actor ID: ${actorId}`)).toHaveTextContent(actorId);
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
        actorPlatformUser: null,
        actorTenantUser: null,
        targetType: 'Organization',
        targetId: 'org-1',
        success: true,
        reason: '=HYPERLINK("https://example.invalid")',
        error: null,
      }))
    );
    mocks.withPlatformDb.mockImplementation((run) => run({ platformAuditLog: { findMany } }));
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

  it('searches both actor IDs and actor relations by name and email', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.withPlatformDb.mockImplementation((run) => run({ platformAuditLog: { findMany } }));

    render(await PlatformAuditPage({ searchParams: Promise.resolve({ q: 'administrator' }) }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          organization: { select: { displayName: true } },
          actorPlatformUser: { select: { name: true, email: true } },
          actorTenantUser: { select: { name: true, email: true } },
        },
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { actorPlatformUserId: { contains: 'administrator', mode: 'insensitive' } },
            { actorTenantUserId: { contains: 'administrator', mode: 'insensitive' } },
            {
              actorPlatformUser: {
                is: {
                  OR: [
                    { name: { contains: 'administrator', mode: 'insensitive' } },
                    { email: { contains: 'administrator', mode: 'insensitive' } },
                  ],
                },
              },
            },
            {
              actorTenantUser: {
                is: {
                  OR: [
                    { name: { contains: 'administrator', mode: 'insensitive' } },
                    { email: { contains: 'administrator', mode: 'insensitive' } },
                  ],
                },
              },
            },
          ]),
        }),
      })
    );
    expect(screen.getByLabelText('Search')).toHaveAttribute(
      'placeholder',
      'Search actor, action, target, or reason'
    );
    expect(screen.getByLabelText('Outcome')).toBeInTheDocument();
  });

  it('falls back to an unresolved actor ID instead of calling it anonymous', async () => {
    const actorId = 'deleted-actor-id';
    const db = {
      platformAuditLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'audit-1',
            createdAt: new Date('2026-08-08T05:00:00Z'),
            action: 'platform.session.created',
            organization: null,
            actorPlatformUserId: actorId,
            actorTenantUserId: null,
            actorPlatformUser: null,
            actorTenantUser: null,
            targetType: 'PlatformSession',
            targetId: 'session-1',
            success: true,
            error: null,
            reason: null,
          },
        ]),
      },
    };
    mocks.withPlatformDb.mockImplementation((run) => run(db));

    render(await PlatformAuditPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTitle(`Actor ID: ${actorId}`)).toHaveTextContent(actorId);
    expect(screen.queryByText('Anonymous')).not.toBeInTheDocument();
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
