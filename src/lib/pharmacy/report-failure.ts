import { TRPCError } from '@trpc/server';

/**
 * Why an owner report card could not be shown. A refusal is not the same as a
 * missing record, a bad filter or an outage, and the card says which one it is
 * instead of blaming permissions for every failure.
 */
export type ReportFailureKind = 'forbidden' | 'not-found' | 'invalid' | 'unavailable';

export function reportFailureKind(error: unknown): ReportFailureKind {
  if (error instanceof TRPCError) {
    if (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED') return 'forbidden';
    if (error.code === 'NOT_FOUND') return 'not-found';
    if (error.code === 'BAD_REQUEST') return 'invalid';
  }
  return 'unavailable';
}

/** The sentence an owner report card shows for each failure kind. */
export function reportFailureMessage(kind: ReportFailureKind, subject: string): string {
  switch (kind) {
    case 'forbidden':
      return `Financial report and owner permissions are required to view ${subject}.`;
    case 'not-found':
      return `The selected branch or its records could not be found, so ${subject} is not shown. Check the branch filter and try again.`;
    case 'invalid':
      return `These filters cannot be used for ${subject}. Check the dates and branch, then apply them again.`;
    case 'unavailable':
      return `${subject[0]!.toUpperCase()}${subject.slice(1)} could not be loaded because of a server or network problem. This is not a permission issue; reload the page to try again.`;
  }
}
