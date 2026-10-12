import { findPakistanTaxProfile } from '@/lib/restaurant/pakistan-tax-profiles';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const DEFAULT_PROFILE_ID = 'PK-SD-RESTAURANT';
const DEFAULT_EFFECTIVE_FROM = new Date('2026-08-01T00:00:00.000Z');

/** Provision the accountant-approved Pakistan profile used by transaction fixtures. */
export async function ensureRestaurantTaxProfile(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  options: {
    effectiveFrom?: Date;
    priceMode?: 'INCLUSIVE' | 'EXCLUSIVE';
    profileId?: string;
  } = {}
) {
  const preset = findPakistanTaxProfile(options.profileId ?? DEFAULT_PROFILE_ID);
  if (!preset?.enabled || !preset.sourceContentHash) {
    throw new Error('The transaction fixture requires an enabled, source-pinned tax profile.');
  }

  const effectiveFrom = options.effectiveFrom ?? DEFAULT_EFFECTIVE_FROM;
  const priceMode = options.priceMode ?? 'INCLUSIVE';
  const activationIdempotencyKey = `test-tax:${branchId}:${preset.id}:${priceMode}:${effectiveFrom.toISOString()}`;
  const activationPayloadHash = createHash('sha256').update(activationIdempotencyKey).digest('hex');
  const existing = await db.restaurantTaxProfileVersion.findUnique({
    where: {
      organizationId_activationIdempotencyKey: { organizationId, activationIdempotencyKey },
    },
  });
  if (existing) return existing;

  const source = await db.restaurantTaxOfficialSource.upsert({
    where: {
      organizationId_contentHash: { organizationId, contentHash: preset.sourceContentHash },
    },
    update: {},
    create: {
      authorityCode: preset.authorityCode,
      documentTitle: preset.sourceTitle,
      sourceUrl: preset.sourceUrl,
      contentHash: preset.sourceContentHash,
      retrievedAt: DEFAULT_EFFECTIVE_FROM,
    },
  });
  const latest = await db.restaurantTaxProfileVersion.findFirst({
    where: { branchId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  });
  const approvalReference = `TEST_FIXTURE · ${preset.id}`;
  return db.restaurantTaxProfileVersion.create({
    data: {
      branchId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      status: 'PUBLISHED',
      effectiveFrom,
      approvalReference,
      approvedAt: effectiveFrom,
      publishedAt: effectiveFrom,
      presetId: preset.id,
      activationIdempotencyKey,
      activationPayloadHash,
      eligibilityEvidence: { accountantReviewed: true, fixture: true },
      rules: {
        create: preset.rules.map((rule) => ({
          ...rule,
          officialSourceId: source.id,
          priceMode,
          status: 'PUBLISHED' as const,
          effectiveFrom,
          approvalReference,
          approvedAt: effectiveFrom,
          publishedAt: effectiveFrom,
        })),
      },
    },
  });
}
import { createHash } from 'node:crypto';
