import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', () => ({ generateObject: mocks.generateObject }));
import { createVisionMenuExtractionAdapter } from './menu-extraction-vision';
const request = {
  content: Buffer.from('fake'),
  mimeType: 'image/png' as const,
  pageCount: 1,
  defaultCurrency: null,
  importId: 'imp_1',
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('VISION global gate', () => {
  it.each([undefined, '', ' ', 'disabled', 'typo'])(
    'blocks %s before injected selection or SDK calls',
    async (provider) => {
      vi.stubEnv('AI_PROVIDER', provider);
      const selectModel = vi.fn();
      await expect(
        createVisionMenuExtractionAdapter({ selectModel }).extract(request)
      ).rejects.toMatchObject({
        reason: 'ADAPTER_UNAVAILABLE',
        message: 'Menu extraction is unavailable.',
      });
      expect(selectModel).not.toHaveBeenCalled();
      expect(mocks.generateObject).not.toHaveBeenCalled();
    }
  );
  it('uses an enabled injected model and normalizes a mocked SDK response', async () => {
    vi.stubEnv('AI_PROVIDER', 'google');
    const selectModel = vi.fn(() => ({
      model: 'fake-model',
      provider: 'google' as const,
      modelId: 'fake-model',
    }));
    mocks.generateObject.mockResolvedValueOnce({ object: { pages: [] } });
    await expect(
      createVisionMenuExtractionAdapter({ selectModel }).extract(request)
    ).resolves.toMatchObject({ adapter: 'VISION', pages: [] });
    expect(selectModel).toHaveBeenCalledOnce();
    expect(mocks.generateObject).toHaveBeenCalledOnce();
  });
  it('sanitizes enabled-provider selection failures', async () => {
    vi.stubEnv('AI_PROVIDER', 'google');
    const selectModel = vi.fn(() => {
      throw new Error('fake-sensitive-configuration');
    });
    await expect(
      createVisionMenuExtractionAdapter({ selectModel }).extract(request)
    ).rejects.toMatchObject({
      reason: 'ADAPTER_UNAVAILABLE',
      message: 'Menu extraction is unavailable.',
    });
    expect(selectModel).toHaveBeenCalledOnce();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});
