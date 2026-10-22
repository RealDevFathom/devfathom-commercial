# GitHub issue #76 is already fixed

Verified against the current tree on 2026-10-22. The candidate report was produced from
`6cc482c82dbc8036888e51ef4b189ac63d926ad2`; that object is not present in this shallow checkout,
so this verification uses the reported affected surfaces and the current implementation rather
than claiming a historical commit diff.

No runtime change is needed:

- Shared buttons replace the browser outline with a three-pixel semantic `ring` focus indicator,
  including a focused border (`src/components/ui/button.tsx:7`). Shared inputs use the same
  treatment (`src/components/ui/input.tsx:12`). These primitives cover the ordinary actions and
  fields on the reported screens.
- Restaurant catalogue controls define a three-pixel `focus-visible` ring
  (`src/components/restaurant/catalog/catalog-console.tsx:155`), as do menu controls
  (`src/components/restaurant/menus/menus-console.tsx:192`), menu-import controls
  (`src/components/restaurant/menu-import/menu-import-console.tsx:101`), POS controls
  (`src/components/restaurant/pos/order-pad.tsx:99`), KDS controls
  (`src/components/restaurant/kds/kds-board.tsx:465`), camera setup controls
  (`src/components/restaurant/restaurant-camera-wizard.tsx:69`), and terminal controls
  (`src/components/terminal/terminal-console.tsx:744`). Inventory imports the shared `Button` and
  `Input` primitives directly (`src/app/(app)/restaurant/inventory/page.tsx:5-6`).
- Tenant navigation links have a two-pixel semantic focus ring
  (`src/components/layout/sidebar.tsx:874-880`). The platform shell applies the same treatment to
  its brand link (`src/components/platform/platform-shell.tsx:242-245`) and navigation links
  (`src/components/platform/platform-shell.tsx:313-319`).
- The platform workspace provides a fallback visible outline for every keyboard-focused button,
  link, and disclosure control (`src/app/globals.css:1537-1542`) and a three-pixel focus halo for
  its inputs, selects, and textareas (`src/app/globals.css:1459-1462`). This covers the nine
  platform routes as a shell-level invariant rather than duplicating route-local styles.

The indicators use the semantic `ring`/`--ring` token, remain present for keyboard focus via
`:focus-visible`, and do not alter authorization, tenant isolation, pharmacy exact-grant rules, or
the live WhatsApp send block.
