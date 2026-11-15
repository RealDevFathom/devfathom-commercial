import { TRPCError } from '@trpc/server';

/**
 * Prisma error handling at the tRPC boundary (#318).
 *
 * A procedure that writes to a row another user has just deleted lets Prisma's
 * own error escape the resolver. tRPC wraps it in an INTERNAL_SERVER_ERROR that
 * carries Prisma's message verbatim ("Invalid `prisma.client.update()`
 * invocation: ... No record was found for an update."), which names the ORM,
 * the model and the operation. The tenant UI renders `error.message` directly.
 *
 * Errors are recognised by their `name`, which every Prisma client error sets,
 * rather than by `instanceof`, so a second copy of the runtime still matches.
 */

type PrismaKnownError = Error & { name: 'PrismaClientKnownRequestError'; code: string };

/** Prisma client error names; each carries an ORM message unfit for users. */
const PRISMA_ERROR_NAMES = new Set([
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientValidationError',
  'PrismaClientRustPanicError',
  'PrismaClientInitializationError',
]);

export function isPrismaError(value: unknown): value is Error {
  return value instanceof Error && PRISMA_ERROR_NAMES.has(value.name);
}

function isPrismaKnownError(value: unknown): value is PrismaKnownError {
  return (
    isPrismaError(value) &&
    value.name === 'PrismaClientKnownRequestError' &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

export const RECORD_NOT_FOUND_MESSAGE =
  'This record no longer exists. It may have been deleted. Refresh and try again.';
export const DUPLICATE_RECORD_MESSAGE = 'A record with these details already exists.';
export const RELATED_RECORD_MESSAGE =
  'This change refers to a related record that is missing or still in use.';

/** User-facing replacements for the Prisma request errors ordinary use reaches. */
const KNOWN_CODES: Record<string, { code: TRPCError['code']; message: string }> = {
  // Record required by the operation was not found (update/delete of a stale row).
  P2025: { code: 'NOT_FOUND', message: RECORD_NOT_FOUND_MESSAGE },
  P2001: { code: 'NOT_FOUND', message: RECORD_NOT_FOUND_MESSAGE },
  P2015: { code: 'NOT_FOUND', message: RECORD_NOT_FOUND_MESSAGE },
  P2018: { code: 'NOT_FOUND', message: RECORD_NOT_FOUND_MESSAGE },
  // Unique constraint.
  P2002: { code: 'CONFLICT', message: DUPLICATE_RECORD_MESSAGE },
  // Foreign key constraint.
  P2003: { code: 'BAD_REQUEST', message: RELATED_RECORD_MESSAGE },
};

/**
 * The typed, user-facing error for an unexpected failure caused by a known
 * Prisma request error, or null when there is none. Only an INTERNAL_SERVER_ERROR
 * that tRPC made out of the Prisma error itself qualifies: a TRPCError thrown on
 * purpose keeps its own code and words even when a Prisma error is its cause.
 */
export function mapPrismaError(error: TRPCError): TRPCError | null {
  const cause = error.cause;
  if (error.code !== 'INTERNAL_SERVER_ERROR' || !isPrismaKnownError(cause)) return null;
  if (error.message !== cause.message) return null;
  const mapped = KNOWN_CODES[cause.code];
  return mapped ? new TRPCError({ ...mapped, cause }) : null;
}
