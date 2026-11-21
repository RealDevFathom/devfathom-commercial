// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GET as listClients } from './clients/route';
import { GET as getClient } from './clients/[id]/route';
import { GET as getInvoice } from './invoices/[id]/route';
import { GET as getProject } from './projects/[id]/route';
import type { ApiContext } from '@/lib/api-auth';

// Inject an authenticated context while keeping the production scope and entitlement checks.
const { current } = vi.hoisted(() => ({ current: {} as ApiContext }));
vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  withApiAuth:
    <Args extends unknown[]>(
      _scope: string,
      handler: (ctx: ApiContext, ...args: Args) => Promise<Response>
    ) =>
    (...args: Args) =>
      handler(current, ...args),
}));

const request = new Request('https://example.test/');
const params = { params: Promise.resolve({ id: 'fixture' }) };
const summary = { select: { id: true, name: true } };

function fixture(scopes: string[], enabledModules: string[], userRole = 'ADMIN') {
  const client = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue({ id: 'fixture' }),
  };
  const project = { findUnique: vi.fn().mockResolvedValue({ id: 'fixture' }) };
  const invoice = { findUnique: vi.fn().mockResolvedValue({ id: 'fixture' }) };
  const projectMember = { findUnique: vi.fn().mockResolvedValue({ role: 'MEMBER' }) };
  const db = { client, project, invoice, projectMember };
  Object.assign(current, {
    userId: 'member',
    userRole,
    scopes,
    entitlements: { enabledModules },
    db,
  });
  return db;
}

describe('API related-record projections', () => {
  it('selects only client id and name for a projects-only member', async () => {
    const db = fixture(['projects:read'], ['projects'], 'EMPLOYEE');
    expect((await getProject(request, params)).status).toBe(200);
    expect(db.project.findUnique.mock.calls[0][0].include.client).toEqual(summary);
  });

  it.each([
    { scope: 'clients:read', finance: true, include: false },
    { scope: 'finance:read', finance: false, include: false },
    { scope: '*', finance: false, include: false },
    { scope: 'finance:read', finance: true, include: true },
    { scope: 'finance:write', finance: true, include: true },
  ])(
    'client invoice fields for $scope with Finance enabled=$finance',
    async ({ scope, finance, include }) => {
      const db = fixture(['clients:read', scope], finance ? ['clients', 'finance'] : ['clients']);
      expect((await getClient(request, params)).status).toBe(200);
      expect((await listClients(request)).status).toBe(200);
      const detail = db.client.findUnique.mock.calls[0][0].include;
      const counts = db.client.findMany.mock.calls[0][0].include._count.select;
      expect(counts).toEqual(include ? { projects: true, invoices: true } : { projects: true });
      if (include) {
        expect(detail.invoices).toEqual({ orderBy: { createdAt: 'desc' } });
      } else {
        expect(detail).not.toHaveProperty('invoices');
      }
    }
  );

  it.each([
    { scopes: ['finance:read'], clients: true, full: false },
    { scopes: ['*'], clients: false, full: false },
    { scopes: ['finance:read', 'clients:read'], clients: true, full: true },
  ])(
    'invoice client projection for $scopes with Clients enabled=$clients',
    async ({ scopes, clients, full }) => {
      const db = fixture(scopes, clients ? ['finance', 'clients'] : ['finance']);
      expect((await getInvoice(request, params)).status).toBe(200);
      expect(db.invoice.findUnique.mock.calls[0][0].include.client).toEqual(
        full ? { include: { contacts: true } } : summary
      );
    }
  );
});
