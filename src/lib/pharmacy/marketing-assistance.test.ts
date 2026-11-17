import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  tenantDb: vi.fn(),
  medicines: vi.fn(),
  aliases: vi.fn(),
  ingredients: vi.fn(),
}));
vi.mock('@/lib/ai/router', () => ({ routeAI: mocks.route }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: mocks.tenantDb }));
import { draftMarketingCopy } from './marketing-assistance';
const context = { organizationId: 'org-a', branchId: 'branch-a' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.route.mockResolvedValue({ text: 'Welcome to our store. Reply STOP to opt out.' });
  mocks.medicines.mockResolvedValue([
    { productName: 'Panadol Extra 500mg Tablet', brandName: 'Panadol' },
  ]);
  mocks.aliases.mockResolvedValue([{ value: 'Calpol' }]);
  mocks.ingredients.mockResolvedValue([{ name: 'Paracetamol' }]);
  mocks.tenantDb.mockReturnValue({
    medicine: { findMany: mocks.medicines },
    medicineAlias: { findMany: mocks.aliases },
    ingredient: { findMany: mocks.ingredients },
  });
});
it('sends only allowlisted generic choices and leaves output unapproved', async () => {
  expect(
    await draftMarketingCopy({ occasion: 'WELCOME', tone: 'FRIENDLY' }, context)
  ).toMatchObject({
    available: true,
    approved: false,
  });
  const args = mocks.route.mock.calls[0][0];
  expect(args).toMatchObject({
    organizationId: 'org-a',
    branchId: 'branch-a',
    feature: 'pharmacy.marketing-assistance',
  });
  expect(args.prompt).toBe('Occasion: WELCOME. Tone: FRIENDLY.');
  expect(args).not.toHaveProperty('tools');
  expect(args.maxRetries).toBe(0);
});
it('rejects free text or customer payloads before invoking the provider', async () => {
  await expect(
    draftMarketingCopy(
      { occasion: 'WELCOME', tone: 'FORMAL', customer: 'private' } as never,
      context
    )
  ).rejects.toThrow();
  expect(mocks.route).not.toHaveBeenCalled();
});
it('returns honest unavailable without exposing transport errors', async () => {
  mocks.route.mockRejectedValue(new Error('secret provider context'));
  expect(await draftMarketingCopy({ occasion: 'WELCOME', tone: 'FORMAL' }, context)).toEqual({
    available: false,
    body: null,
    approved: false,
  });
});
it('rejects clinical output and missing opt-out instructions', async () => {
  for (const text of ['Medicine offers. Reply STOP.', 'Welcome to our store.']) {
    mocks.route.mockResolvedValue({ text });
    expect(
      await draftMarketingCopy({ occasion: 'WELCOME', tone: 'FORMAL' }, context)
    ).toMatchObject({
      available: false,
      body: null,
    });
  }
});
it("rejects a draft that names one of the tenant's medicines, brands, aliases or salts", async () => {
  for (const text of [
    'New PANADOL stock has arrived! Reply STOP to opt out.',
    'Calpol is back on our shelves. Reply STOP to opt out.',
    'Ask us about paracetamol. Reply STOP to opt out.',
  ]) {
    mocks.route.mockResolvedValue({ text });
    expect(
      await draftMarketingCopy({ occasion: 'RETAIL_OFFER', tone: 'FRIENDLY' }, context)
    ).toEqual({ available: false, body: null, approved: false });
  }
  expect(mocks.tenantDb).toHaveBeenCalledWith('org-a');
});
it('checks names on the tenant database it is given', async () => {
  const db = {
    medicine: { findMany: vi.fn(async () => []) },
    medicineAlias: { findMany: vi.fn(async () => []) },
    ingredient: { findMany: vi.fn(async () => [{ name: 'Welcome' }]) },
  };
  expect(
    await draftMarketingCopy(
      { occasion: 'WELCOME', tone: 'FRIENDLY' },
      { ...context, db: db as never }
    )
  ).toMatchObject({ available: false });
  expect(mocks.tenantDb).not.toHaveBeenCalled();
});
it('fails closed when the medicine names cannot be read', async () => {
  mocks.medicines.mockRejectedValue(new Error('db down'));
  expect(await draftMarketingCopy({ occasion: 'WELCOME', tone: 'FRIENDLY' }, context)).toEqual({
    available: false,
    body: null,
    approved: false,
  });
});
it('asks for Urdu and accepts an Urdu draft when the workspace locale is Urdu', async () => {
  mocks.route.mockResolvedValue({ text: 'ہمارے اسٹور میں خوش آمدید۔ بند کرنے کے لیے STOP لکھیں۔' });
  const result = await draftMarketingCopy(
    { occasion: 'WELCOME', tone: 'FRIENDLY' },
    { ...context, locale: 'ur' }
  );
  expect(result).toMatchObject({ available: true });
  expect(mocks.route.mock.calls[0][0].system).toContain('Urdu script');
});
it('rejects an English draft when Urdu was requested, and an Urdu draft for English', async () => {
  const ur = { occasion: 'WELCOME', tone: 'FRIENDLY' } as const;
  expect(await draftMarketingCopy(ur, { ...context, locale: 'ur' })).toMatchObject({
    available: false,
    body: null,
  });
  mocks.route.mockResolvedValue({ text: 'ہمارے اسٹور میں خوش آمدید۔ STOP لکھیں۔' });
  expect(await draftMarketingCopy(ur, context)).toMatchObject({ available: false, body: null });
});
it('rejects an English draft whose only Urdu is the opt-out sentence', async () => {
  mocks.route.mockResolvedValue({ text: 'Welcome to our store. STOP لکھ کر جواب دیں۔' });
  expect(
    await draftMarketingCopy(
      { occasion: 'WELCOME', tone: 'FRIENDLY' },
      { ...context, locale: 'ur' }
    )
  ).toMatchObject({ available: false, body: null });
});
