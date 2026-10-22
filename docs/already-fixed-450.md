# Issue #450: archived pharmacy, restaurant, and agency QA work

## Disposition

No code is being recovered from `archive/qa/pharmacy-restaurants-agencies`.
The two archived commits are QA records and issue drafts rather than product
changes:

- `d76bc8ec` — “Record pharmacy QA results and issue drafts.”
- `256fd034` — “Record restaurant QA results and issue drafts.”

Those snapshots are obsolete as implementation inputs. Their valuable findings
are already represented by the current code and focused regression coverage, so
reopening the archive as a PR would reintroduce stale point-in-time QA notes
without changing product behaviour.

## Current-code evidence

- Sensitive pharmacy permissions are centralized in
  `src/lib/abac/capabilities.ts:7-26`. `pharmacy:dispense`,
  `pharmacy:safety`, and `pharmacy:catalogue-review` reject wildcard ALLOW
  grants, while wildcard DENY rules continue to match.
- The authorization decision in `src/lib/abac/index.ts:48-56` collects matching
  user overrides and role permissions before evaluating them, so a DENY from
  either source takes precedence over every ALLOW.
  Missing tenant-scoped database context and permission lookup failures deny
  access at `src/lib/abac/index.ts:73-83`.
- Focused coverage in `src/lib/abac/index.test.ts:148-169` pins DENY precedence
  in both directions: a user DENY defeats a role ALLOW, and a role DENY defeats
  a user ALLOW.
- Focused coverage in `src/lib/abac/capabilities.test.ts:56-64` and
  `src/lib/abac/capabilities.test.ts:97-113` pins exact-grant-only behaviour for
  all three sensitive pharmacy actions.
- The live WhatsApp send block remains in
  `src/lib/pharmacy/whatsapp/provider.ts:278-297`: even when the Meta provider is
  selected, both sending methods return `NOT_CONFIGURED`; webhook verification
  and inbound parsing remain available.

## Skipped archive content

| Archived commit | Decision | Reason |
| --- | --- | --- |
| `d76bc8ec` | Skip | Pharmacy QA results and draft issue text are historical evidence, not a product fix. Current authorization and live-send safeguards have direct code and regression-test coverage listed above. |
| `256fd034` | Skip | Restaurant QA results and draft issue text are historical evidence, not a product fix. Porting a stale QA snapshot would add no runtime behaviour or focused regression coverage. |

No migration, secrets, or generated logs are added. The only runtime correction
is the DENY-precedence fix described above; none of the archived QA-note files
are restored.
