/** A finite synthetic stream. Cancellation proves the handler did not consume the tail. */
export function oversizedRequest(
  limit: number,
  {
    url = 'https://tenant.example.test/',
    headers,
    chunkSize = 16_384,
  }: { url?: string; headers?: HeadersInit; chunkSize?: number } = {}
) {
  const chunk = new Uint8Array(chunkSize);
  let bytesRead = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (bytesRead > limit + chunk.length * 4) return controller.close();
        bytesRead += chunk.length;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  const request = new Request(url, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
  return { request, cancelled: () => cancelled, bytesRead: () => bytesRead };
}
