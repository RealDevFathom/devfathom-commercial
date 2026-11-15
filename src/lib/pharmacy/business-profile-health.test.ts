import { expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_HEALTH_CONFIG,
  evaluateProfileHealth,
  greetReviewer,
  isSafeReviewReply,
  reviewReplyInput,
  reviewSentiment,
  templateReviewReply,
} from './business-profile-health';

const complete = {
  primaryCategoryIsPharmacy: true,
  phoneListed: true,
  websiteOrOrderLinkListed: true,
  descriptionPresent: true,
  holidayHoursSet: true,
  hoursConfirmedDaysAgo: 10,
  photoCount: 12,
  unansweredReviews: 0,
};

it('passes a complete profile with the default starting thresholds', () => {
  const result = evaluateProfileHealth({ facts: complete, config: DEFAULT_PROFILE_HEALTH_CONFIG });
  expect(result).toMatchObject({ passed: 8, total: 8 });
});

it('flags gaps and applies configured thresholds instead of hardcoded ones', () => {
  const facts = { ...complete, photoCount: 5, hoursConfirmedDaysAgo: 120, unansweredReviews: 3 };
  const strict = evaluateProfileHealth({ facts, config: DEFAULT_PROFILE_HEALTH_CONFIG });
  expect(strict.items.filter((item) => !item.ok).map((item) => item.key)).toEqual([
    'hours',
    'photos',
    'reviews',
  ]);
  const relaxed = evaluateProfileHealth({
    facts,
    config: { maximumHoursAgeDays: 180, minimumPhotos: 5, maximumUnansweredReviews: 3 },
  });
  expect(relaxed.passed).toBe(8);
  expect(relaxed.items.find((item) => item.key === 'photos')?.label).toBe('At least 5 photos');
});

it('treats unknown hours confirmation as needing attention', () => {
  const result = evaluateProfileHealth({
    facts: { ...complete, hoursConfirmedDaysAgo: null },
    config: DEFAULT_PROFILE_HEALTH_CONFIG,
  });
  expect(result.items.find((item) => item.key === 'hours')?.ok).toBe(false);
});

it('maps ratings to sentiment bands and safe template replies', () => {
  expect([1, 2, 3, 4, 5].map(reviewSentiment)).toEqual([
    'NEGATIVE',
    'NEGATIVE',
    'MIXED',
    'POSITIVE',
    'POSITIVE',
  ]);
  for (const rating of [1, 3, 5])
    for (const tone of ['FRIENDLY', 'FORMAL'] as const)
      expect(isSafeReviewReply(templateReviewReply({ rating, tone }))).toBe(true);
});

it('rejects clinical vocabulary and unsafe reviewer names', () => {
  expect(isSafeReviewReply('Glad your prescription was ready.')).toBe(false);
  expect(isSafeReviewReply('Thanks, we hope the medicine helped.')).toBe(false);
  expect(isSafeReviewReply('Thank you for visiting.')).toBe(true);
  expect(
    reviewReplyInput.safeParse({ rating: 5, tone: 'FRIENDLY', reviewerFirstName: 'a@b' }).success
  ).toBe(false);
  expect(reviewReplyInput.safeParse({ rating: 6, tone: 'FRIENDLY' }).success).toBe(false);
  expect(greetReviewer('Thanks.', 'FORMAL', 'Sara')).toBe('Dear Sara, Thanks.');
});
