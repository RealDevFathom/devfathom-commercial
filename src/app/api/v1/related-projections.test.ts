// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
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
      const db = fixture(
        ['clients:read', 'projects:read', scope],
        finance ? ['clients', 'projects', 'finance'] : ['clients', 'projects']
      );
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
    {
      scopes: ['clients:read'],
      modules: ['clients', 'projects'],
      projects: false,
      invoices: false,
    },
    {
      scopes: ['clients:read', 'projects:read'],
      modules: ['clients'],
      projects: false,
      invoices: false,
    },
    {
      scopes: ['clients:read', 'finance:read'],
      modules: ['clients', 'finance', 'projects'],
      projects: false,
      invoices: true,
    },
    {
      scopes: ['clients:read', 'projects:read'],
      modules: ['clients', 'projects'],
      projects: true,
      invoices: false,
    },
  ])(
    'client project fields for $scopes with modules $modules',
    async ({ scopes, modules, projects, invoices }) => {
      const db = fixture(scopes, modules);
      expect((await getClient(request, params)).status).toBe(200);
      expect((await listClients(request)).status).toBe(200);
      const detail = db.client.findUnique.mock.calls[0][0].include;
      const list = db.client.findMany.mock.calls[0][0].include;
      if (projects) {
        expect(detail.projects).toEqual({ select: { id: true, name: true, status: true } });
        expect(list._count.select).toEqual({ projects: true });
      } else {
        expect(detail).not.toHaveProperty('projects');
        if (invoices) expect(list._count.select).toEqual({ invoices: true });
        else expect(list).not.toHaveProperty('_count');
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

const runtimeUrl = process.env.RUNTIME_DATABASE_URL;
it.runIf(runtimeUrl && runtimeUrl === process.env.DATABASE_URL)(
  'returns client project rows and counts only to callers with Projects access (PostgreSQL)',
  async () => {
    const organizationId = `projection_test_${randomUUID()}`;
    await withTenantDb(organizationId, async (db) => {
      await db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          legalName: 'Fixture',
          displayName: 'Fixture',
        },
      });
      const client = await db.client.create({ data: { name: 'Fixture client' } });
      const project = await db.project.create({
        data: { name: 'Fixture project', type: 'CLIENT', clientId: client.id },
      });
      Object.assign(current, {
        db,
        userRole: 'ADMIN',
        scopes: ['clients:read'],
        entitlements: { enabledModules: ['clients', 'projects'] },
      });
      const args = { params: Promise.resolve({ id: client.id }) };
      const detail = async () => (await (await getClient(request, args)).json()).data;
      const list = async () => (await (await listClients(request)).json()).data;
      const clientDetail = await detail();
      expect(clientDetail).toMatchObject({ id: client.id });
      expect(clientDetail).not.toHaveProperty('projects');
      const clients = await list();
      expect(clients).toHaveLength(1);
      expect(clients[0]).not.toHaveProperty('_count');
      current.scopes = ['clients:read', 'projects:read'];
      expect((await detail()).projects).toEqual([
        { id: project.id, name: project.name, status: project.status },
      ]);
      expect((await list())[0]._count).toEqual({ projects: 1 });

      await db.project.delete({ where: { id: project.id } });
      await db.client.delete({ where: { id: client.id } });
      await db.organization.delete({ where: { id: organizationId } });
    });
  }
);
