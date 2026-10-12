import { z } from 'zod';

/**
 * Render-time guard for user-supplied URLs used in anchor `href`s.
 * Returns the URL only if it resolves to a safe scheme (http/https/mailto),
 * otherwise `undefined` — neutralizing `javascript:`, `data:`, `vbscript:`,
 * etc. (stored-XSS). Use everywhere a stored URL is rendered as a link:
 *
 *   <a href={safeHref(client.website)} …>
 *
 * This also protects historical rows that were stored before validation.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    // The URL constructor strips control chars/whitespace, defeating the usual
    // `java\tscript:` style obfuscations before we read the protocol.
    const protocol = new URL(url, 'https://invalid.invalid').protocol;
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      return url;
    }
  } catch {
    // Unparseable — treat as unsafe.
  }
  return undefined;
}

/**
 * Zod schema for an optional user-supplied website field: empty/undefined, or a
 * value that explicitly starts with http(s):// (rejecting javascript:, etc. at
 * the write boundary). Pair with `safeHref` on render for defense in depth.
 */
export const optionalWebsiteUrl = z
  .string()
  .trim()
  .refine((v) => v === '' || /^https?:\/\//i.test(v), {
    message: 'Website must start with http:// or https://',
  })
  .optional();
