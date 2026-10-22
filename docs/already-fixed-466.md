# Issue #466 — already fixed

Issue #466 asks to recover the work associated with WHA-8 from
`archive/wip/WHA-8-dirty`. The current tree already contains the WHA-8 outcome,
so no archived code has been ported.

## Current-code evidence

- `src/components/layout/sidebar.tsx:543-552` resolves every navigation entry to
  its owning module and rejects an entry when that module's vertical differs
  from the tenant vertical. This remains fail-closed even when a tenant was
  mistakenly granted a module owned by another vertical.
- `src/components/layout/sidebar.test.tsx:153-173` covers the navigation policy:
  vertical-owned Agency links are hidden from Restaurant tenants, baseline
  navigation remains available, and shared platform modules still require a
  grant.
- `src/components/layout/sidebar.test.tsx:280-307` adds the inverse and
  mis-provisioning cases: Restaurant and Agency tenants cannot see Pharmacy
  routes, and Pharmacy tenants cannot see Restaurant or Agency routes even
  when those module keys appear in their grants.
- `src/lib/platform/commands.ts:1855-1887` enforces the same vertical boundary
  at the server-side module-enablement command, using the persisted tenant and
  module verticals and rejecting mismatches before any upsert.
- `src/lib/platform/commands.vertical.test.ts:754-794` proves that same-vertical
  and shared-platform enablement remains allowed while both cross-vertical
  directions are rejected without writing.

Together, these checks preserve tenant isolation without weakening the shared
module rules. They do not touch authorization precedence, exact-grant pharmacy
permissions, WhatsApp delivery, or logging.

## Archive disposition

Commit `a9051a78` was not imported. No archive hunk was applied because the
current production guards and focused regression coverage above already supply
the valuable WHA-8 behavior; replaying a dirty worktree snapshot would add no
needed fix and could regress the subsequently expanded Pharmacy and Hospitality
vertical catalogue.

The archived object is not present in this intentionally shallow checkout, and
the checkout has no `origin` remote. A direct HTTPS retrieval was also blocked
by the environment's 403 network proxy. Consequently, a byte-for-byte archive
diff could not be reproduced locally. This disposition is based on the issue's
WHA-8 identifier and the explicit WHA-8 implementation marker at
`src/components/layout/sidebar.tsx:546-548`, corroborated by the bidirectional
tests listed above.

### Skipped work

- **The archived dirty-worktree commit (`a9051a78`) in full:** skipped because
  the required behavior is already implemented and covered on the current
  branch, while the unavailable archive object prevents safely selecting any
  additional independent hunk.
- **Any historical catalogue snapshot in that commit:** skipped because the
  current catalogue includes later Pharmacy and Hospitality behavior; replacing
  it from a WHA-8-era snapshot would be unsafe and is unnecessary for issue
  #466.
