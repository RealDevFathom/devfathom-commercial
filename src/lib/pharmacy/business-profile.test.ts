import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), model: vi.fn() }));
vi.mock('ai', () => ({ generateText: mocks.generate }));
vi.mock('@/lib/ai/provider', () => ({ createAIModel: mocks.model }));
import { draftBusinessReviewReply } from './business-profile';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.model.mockReturnValue({ model: 'test-model' });
  mocks.generate.mockResolvedValue({
    text: 'Thank you for your feedback. We hope to see you again.',
  });
});

it('generates an unapproved draft and never represents it as posted', async () => {
  const result = await draftBusinessReviewReply({
    rating: 5,
    review: 'Helpful team.',
    tone: 'WARM',
  });
  expect(result).toEqual({
    available: true,
    draft: 'Thank you for your feedback. We hope to see you again.',
    posted: false,
    approved: false,
  });
  expect(mocks.generate.mock.calls[0][0].system).toContain('manual posting are mandatory');
  expect(mocks.generate.mock.calls[0][0]).not.toHaveProperty('tools');
});

it('rejects invalid ratings and extra customer data before provider use', async () => {
  await expect(
    draftBusinessReviewReply({
      rating: 6,
      review: 'Okay',
      tone: 'FORMAL',
      phone: 'private',
    } as never)
  ).rejects.toThrow();
  expect(mocks.generate).not.toHaveBeenCalled();
});

it('returns an honest unavailable state without leaking provider failures', async () => {
  mocks.generate.mockRejectedValue(new Error('provider secret'));
  expect(
    await draftBusinessReviewReply({ rating: 2, review: 'Long wait.', tone: 'FORMAL' })
  ).toEqual({
    available: false,
    draft: null,
    posted: false,
    approved: false,
  });
});
