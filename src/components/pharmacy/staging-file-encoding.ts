import { STAGING_MAX_UPLOAD_BYTES } from '@/lib/pharmacy/migration/staging-input';

export type EncodedStagingFile = { content: string; encoding: 'identity' | 'gzip' };

function base64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a multi-megabyte file does not exceed the argument limit.
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  })
    .pipeThrough(
      new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
    )
    .getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    parts.push(read.value);
    length += read.value.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * DEV-851: a whole catalogue export is several megabytes of text. Compress it
 * before it is sent so it fits one request; the server inflates it with a hard
 * bound and keeps the original bytes as the source evidence. Browsers without
 * CompressionStream send the file as is, within the same transport limit.
 *
 * Returns null when the file is still too large to send.
 */
export async function encodeStagingFile(bytes: Uint8Array): Promise<EncodedStagingFile | null> {
  const compressed = typeof CompressionStream === 'function' ? await gzip(bytes) : null;
  const sent = compressed && compressed.length < bytes.length ? compressed : bytes;
  if (sent.length > STAGING_MAX_UPLOAD_BYTES) return null;
  return { content: base64(sent), encoding: sent === bytes ? 'identity' : 'gzip' };
}
