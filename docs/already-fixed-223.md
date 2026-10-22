# GitHub issue #223: already fixed

The platform logo home link already has an accessible name in the current code, so no
implementation change is needed.

## Evidence

- `src/components/platform/platform-shell.tsx:241-248` renders the `/platform` logo link with
  `aria-label="DevFathom platform home"`. The label remains available to assistive technology at
  the 390px breakpoint even though the adjacent visible wordmark is hidden until `sm`.
- `src/components/platform/platform-shell.test.tsx:42-50` renders the shell and finds the logo by
  its `link` role and `DevFathom platform home` accessible name, while also verifying that it links
  to `/platform`.

The existing fix is isolated to accessible naming and does not alter authorization, tenant
isolation, pharmacy permissions, messaging behavior, or logging.
