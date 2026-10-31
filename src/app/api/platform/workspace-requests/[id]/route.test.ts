// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ actor: vi.fn(), allowed: vi.fn(), find: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ getPlatformSession: m.actor, canPlatform: m.allowed }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) => run({ platformLead: { findUnique: m.find } }),
}));
import { GET } from './route';
const params = { params: Promise.resolve({ id: 'lead' }) };
beforeEach(() => {
  vi.clearAllMocks();
  m.actor.mockResolvedValue({ role: 'SUPER_ADMIN' });
  m.allowed.mockReturnValue(true);
  m.find.mockResolvedValue({
    source: 'workspace-request:pharmacy',
    notes: JSON.stringify({
      details: { companyName: 'Pharmacy' },
      document: {
        type: 'application/pdf',
        name: 'licence.pdf',
        base64: Buffer.from('%PDF-evidence').toString('base64'),
      },
    }),
  });
});
it('does not expose intake or licence evidence to an anonymous or unauthorized caller', async () => {
  m.actor.mockResolvedValueOnce(null);
  expect(
    (
      await GET(
        new Request('https://admin.example.test/api/platform/workspace-requests/lead'),
        params
      )
    ).status
  ).toBe(403);
  m.allowed.mockReturnValueOnce(false);
  expect(
    (
      await GET(
        new Request('https://admin.example.test/api/platform/workspace-requests/lead'),
        params
      )
    ).status
  ).toBe(403);
  expect(m.find).not.toHaveBeenCalled();
});
it('delivers private evidence as an attachment and omits bytes from details JSON', async () => {
  const details = await GET(
    new Request('https://admin.example.test/api/platform/workspace-requests/lead'),
    params
  );
  expect(await details.json()).not.toHaveProperty('document');
  const doc = await GET(
    new Request('https://admin.example.test/api/platform/workspace-requests/lead?document=1'),
    params
  );
  expect(await doc.text()).toBe('%PDF-evidence');
  expect(doc.headers.get('content-disposition')).toContain('attachment');
  expect(doc.headers.get('cache-control')).toContain('no-store');
});
it('does not reinterpret ordinary lead notes as workspace intake', async () => {
  m.find.mockResolvedValue({ source: 'Direct', notes: '{}' });
  expect(
    (
      await GET(
        new Request('https://admin.example.test/api/platform/workspace-requests/lead'),
        params
      )
    ).status
  ).toBe(404);
});
