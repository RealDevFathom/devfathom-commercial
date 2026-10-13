// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { uploadAttachment } from './upload-client';
afterEach(() => vi.unstubAllGlobals());
test('503 rejects without returning an attachment link', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ error: 'Uploads are unavailable.' }), { status: 503 })
    );
  vi.stubGlobal('fetch', fetch);
  await expect(uploadAttachment(new File(['proof'], 'proof.png'))).rejects.toThrow(
    'Upload failed: Uploads are unavailable.'
  );
  expect(fetch).toHaveBeenCalledOnce();
});
test('successful fake upload preserves attachment shape', async () => {
  const result = { name: 'proof.png', url: '/api/files/proof.png', type: 'image/png', size: 5 };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(result))));
  await expect(uploadAttachment(new File(['proof'], 'proof.png'))).resolves.toEqual(result);
});
