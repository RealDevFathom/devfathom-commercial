/** Raised when an inbound provider id was already stored for this organization. */
export class DuplicateInboundMessage extends Error {
  constructor() {
    super('Duplicate inbound message.');
    this.name = 'DuplicateInboundMessage';
  }
}

export function isDuplicateInbound(error: unknown): boolean {
  if (error instanceof DuplicateInboundMessage) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
