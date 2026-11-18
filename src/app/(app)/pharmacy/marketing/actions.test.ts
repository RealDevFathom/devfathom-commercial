import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  revalidate: vi.fn(),
  createDraft: vi.fn(),
  reviewGrowth: vi.fn(),
  generateGrowth: vi.fn(),
  generateBaskets: vi.fn(),
  reviewBasket: vi.fn(),
  approve: vi.fn(),
  sandbox: vi.fn(),
  preview: vi.fn(),
  profileHealth: vi.fn(),
  reviewReply: vi.fn(),
  issueVoucher: vi.fn(),
  revokeVoucher: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/routers/pharmacy-marketing', () => ({
  pharmacyMarketingRouter: { createCaller: () => mocks },
}));
import { marketingAction } from './actions';
function form(values: Record<string, string>) {
  const data = new FormData();
  Object.entries({ branchId: 'branch-a', ...values }).forEach(([key, value]) =>
    data.set(key, value)
  );
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());
it('passes configurable basket thresholds without accepting client evidence', async () => {
  mocks.generateBaskets.mockResolvedValue({ id: 'analysis-a', count: 1 });
  expect(
    await marketingAction(
      form({
        operation: 'basket-generate',
        from: '2026-10-01',
        cutoff: '2026-10-03',
        minimumPairCount: '2',
        minimumSupport: '0.3',
        minimumConfidence: '0.5',
        minimumLift: '1',
        maximumProposals: '3',
        productIds: 'forged',
      })
    )
  ).toMatchObject({ error: false });
  expect(mocks.generateBaskets).toHaveBeenCalledWith({
    branchId: 'branch-a',
    from: new Date('2026-10-01'),
    cutoff: new Date('2026-10-03'),
    config: {
      minimumPairCount: 2,
      minimumSupport: 0.3,
      minimumConfidence: 0.5,
      minimumLift: 1,
      maximumProposals: 3,
    },
  });
});
it('requires explicit bundle review and surfaces PIN refusal without navigating to a campaign', async () => {
  expect(
    await marketingAction(form({ operation: 'basket-review', decision: 'APPROVE' }))
  ).toMatchObject({ error: true });
  expect(mocks.reviewBasket).not.toHaveBeenCalled();
  mocks.reviewBasket.mockResolvedValue({ blocked: 'Enter your current owner PIN.' });
  const result = await marketingAction(
    form({
      operation: 'basket-review',
      reviewed: 'on',
      decision: 'APPROVE',
      insightId: 'i1',
      recommendation: '0',
      pin: '1234',
      scheduledAt: '2026-11-02T12:00:00Z',
    })
  );
  expect(result).toEqual({ error: true, message: 'Enter your current owner PIN.' });
  expect(mocks.reviewBasket).toHaveBeenCalledWith({
    branchId: 'branch-a',
    insightId: 'i1',
    recommendation: 0,
    decision: 'APPROVE',
    pinCredential: '1234',
    scheduledAt: new Date('2026-11-02T12:00:00Z'),
  });
});
it('returns the saved manual draft for navigation with bounded retail settings', async () => {
  mocks.createDraft.mockResolvedValue({ id: 'saved-draft' });
  const result = await marketingAction(
    form({
      operation: 'draft',
      field: 'receiptCount',
      name: 'Generic outreach',
      templateId: 'template-a',
      scheduledAt: '2026-10-10T12:00:00Z',
      threshold: '1',
      quietStart: '22',
      quietEnd: '8',
      cap: '1',
      window: '7',
    })
  );
  expect(result).toMatchObject({ error: false, campaignId: 'saved-draft' });
  expect(mocks.createDraft).toHaveBeenCalledWith(
    expect.objectContaining({
      branchId: 'branch-a',
      promotesRegulatedItem: false,
      definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
      quietHours: { startHour: 22, endHour: 8 },
      frequencyCap: { max: 1, windowDays: 7 },
    })
  );
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.revalidate).toHaveBeenCalledWith('/pharmacy/marketing');
});
it('does not forward unsupported targeting fields', async () => {
  expect(await marketingAction(form({ operation: 'draft', field: 'medicine' }))).toMatchObject({
    error: true,
  });
  expect(mocks.createDraft).not.toHaveBeenCalled();
});
it('requires explicit campaign approval confirmation', async () => {
  expect(await marketingAction(form({ operation: 'approve', campaignId: 'c1' }))).toMatchObject({
    error: true,
  });
  expect(mocks.approve).not.toHaveBeenCalled();
});
it('shows recipients times the configured marketing rate before capture', async () => {
  vi.stubEnv(
    'PHARMACY_WHATSAPP_RATE_CARD',
    JSON.stringify({ currency: 'PKR', rates: { MARKETING: '2.75' } })
  );
  mocks.preview.mockResolvedValue({ prepared: 8, exclusions: { NO_CONSENT: 2 } });
  const result = await marketingAction(form({ operation: 'preview', campaignId: 'c1' }));
  expect(result.message).toContain('8 recipients × PKR 2.75 (marketing) = PKR 22');
  expect(result.message).toContain('Nothing saved or sent');
});
it('passes only insight reference and editable draft settings for server-bound review', async () => {
  mocks.reviewGrowth.mockResolvedValue({ decision: 'APPROVE', campaignId: 'from-insight' });
  const result = await marketingAction(
    form({
      operation: 'growth-review',
      reviewed: 'on',
      decision: 'APPROVE',
      insightId: 'i1',
      recommendation: '0',
      name: 'Generic',
      templateId: 't1',
      scheduledAt: '2026-10-10T12:00:00Z',
      actionRef: 'forged',
      field: 'medicine',
    })
  );
  expect(result.campaignId).toBe('from-insight');
  expect(mocks.reviewGrowth).toHaveBeenCalledWith({
    branchId: 'branch-a',
    insightId: 'i1',
    recommendation: 0,
    decision: 'APPROVE',
    edit: { name: 'Generic', templateId: 't1', scheduledAt: new Date('2026-10-10T12:00:00Z') },
  });
  expect(mocks.approve).not.toHaveBeenCalled();
});
it('preserves sandbox replay key and retry intent without any live provider choice', async () => {
  mocks.sandbox.mockResolvedValue({
    attempted: 1,
    accepted: 0,
    delivered: 0,
    failed: 1,
    unknown: 0,
    suppressed: 0,
  });
  const result = await marketingAction(
    form({
      operation: 'sandbox',
      campaignId: 'c1',
      requestKey: 'replay-key',
      retry: 'on',
      outcome: 'REJECTED',
      provider: 'meta',
    })
  );
  expect(mocks.sandbox).toHaveBeenCalledWith({
    branchId: 'branch-a',
    campaignId: 'c1',
    requestKey: 'replay-key',
    retry: true,
    outcome: 'REJECTED',
  });
  expect(result.message).toContain('No live messages sent');
});
it('reads growth periods as whole local days and shows a plain next step without status codes', async () => {
  mocks.generateGrowth.mockResolvedValue({ status: 'UNAVAILABLE', failureCode: 'CONFIGURATION' });
  const result = await marketingAction(
    form({
      operation: 'growth-generate',
      timeZone: 'Asia/Karachi',
      from: '2026-10-01',
      lastDay: '2026-10-30',
    })
  );
  expect(mocks.generateGrowth).toHaveBeenCalledWith({
    branchId: 'branch-a',
    from: new Date('2026-09-30T19:00:00Z'),
    cutoff: new Date('2026-10-30T19:00:00Z'),
  });
  expect(result.message).toContain('Contact DevFathom support');
  expect(result.message).not.toMatch(/UNAVAILABLE|CONFIGURATION/);
});
it('asks for dates instead of silently doing nothing when growth dates are empty', async () => {
  const result = await marketingAction(
    form({ operation: 'growth-generate', timeZone: 'Asia/Karachi', from: '', lastDay: '' })
  );
  expect(result.error).toBe(true);
  expect(result.message).toContain('first day and a last day');
  expect(mocks.generateGrowth).not.toHaveBeenCalled();
});
it('reads send times as workspace wall-clock time', async () => {
  mocks.createDraft.mockResolvedValue({ id: 'saved-draft' });
  await marketingAction(
    form({
      operation: 'draft',
      timeZone: 'Asia/Karachi',
      field: 'receiptCount',
      name: 'Generic outreach',
      templateId: 'template-a',
      scheduledAt: '2026-10-10T12:00',
      threshold: '1',
      quietStart: '22',
      quietEnd: '8',
      cap: '1',
      window: '7',
    })
  );
  expect(mocks.createDraft).toHaveBeenCalledWith(
    expect.objectContaining({ scheduledAt: new Date('2026-10-10T07:00:00Z') })
  );
});

