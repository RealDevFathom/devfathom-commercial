# GitHub issue #153 is already fixed

Issue #153 reported a serious WCAG color-contrast failure in notification metadata on the
restaurant notifications page. The current code already contains the focused fix from commit
`438d158` (`fix(restaurant): use contrast-checked token for notification meta text (#153)`).

## Current-code evidence

- `src/app/(app)/restaurant/notifications/page.tsx:570` renders the notification's read timestamp
  with `text-text-muted`, rather than the low-contrast `text-text-faint` token.
- `src/app/(app)/restaurant/notifications/page.tsx:575` renders the related-entity metadata with
  the same contrast-checked `text-text-muted` token.
- `src/app/globals.css:932` defines the light-theme `--text-muted` value as `#6c6c68`; the adjacent
  `--text-faint` value at line 933 is not used for these metadata nodes.
- `src/app/globals.css:1005` defines the dark-theme `--text-muted` value as `#aaa9a3`, so the page
  continues to use the theme-aware semantic token rather than a page-specific color override.
- `src/app/(app)/restaurant/notifications/page.test.tsx:127-164` contains a focused regression test
  that renders both affected metadata lines and asserts that each uses `text-text-muted` and never
  `text-text-faint`.

No implementation or test changes are needed: the affected nodes and their regression coverage
are already present on the current branch.
