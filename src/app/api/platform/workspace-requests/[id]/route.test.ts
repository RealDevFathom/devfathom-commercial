// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ actor: vi.fn(), allowed: vi.fn(), find: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ getPlatformSession: m.actor, canPlatform: m.allowed }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) => run({ platformLead: { findUnique: m.find } }),
}));
import { syntheticLicencePdf } from '@/lib/workspace-requests/licence-test-fixtures';
import { GET } from './route';
const pdf = syntheticLicencePdf();
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
        name: 'legacy-sender-filename.jpg',
        base64: pdf.toString('base64'),
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
  expect(Buffer.from(await doc.arrayBuffer())).toEqual(pdf);
  expect(doc.headers.get('content-disposition')).toContain('attachment');
  expect(doc.headers.get('cache-control')).toContain('no-store');
  expect(doc.headers.get('content-disposition')).toBe('attachment; filename="licence.pdf"');
  expect(doc.headers.get('content-type')).toBe('application/pdf');
  expect(doc.headers.get('x-content-type-options')).toBe('nosniff');
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

it('withholds malformed legacy evidence while preserving its request details', async () => {
  m.find.mockResolvedValue({
    source: 'workspace-request:pharmacy',
    notes: JSON.stringify({
      details: { companyName: 'Pharmacy' },
      document: {
        type: 'application/pdf',
        name: 'legacy.pdf',
        base64: Buffer.from('%PDF-1.7\nEvidence').toString('base64'),
      },
    }),
  });
  const base = 'https://admin.example.test/api/platform/workspace-requests/lead';
  expect((await GET(new Request(base + '?document=1'), params)).status).toBe(404);
  expect((await GET(new Request(base), params)).status).toBe(200);
});