it('submits profile facts with configurable targets and reports the checklist (DEV-13)', async () => {
  mocks.profileHealth.mockResolvedValue({
    passed: 1,
    total: 2,
    items: [
      { key: 'phone', label: 'Phone number listed', ok: true, advice: 'Add phone.' },
      { key: 'photos', label: 'At least 6 photos', ok: false, advice: 'Add photos.' },
    ],
  });
  const result = await marketingAction(
    form({
      operation: 'profile-health',
      phoneListed: 'on',
      hoursConfirmedDaysAgo: '',
      photoCount: '2',
      unansweredReviews: '1',
      maximumHoursAgeDays: '60',
      minimumPhotos: '6',
      maximumUnansweredReviews: '2',
    })
  );
  expect(mocks.profileHealth).toHaveBeenCalledWith({
    branchId: 'branch-a',
    facts: {
      primaryCategoryIsPharmacy: false,
      phoneListed: true,
      websiteOrOrderLinkListed: false,
      descriptionPresent: false,
      holidayHoursSet: false,
      hoursConfirmedDaysAgo: null,
      photoCount: 2,
      unansweredReviews: 1,
    },
    config: { maximumHoursAgeDays: 60, minimumPhotos: 6, maximumUnansweredReviews: 2 },
  });
  expect(result.message).toContain('1 of 2 done');
  expect(result.message).toContain('To do: At least 6 photos. Add photos.');
});

