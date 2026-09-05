import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  can: vi.fn(),
  hasModule: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('@/lib/receipts/restaurant-settings', () => ({
  listRestaurantReceiptLayouts: mocks.list,
  saveRestaurantReceiptLayout: mocks.save,
}));
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { GET, PUT } from './route';

const url = 'https://tenant.example/api/restaurant/receipt-layout';
const input = { branchId: 'branch-a', revision: 0, layout: DEFAULT_RECEIPT_LAYOUT };
function request(body: unknown = input, origin: string | null = 'https://tenant.example') {
  return new Request(url, {
    method: 'PUT',
    headers: origin ? { origin } : {},
    body: JSON.stringify(body),
  });
}
describe('receipt settings authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.context.mockResolvedValue({
      db: {},
      session: { user: { id: 'user-a', status: 'ACTIVE', organizationId: 'org-a' } },
      organization: { id: 'org-a' },
      entitlements: {},
      requestMeta: {},
    });
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
    mocks.list.mockResolvedValue([]);
    mocks.save.mockResolvedValue({ revision: 1, layout: DEFAULT_RECEIPT_LAYOUT });
  });
  it('loads settings and saves using server organization identity', async () => {
    expect((await GET(new Request(url))).status).toBe(200);
    expect((await PUT(request())).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({}, 'org-a', input);
  });
  it.each([null, 'https://attacker.example'])(
    'rejects missing/foreign origin %s before context',
    async (origin) => {
      expect((await PUT(request(input, origin))).status).toBe(403);
      expect(mocks.context).not.toHaveBeenCalled();
    }
  );
  it('denies capability and module failures on reads and writes', async () => {
    mocks.can.mockResolvedValue(false);
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await PUT(request())).status).toBe(403);
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(false);
    expect((await PUT(request())).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { status: 'ACTIVE', sessionRevoked: true },
    { status: 'INACTIVE' },
    { status: 'ACTIVE', organizationId: 'other' },
  ])('denies unusable or cross-tenant session %j', async (user) => {
    mocks.context.mockResolvedValue({
      session: { user },
      organization: { id: 'org-a' },
      requestMeta: {},
      entitlements: {},
    });
    expect([401, 403]).toContain((await PUT(request())).status);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects invalid payloads and hides internal errors', async () => {
    expect((await PUT(request({ ...input, organizationId: 'other' }))).status).toBe(400);
    expect(
      (await PUT(request({ ...input, layout: { ...DEFAULT_RECEIPT_LAYOUT, footerText: '\x1b@' } })))
        .status
    ).toBe(400);
    mocks.save.mockRejectedValue(new Error('secret connection details'));
    const response = await PUT(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
  });
});
