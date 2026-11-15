import { z } from 'zod';

/**
 * Google Business Profile health checklist (DEV-13). The owner enters what the
 * profile currently shows; nothing is fetched from or posted to Google. The
 * thresholds are starting points from research, not facts: every one is
 * configurable per request and shown alongside its result.
 */
export const DEFAULT_PROFILE_HEALTH_CONFIG = Object.freeze({
  /** Days since opening hours were last confirmed before a re-check is suggested. */
  maximumHoursAgeDays: 90,
  /** Photos suggested as a starting point; adjust for the branch. */
  minimumPhotos: 10,
  /** Unanswered reviews tolerated before replying is flagged. */
  maximumUnansweredReviews: 0,
});

export const profileHealthConfigInput = z
  .object({
    maximumHoursAgeDays: z.number().int().min(1).max(365),
    minimumPhotos: z.number().int().min(0).max(500),
    maximumUnansweredReviews: z.number().int().min(0).max(1000),
  })
  .strict();

export const profileHealthFactsInput = z
  .object({
    primaryCategoryIsPharmacy: z.boolean(),
    phoneListed: z.boolean(),
    websiteOrOrderLinkListed: z.boolean(),
    descriptionPresent: z.boolean(),
    holidayHoursSet: z.boolean(),
    /** Null when the owner does not know when hours were last confirmed. */
    hoursConfirmedDaysAgo: z.number().int().min(0).max(3650).nullable(),
    photoCount: z.number().int().min(0).max(100_000),
    unansweredReviews: z.number().int().min(0).max(100_000),
  })
  .strict();

export const profileHealthInput = z
  .object({ facts: profileHealthFactsInput, config: profileHealthConfigInput })
  .strict();

export type ProfileHealthItem = {
  key: string;
  label: string;
  ok: boolean;
  advice: string;
};

export function evaluateProfileHealth(input: z.infer<typeof profileHealthInput>) {
  const { facts, config } = profileHealthInput.parse(input);
  const items: ProfileHealthItem[] = [
    {
      key: 'category',
      label: 'Primary category is Pharmacy',
      ok: facts.primaryCategoryIsPharmacy,
      advice: 'Set the primary category to Pharmacy so local searches can find the branch.',
    },
    {
      key: 'phone',
      label: 'Phone number listed',
      ok: facts.phoneListed,
      advice: 'Add the branch phone number customers should call.',
    },
    {
      key: 'link',
      label: 'Website or ordering link listed',
      ok: facts.websiteOrOrderLinkListed,
      advice: 'Add a website or ordering link.',
    },
    {
      key: 'description',
      label: 'Business description present',
      ok: facts.descriptionPresent,
      advice: 'Write a short retail description without medicine names or health claims.',
    },
    {
      key: 'hours',
      label: `Opening hours confirmed within ${config.maximumHoursAgeDays} days`,
      ok:
        facts.hoursConfirmedDaysAgo !== null &&
        facts.hoursConfirmedDaysAgo <= config.maximumHoursAgeDays,
      advice: 'Confirm the regular opening hours on the profile.',
    },
    {
      key: 'holiday',
      label: 'Holiday hours set',
      ok: facts.holidayHoursSet,
      advice: 'Add special hours for upcoming public holidays.',
    },
    {
      key: 'photos',
      label: `At least ${config.minimumPhotos} photos`,
      ok: facts.photoCount >= config.minimumPhotos,
      advice: 'Add storefront and interior photos. Avoid showing customers or medicine labels.',
    },
    {
      key: 'reviews',
      label: `At most ${config.maximumUnansweredReviews} unanswered reviews`,
      ok: facts.unansweredReviews <= config.maximumUnansweredReviews,
      advice: 'Draft replies below, review them, then post each one yourself on Google.',
    },
  ];
  return {
    items,
    passed: items.filter((item) => item.ok).length,
    total: items.length,
    config,
  };
}

export const REVIEW_REPLY_TONES = ['FRIENDLY', 'FORMAL'] as const;
export const reviewReplyInput = z
  .object({
    rating: z.number().int().min(1).max(5),
    tone: z.enum(REVIEW_REPLY_TONES),
    /** Optional first name added locally; it never reaches the AI provider. */
    reviewerFirstName: z
      .string()
      .trim()
      .max(40)
      .regex(/^[\p{L}][\p{L} .'-]*$/u)
      .optional(),
  })
  .strict();

export type ReviewSentiment = 'POSITIVE' | 'MIXED' | 'NEGATIVE';
export function reviewSentiment(rating: number): ReviewSentiment {
  return rating >= 4 ? 'POSITIVE' : rating === 3 ? 'MIXED' : 'NEGATIVE';
}

/**
 * Public review replies must never confirm that someone is a patient, mention
 * health information or name a medicine. This rejects clinical vocabulary;
 * tenant medicine names are checked separately on the server.
 */
export function isSafeReviewReply(body: string) {
  return !/prescri|condition|allerg|medic|diagnos|patient|drug|pill|tablet|dose|treat|symptom|illness|\brx\b/i.test(
    body
  );
}

const TEMPLATE_BODIES: Record<
  ReviewSentiment,
  Record<(typeof REVIEW_REPLY_TONES)[number], string>
> = {
  POSITIVE: {
    FRIENDLY:
      'Thank you so much for the kind words! Our team will be glad to hear it, and we look forward to seeing you again.',
    FORMAL:
      'Thank you for taking the time to share your feedback. We appreciate your support and look forward to serving you again.',
  },
  MIXED: {
    FRIENDLY:
      'Thanks for the feedback. We are glad some things went well and we want every visit to be great. Please call or visit the branch and ask for the manager so we can hear more.',
    FORMAL:
      'Thank you for your feedback. We aim to improve every visit. Please contact the branch and ask for the manager so we can learn more about your experience.',
  },
  NEGATIVE: {
    FRIENDLY:
      'We are sorry to hear this and appreciate you letting us know. Please call or visit the branch and ask for the manager so we can make it right.',
    FORMAL:
      'We regret that your experience did not meet expectations. Please contact the branch and ask for the manager so we can look into this privately.',
  },
};

/** Deterministic fallback when AI drafting is disabled or unavailable. */
export function templateReviewReply(input: { rating: number; tone: 'FRIENDLY' | 'FORMAL' }) {
  return TEMPLATE_BODIES[reviewSentiment(input.rating)][input.tone];
}

export function greetReviewer(body: string, tone: 'FRIENDLY' | 'FORMAL', firstName?: string) {
  if (!firstName) return body;
  return `${tone === 'FRIENDLY' ? 'Hi' : 'Dear'} ${firstName}, ${body}`;
}
