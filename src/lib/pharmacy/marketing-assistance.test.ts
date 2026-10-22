import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), model: vi.fn() }));
vi.mock('ai', () => ({ generateText: mocks.generate }));
vi.mock('@/lib/ai/provider', () => ({ createAIModel: mocks.model }));
import { draftMarketingCopy } from './marketing-assistance';
beforeEach(() => {
  // This suite covers the unchanged legacy path; router behavior has its own tests.
  vi.stubEnv('AI_PROVIDER', 'azure');
  vi.clearAllMocks();
  mocks.model.mockReturnValue({ model: 'test-model' });
  mocks.generate.mockResolvedValue({ text: 'Welcome to our store. Reply STOP to opt out.' });
});
afterEach(() => vi.unstubAllEnvs());
it('sends only allowlisted generic choices and leaves output unapproved', async () => {
  expect(await draftMarketingCopy({ occasion: 'WELCOME', tone: 'FRIENDLY' })).toMatchObject({
    available: true,
    approved: false,
  });
  const args = mocks.generate.mock.calls[0][0];
  expect(args.prompt).toBe('Occasion: WELCOME. Tone: FRIENDLY.');
  expect(args).not.toHaveProperty('tools');
  expect(args.maxRetries).toBe(0);
});
it('rejects free text or customer payloads before invoking the provider', async () => {
  await expect(
    draftMarketingCopy({ occasion: 'WELCOME', tone: 'FORMAL', customer: 'private' } as never)
  ).rejects.toThrow();
  expect(mocks.generate).not.toHaveBeenCalled();
});
it('returns honest unavailable without exposing transport errors', async () => {
  mocks.generate.mockRejectedValue(new Error('secret provider context'));
  expect(await draftMarketingCopy({ occasion: 'WELCOME', tone: 'FORMAL' })).toEqual({
    available: false,
    body: null,
    approved: false,
  });
});
it('rejects clinical output and missing opt-out instructions', async () => {
  for (const text of ['Medicine offers. Reply STOP.', 'Welcome to our store.']) {
    mocks.generate.mockResolvedValue({ text });
    expect(await draftMarketingCopy({ occasion: 'WELCOME', tone: 'FORMAL' })).toMatchObject({
      available: false,
      body: null,
    });
  }
});
