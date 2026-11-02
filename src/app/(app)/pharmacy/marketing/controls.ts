/**
 * Marketing form controls (DEV-601).
 *
 * Boundaries use `--text-muted`: it is the Studio token that holds at least 3:1
 * against the card, raised and sunken surfaces in both themes, where every
 * `--border-*` token measures 1.2–2.7:1 and a control almost disappears in
 * dark mode. Disabled controls keep full opacity (the shared components fade
 * them to 50%): a sunken fill and `--text-muted` text say "unavailable" while
 * the outline and value stay readable. `controls-contrast.test.ts` measures it.
 */

/** Native `<select>` and `<textarea>` controls on the marketing page. */
export const nativeControl =
  'mt-1 min-h-11 w-full rounded-md border border-text-muted bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-muted disabled:opacity-100';

/**
 * Classes the marketing page adds to the shared `Input`. The `dark:` entry only
 * replaces Input's own dark disabled fill with the same token as light mode.
 */
export const inputControl =
  'mt-1 min-h-11 border-text-muted disabled:bg-surface-sunken disabled:text-text-muted disabled:opacity-100 dark:disabled:bg-surface-sunken';

/** Classes the marketing page adds to its submit `Button`. */
export const actionButton =
  'min-h-11 disabled:border-text-muted disabled:bg-surface-sunken disabled:text-text-muted disabled:opacity-100 disabled:shadow-none';
