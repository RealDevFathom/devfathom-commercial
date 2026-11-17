/**
 * DEV-860: a machine-readable reason attached to a deliberate refusal.
 *
 * A procedure that refuses with words of its own can also name the reason, so a
 * client can say what is missing without parsing prose. It is passed as the
 * `cause` of a TRPCError, and the tenant `errorFormatter` publishes it as
 * `data.reason`. Only a code of this exact shape is published.
 *
 * Name a reason only when it reveals nothing beyond the caller's own standing:
 * never whether another tenant's or another user's record exists.
 */
export class RefusalReason extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RefusalReason';
  }
}

const REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** The published reason of a refusal, or null when it names none. */
export function refusalReasonOf(cause: unknown): string | null {
  return cause instanceof RefusalReason && REASON_CODE.test(cause.reason) ? cause.reason : null;
}
