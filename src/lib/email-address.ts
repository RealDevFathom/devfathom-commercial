import { z } from 'zod';

/**
 * One normalization rule for every stored and looked-up email address.
 *
 * D10: `users.email` is unique per organization on the raw string, there is no
 * `citext` extension and no `lower(email)` functional index, so `Alex@Company.com`
 * and `alex@company.com` were two different rows and two different lookups —
 * meaning a correctly-cased sign-in could fail and a differently-cased address
 * could create a second account for the same person.
 *
 * Normalizing at the SCHEMA layer rather than at each call site means every
 * caller inherits it, including the ones added after this change. The local part
 * of an address is technically case-sensitive per RFC 5321, but no mail provider
 * this product integrates with treats it that way, and tenant-local identity is
 * far better served by one address meaning one person.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Parsed, trimmed, lower-cased, and validated as an email address. */
export const emailSchema = z.string().trim().toLowerCase().email('Invalid email address').max(254);

/**
 * Same normalization without format validation, for inputs that are only ever
 * used as a lookup key (a wrong address simply finds nothing) and must not
 * distinguish "malformed" from "unknown" in their response.
 */
export const emailLookupSchema = z.string().trim().toLowerCase().min(1).max(320);
