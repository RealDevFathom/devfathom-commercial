# Issue #76: proof on `origin/main`

Issue #76 requires a visible keyboard-focus indicator on the reported restaurant and platform
controls, using the product's semantic focus color, without weakening authorization or tenant
isolation. This is a proof of the implementation already present on `origin/main`, not a claim that
this branch introduced those styles.

## Audited baseline

The evidence below was read from `origin/main` at
`16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca` (the parent of this branch's original issue commit).
Line references are to that immutable commit and can be reproduced with:

```sh
git show 16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca:<path> | nl -ba
```

## Acceptance-criterion evidence

### 1. Buttons and text inputs have an obvious keyboard-focus treatment

The shared button primitive removes the default outline only while supplying a three-pixel
`focus-visible` ring and focused border in the semantic `ring` color
(`src/components/ui/button.tsx:6-7`). The shared input supplies the same three-pixel semantic
`focus-visible` ring and border (`src/components/ui/input.tsx:8-15`). Thus the replacement outline
is not left without a visible keyboard indicator.

### 2. Restaurant controls named in the issue retain the same treatment

The reported native selects and fields each carry a three-pixel semantic `focus-visible` ring:

- catalogue: `src/components/restaurant/catalog/catalog-console.tsx:152-155`;
- menus: `src/components/restaurant/menus/menus-console.tsx:189-192`;
- menu import: `src/components/restaurant/menu-import/menu-import-console.tsx:98-101`;
- POS operator selection: `src/components/restaurant/pos/order-pad.tsx:94-100`;
- KDS operator selection: `src/components/restaurant/kds/kds-board.tsx:458-465`;
- camera setup: `src/components/restaurant/restaurant-camera-wizard.tsx:68-69`; and
- terminal operator selection: `src/components/terminal/terminal-console.tsx:737-744`.

The inventory route imports and therefore uses the shared `Button` and `Input` primitives
(`src/app/(app)/restaurant/inventory/page.tsx:5-6`). This meets the criterion without duplicating
route-local focus CSS.

### 3. Tenant and platform navigation links have visible keyboard focus

Tenant sidebar links include a two-pixel `focus-visible:ring-ring` indicator
(`src/components/layout/sidebar.tsx:874-880`). The platform brand link does too
(`src/components/platform/platform-shell.tsx:242-245`), as do platform navigation links
(`src/components/platform/platform-shell.tsx:305-319`).

### 4. Every platform-console route has a focus fallback

The console layout wraps every route in `PlatformShell`
(`src/app/platform/(console)/layout.tsx:4-19`), and that shell's root has the
`platform-workspace` class (`src/components/platform/platform-shell.tsx:199`). Within that scope,
inputs, selects, and textareas receive a three-pixel focus halo
(`src/app/globals.css:1455-1462`), while buttons, links, and disclosure summaries receive a
two-pixel semantic `--ring` outline on `:focus-visible` (`src/app/globals.css:1532-1542`). This is a
shell invariant, so it covers the platform index plus the audit, catalogue, commercial, CRM,
deployments, health, jobs, operators, organizations, settings, and support routes rather than
depending on each page to repeat the rule.

### 5. Security behavior is unchanged

All cited evidence is presentation code or primitive imports. It changes no router, policy,
database, capability, tenant, branch, pharmacy-grant, or WhatsApp-send path. The regression guard
added with this note reads source files only; it cannot grant access. Existing DENY-over-ALLOW and
tenant-isolation behavior therefore remain unchanged.

## Regression guard

`tests/focus-visible-contract.test.ts` locks the shared primitives, every issue-named restaurant
surface, tenant and platform navigation, and the platform shell fallback to their semantic visible
focus contracts. It also proves that the platform console layout actually composes the shell. This
turns the mainline evidence into a failing check if a future refactor removes one of the focus
indicators.
