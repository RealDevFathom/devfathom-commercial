/** Stop at the first excess byte, even when Content-Length is absent or understated. */
export async function consumeBoundedBody(
  request: Request,
  limit: number,
  acceptChunk?: (chunk: Uint8Array) => void
): Promise<boolean> {
  if (Number(request.headers.get('content-length')) > limit) return false;
  if (!request.body) return true;
  const reader = request.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      if (value.byteLength) acceptChunk?.(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedBody(
  request: Request,
  limit: number
): Promise<Buffer<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  const complete = await consumeBoundedBody(request, limit, (chunk) => chunks.push(chunk));
  return complete ? Buffer.concat(chunks) : null;
}
