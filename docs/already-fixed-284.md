# GitHub issue #284 is already fixed

Verification against the current code shows that both affected personas retain
purchase and Goods-in authorization through `pharmacy:procurement`:

- The pharmacy Manager system template explicitly grants
  `pharmacy:procurement` (`src/lib/vertical-catalog.ts:786-790`).
- The static procurement policy allows tenant administrators when no custom
  role or user decision applies (`src/lib/abac/policies.ts:235-238`).
- `can()` evaluates tenant-scoped user and role rules before static policies,
  returns an explicit `DENY` before any `ALLOW`, and only falls through to the
  administrator policy when there is no custom decision
  (`src/lib/abac/index.ts:35-58`, `src/lib/abac/index.ts:73-93`).
- Focused coverage asserts that a Manager and a tenant `ADMIN` without an
  assigned role are allowed procurement, while an explicit administrator
  override `DENY` still wins (`src/lib/abac/index.test.ts:135-160`).
- The canonical template matrix also records procurement as an intended Manager
  grant (`src/lib/abac/capabilities.test.ts:6-29`).

No authorization code change is required for issue #284.
