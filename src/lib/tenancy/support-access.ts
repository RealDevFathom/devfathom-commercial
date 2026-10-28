/** Support authority is inspection-only; it must never escape into a bearer capability. */
export const SUPPORT_READ_ONLY_MESSAGE = 'Support access is read-only.';

export function liveSupportExpiry(value: Date | string | undefined): boolean {
  const time = value instanceof Date ? value.getTime() : Date.parse(value ?? '');
  return Number.isFinite(time) && time > Date.now();
}

/**
 * HTTP reads are explicitly reviewed. In particular, GET /api/ably-token issues
 * publish/presence credentials and is not a read. tRPC checks each procedure,
 * including POST queries, rather than trusting the transport method.
 */
export function supportHttpReadAllowed(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/trpc/')) return true;
  return (
    request.method === 'GET' &&
    (path.startsWith('/api/files/') || path === '/api/pharmacy/prescription-files')
  );
}
