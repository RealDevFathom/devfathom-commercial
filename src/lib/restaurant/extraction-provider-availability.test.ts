import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', () => ({ generateObject: mocks.generateObject }));

import { createVisionRxOcrAdapter } from '@/lib/pharmacy/rx-ocr';
import { createVisionMenuExtractionAdapter } from './menu-extraction-vision';
import { configuredAdapterName } from './menu-import';

const request = {
  content: Buffer.from('offline-image'),
  mimeType: 'image/png' as const,
  pageCount: 1,
  defaultCurrency: null,
  importId: 'import_test',
  sourceFileRef: 'private-source-reference',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MENU_IMPORT_ADAPTER', 'VISION');
  vi.stubEnv('AI_PROVIDER_ORDER', 'anthropic,openai,bedrock');
  for (const name of [
    'AI_PROVIDER',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_API_KEY_SECRET_ID',
    'OPENAI_API_KEY',
    'OPENAI_API_KEY_SECRET_ID',
    'BEDROCK_REGION',
    'AI_BEDROCK_REGION',
  ]) {
    vi.stubEnv(name, undefined);
  }
  mocks.generateObject.mockResolvedValue({ object: { pages: [], lines: [] } });
});

afterEach(() => vi.unstubAllEnvs());

describe.each([
  ['menu', createVisionMenuExtractionAdapter],
  ['prescription', createVisionRxOcrAdapter],
] as const)('%s routed extraction availability', (_surface, createAdapter) => {
  it.each([
    { AI_PROVIDER: 'auto', ANTHROPIC_API_KEY_SECRET_ID: 'offline-anthropic-secret' },
    { AI_PROVIDER: 'auto', OPENAI_API_KEY_SECRET_ID: 'offline-openai-secret' },
    { AI_PROVIDER: 'openai', OPENAI_API_KEY_SECRET_ID: 'offline-openai-secret' },
    { AI_PROVIDER: 'auto', BEDROCK_REGION: 'us-east-1' },
    { AI_PROVIDER: 'bedrock' },
  ])('accepts routed configuration %j without a plain Anthropic key', async (env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    expect(configuredAdapterName()).toBe('VISION');
    await expect(createAdapter().extract(request)).resolves.toMatchObject({ adapter: 'VISION' });

    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ provider: 'devfathom.routed' }),
        maxRetries: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: expect.any(String) },
              { type: 'image', image: request.content, mediaType: request.mimeType },
            ],
          },
        ],
      })
    );
  });

  it.each([undefined, '', 'disabled', 'typo', 'auto'])(
    'blocks unavailable configuration %s before generation',
    async (provider) => {
      vi.stubEnv('AI_PROVIDER', provider);

      expect(() => configuredAdapterName()).toThrow(
        expect.objectContaining({ reason: 'ADAPTER_UNAVAILABLE' })
      );
      await expect(createAdapter().extract(request)).rejects.toMatchObject({
        reason: 'ADAPTER_UNAVAILABLE',
      });
      expect(mocks.generateObject).not.toHaveBeenCalled();
    }
  );

  it('rechecks configuration after failure and after success on the same adapter', async () => {
    const adapter = createAdapter();
    await expect(adapter.extract(request)).rejects.toMatchObject({
      reason: 'ADAPTER_UNAVAILABLE',
    });

    vi.stubEnv('AI_PROVIDER', 'auto');
    vi.stubEnv('OPENAI_API_KEY_SECRET_ID', 'offline-openai-secret');
    await expect(adapter.extract(request)).resolves.toMatchObject({ adapter: 'VISION' });

    vi.stubEnv('AI_PROVIDER', 'disabled');
    await expect(adapter.extract(request)).rejects.toMatchObject({
      reason: 'ADAPTER_UNAVAILABLE',
    });
    expect(mocks.generateObject).toHaveBeenCalledOnce();
  });
});
