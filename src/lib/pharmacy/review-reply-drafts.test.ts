import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  tenantDb: vi.fn(),
  medicines: vi.fn(),
  aliases: vi.fn(),
  ingredients: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/ai/router', () => ({ routeAI: mocks.route }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: mocks.tenantDb }));
import { draftReviewReply } from './review-reply-drafts';
import { templateReviewReply } from './business-profile-health';

const context = { organizationId: 'org-a', branchId: 'branch-a', aiEnabled: true };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.route.mockResolvedValue({ text: 'Thank you for the lovely feedback.' });
  mocks.medicines.mockResolvedValue([{ productName: 'Panadol Extra 500mg', brandName: 'Panadol' }]);
  mocks.aliases.mockResolvedValue([]);
  mocks.ingredients.mockResolvedValue([{ name: 'Paracetamol' }]);
  mocks.tenantDb.mockReturnValue({
    medicine: { findMany: mocks.medicines },
    medicineAlias: { findMany: mocks.aliases },
    ingredient: { findMany: mocks.ingredients },
  });
});

it('sends only rating band and tone, adds the name locally, and never posts', async () => {
  const result = await draftReviewReply(
    { rating: 5, tone: 'FRIENDLY', reviewerFirstName: 'Sara' },
    context
  );
  expect(result).toEqual({
    body: 'Hi Sara, Thank you for the lovely feedback.',
    source: 'AI',
    approved: false,
    posted: false,
  });
  const args = mocks.route.mock.calls[0][0];
  expect(args.prompt).toBe('Review sentiment: POSITIVE. Tone: FRIENDLY.');
  expect(JSON.stringify(args)).not.toContain('Sara');
  expect(args.maxRetries).toBe(0);
});

it('falls back to the reviewed template when AI is off, without calling the provider', async () => {
  const result = await draftReviewReply(
    { rating: 1, tone: 'FORMAL' },
    { ...context, aiEnabled: false }
  );
  expect(result).toMatchObject({ source: 'TEMPLATE', posted: false });
  expect(result.body).toBe(templateReviewReply({ rating: 1, tone: 'FORMAL' }));
  expect(mocks.route).not.toHaveBeenCalled();
});

it.each(['Hope the Panadol worked for you.', 'Glad your prescription was ready.'])(
  'discards an AI draft that names a medicine or clinical detail: %s',
  async (text) => {
    mocks.route.mockResolvedValue({ text });
    const result = await draftReviewReply({ rating: 4, tone: 'FRIENDLY' }, context);
    expect(result).toMatchObject({ source: 'TEMPLATE' });
    expect(result.body).not.toMatch(/panadol|prescription/i);
  }
);

it('hides provider errors and drops a reviewer name that is a medicine', async () => {
  mocks.route.mockRejectedValue(new Error('secret provider context'));
  const result = await draftReviewReply(
    { rating: 3, tone: 'FRIENDLY', reviewerFirstName: 'Panadol' },
    context
  );
  expect(result.body).toBe(templateReviewReply({ rating: 3, tone: 'FRIENDLY' }));
  expect(JSON.stringify(result)).not.toContain('secret');
});
