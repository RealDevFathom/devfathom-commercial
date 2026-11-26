/** Stop at the first excess byte, even when Content-Length is absent or understated. */
export async function consumeBoundedBody(
  request: Request,
  limit: number,
  acceptChunk?: (chunk: Uint8Array, total: number) => void | Promise<void>,
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted();
  if (Number(request.headers.get('content-length')) > limit) return false;
  if (!request.body) return true;
  const reader = request.body.getReader();
  function cancel() {
    const canceled = reader.cancel().catch(() => undefined);
    // A caller with a deadline must not wait for the producer's cleanup.
    if (!signal) return canceled;
  }
  signal?.addEventListener('abort', cancel, { once: true });
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return true;
      total += value.byteLength;
      if (total > limit) {
        await cancel();
        return false;
      }
      if (value.byteLength) {
        const accepted = acceptChunk?.(value, total);
        if (accepted) {
          await accepted;
          signal?.throwIfAborted();
        }
      }
    }
  } catch (error) {
    if (!signal?.aborted) await cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export async function readBoundedBody(
  request: Request,
  limit: number
): Promise<Buffer<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  const complete = await consumeBoundedBody(request, limit, (chunk) => {
    chunks.push(chunk);
  });
  return complete ? Buffer.concat(chunks) : null;
}

export async function readBoundedJson(request: Request, limit: number) {
  const raw = await readBoundedBody(request, limit);
  if (raw === null) return { tooLarge: true } as const;
  return { tooLarge: false, value: JSON.parse(new TextDecoder().decode(raw)) as unknown } as const;
}
