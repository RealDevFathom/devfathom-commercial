import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createTRPCContext: vi.fn(),
  isOwner: vi.fn(),
  list: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/server/trpc', () => ({ createTRPCContext: m.createTRPCContext }));
vi.mock('@/server/audit', () => ({ recordAudit: m.audit }));
vi.mock('@/lib/pharmacy/owner-data-export', () => ({
  isLiveOrganizationOwner: m.isOwner,
  listOwnerDataExports: m.list,
}));

import Page from './page';

const EXPORT = {
  id: 'job-1',
  status: 'SUCCEEDED',
  requestedAt: '2026-11-15T09:00:00.000Z',
  finishedAt: '2026-11-15T09:05:00.000Z',
  expiresAt: '2026-11-16T09:05:00.000Z',
  downloadable: true,
  rowCounts: { 'customers.csv': 3 },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.createTRPCContext.mockResolvedValue({
    session: { user: { id: 'u-owner', role: 'ADMIN', isSupportSession: false } },
    organization: { id: 'org-a' },
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'] },
    requestMeta: { ip: '127.0.0.1', userAgent: 'vitest' },
    db: {},
  });
  m.isOwner.mockResolvedValue(true);
  m.list.mockResolvedValue([EXPORT]);
  m.audit.mockResolvedValue(undefined);
});

describe('owner data export page (DEV-783)', () => {
  it('audits every opening of the export list', async () => {
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Your PIN');
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        actorId: 'u-owner',
        category: 'PHARMACY_DATA_EXPORT',
        action: 'pharmacy.dataExport.list',
        operation: 'READ',
        path: '/pharmacy/settings/data-export',
        statusCode: 200,
        outcome: 'SUCCESS',
        metadata: expect.objectContaining({ via: 'page', count: 1 }),
      }),
      expect.anything()
    );
  });

  it('hides the list when its audit cannot be written', async () => {
    m.audit.mockRejectedValue(new Error('audit down'));
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Your exports could not be shown');
    expect(html).not.toContain('Download ZIP');
    expect(html).not.toContain('Your PIN');
  });

  it('audits a refused visit by someone who is not the owner and lists nothing', async () => {
    m.isOwner.mockResolvedValue(false);
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Only the pharmacy owner can export all data');
    expect(m.list).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacy.dataExport.list',
        statusCode: 403,
        outcome: 'FAILURE',
      }),
      expect.anything()
    );
  });
});
