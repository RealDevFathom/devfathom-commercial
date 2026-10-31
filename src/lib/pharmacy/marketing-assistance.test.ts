import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ route: vi.fn() }));
vi.mock('@/lib/ai/router', () => ({ routeAI: mocks.route }));
import { draftMarketingCopy } from './marketing-assistance';
const context = { organizationId: 'org-a', branchId: 'branch-a' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.route.mockResolvedValue({ text: 'Welcome to our store. Reply STOP to opt out.' });
});
it('sends only allowlisted generic choices and leaves output unapproved', async () => {
  expect(await draftMarketingCopy({ occasion: 'WELCOME', tone: 'FRIENDLY' }, context)).toMatchObject({
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
    expect(await draftMarketingCopy({ occasion: 'WELCOME', tone: 'FORMAL' }, context)).toMatchObject({
      available: false,
      body: null,
    });
  }
});
