/** A finite synthetic stream. Cancellation proves the handler did not consume the tail. */
export function oversizedRequest(limit: number) {
  const chunk = new Uint8Array(16_384);
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
  const request = new Request('https://tenant.example.test/', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
  return { request, cancelled: () => cancelled, bytesRead: () => bytesRead };
}