it('returns a review reply draft labelled as not posted and sends no review text', async () => {
  mocks.reviewReply.mockResolvedValue({ body: 'Thank you!', source: 'TEMPLATE', posted: false });
  const result = await marketingAction(
    form({ operation: 'review-reply', rating: '4', tone: 'FORMAL', reviewText: 'private' })
  );
  expect(mocks.reviewReply).toHaveBeenCalledWith({
    branchId: 'branch-a',
    rating: 4,
    tone: 'FORMAL',
  });
  expect(result).toMatchObject({ error: false });
  expect(result.message).toMatch(/not posted/);
  expect(result.message).toContain('Thank you!');
  expect(
    await marketingAction(form({ operation: 'review-reply', rating: '4', tone: 'LOUD' }))
  ).toMatchObject({ error: true });
});

it('DEV-780: issues a voucher with the owner-set use limit, whole-rupee value and local last day', async () => {
  mocks.issueVoucher.mockResolvedValue({ voucher: { code: 'GIFT10', maxUses: 25 } });
  const result = await marketingAction(
    form({
      operation: 'voucher-issue',
      timeZone: 'Asia/Karachi',
      code: 'gift10',
      name: 'Gift sets',
      body: 'Rs 150 off gift sets.',
      discountRupees: '150',
      maxUses: '25',
      validUntil: '2026-12-31',
      approverId: 'staff-b',
      approverPin: '',
      reviewed: 'on',
    })
  );
  expect(result).toEqual({
    error: false,
    message: 'Voucher GIFT10 issued. It can be used 25 times.',
    campaignId: undefined,
  });
  // The last day is inclusive: the voucher stops at the next local midnight (UTC+5).
  expect(mocks.issueVoucher).toHaveBeenCalledWith({
    branchId: 'branch-a',
    code: 'gift10',
    name: 'Gift sets',
    body: 'Rs 150 off gift sets.',
    discountMinor: 15_000,
    maxUses: 25,
    validUntil: new Date('2026-12-31T19:00:00.000Z'),
    reviewed: true,
  });
});

it('DEV-780: sends the second approver PIN only when one is entered', async () => {
  mocks.issueVoucher.mockResolvedValue({ voucher: { code: 'BIG', maxUses: 1 } });
  await marketingAction(
    form({
      operation: 'voucher-issue',
      code: 'BIG-1',
      name: 'Big',
      body: 'Rs 2000 off.',
      discountRupees: '2000',
      maxUses: '1',
      validUntil: '2026-12-31',
      approverId: 'staff-b',
      approverPin: '2468',
      reviewed: 'on',
    })
  );
  expect(mocks.issueVoucher).toHaveBeenCalledWith(
    expect.objectContaining({
      discountMinor: 200_000,
      approval: { staffProfileId: 'staff-b', pin: '2468' },
    })
  );
});

it('DEV-780: refuses an unreviewed voucher or a missing use limit before calling the server', async () => {
  const base = {
    operation: 'voucher-issue',
    code: 'GIFT10',
    name: 'Gift sets',
    body: 'Rs 150 off gift sets.',
    discountRupees: '150',
    maxUses: '5',
    validUntil: '2026-12-31',
    reviewed: 'on',
  };
  for (const values of [
    { ...base, reviewed: '' },
    { ...base, maxUses: '0' },
    { ...base, maxUses: '' },
    { ...base, discountRupees: '1.5' },
    { ...base, code: 'x' },
    { ...base, validUntil: '' },
  ])
    expect(await marketingAction(form(values))).toMatchObject({ error: true });
  expect(mocks.issueVoucher).not.toHaveBeenCalled();
});

it('DEV-780: revokes a voucher only after confirmation with a reason', async () => {
  mocks.revokeVoucher.mockResolvedValue({ voucherId: 'voucher-a', revoked: true });
  expect(
    await marketingAction(
      form({ operation: 'voucher-revoke', voucherId: 'voucher-a', reason: 'Lost', confirmed: '' })
    )
  ).toMatchObject({ error: true });
  expect(mocks.revokeVoucher).not.toHaveBeenCalled();
  expect(
    await marketingAction(
      form({ operation: 'voucher-revoke', voucherId: 'voucher-a', reason: 'Lost', confirmed: 'on' })
    )
  ).toMatchObject({ error: false, message: 'Voucher revoked. It cannot be redeemed again.' });
  expect(mocks.revokeVoucher).toHaveBeenCalledWith({
    branchId: 'branch-a',
    voucherId: 'voucher-a',
    reason: 'Lost',
  });
});
