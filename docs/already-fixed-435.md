# GitHub issue #435: already fixed

Issue #435 asked whether the useful work preserved at
`archive/fix/wa-drug-guard-2` still needed to be recovered. The current tree
already contains the relevant safeguards, including the focused regression
coverage, so no archive commit was ported.

## Current-code evidence

- `src/lib/pharmacy/marketing-copy.ts:1-24` centralizes a fail-closed clinical
  copy check. It normalizes Unicode, removes combining/format characters and
  separators, recognizes split `rx`, and rejects generic medicine/drug terms
  as well as `MS Contin` after compaction.
- `src/lib/pharmacy/marketing-service.ts:55-61` applies that guard and requires
  STOP instructions when a template is reviewed. The template and campaign
  queries remain organization-and-branch scoped at
  `src/lib/pharmacy/marketing-service.ts:89-96` and
  `src/lib/pharmacy/marketing-service.ts:130-143`; regulated outreach remains
  unavailable at `src/lib/pharmacy/marketing-service.ts:154-169` and
  `src/lib/pharmacy/marketing-service.ts:173-201`.
- `src/lib/pharmacy/marketing.ts:62-70` applies the same copy guard before a
  capture plan can be built. Focused cases for separator, full-width,
  zero-width, and named-drug disguises are in
  `src/lib/pharmacy/marketing.test.ts:6-25`.
- `src/lib/pharmacy/whatsapp/messages.ts:37-40` permits messaging only for an
  active, explicitly opted-in customer. Its consent parser normalizes Unicode
  marks, format characters, punctuation, and Roman/Urdu STOP variants at
  `src/lib/pharmacy/whatsapp/messages.ts:42-81`; focused coverage is at
  `src/lib/pharmacy/whatsapp/inbound.test.ts:247-257`.
- `src/lib/pharmacy/whatsapp/inbound.ts:145-198` claims replay identity and
  commits consent changes in one tenant transaction, makes STOP win an
  equal-timestamp race, and rejects stale updates. Provider calls occur only
  after that transaction at `src/lib/pharmacy/whatsapp/inbound.ts:203-228`.
- `src/app/api/pharmacy/whatsapp/webhook/route.ts:61-89` verifies the webhook,
  resolves an explicit active pharmacy tenant, and requires that tenant to own
  the configured sender before processing the body.
- The code-level live-send block is intact:
  `src/lib/pharmacy/whatsapp/provider.ts:278-297` replaces both Meta send
  methods with a deterministic disabled provider while preserving webhook
  verification and parsing.

## Archive disposition

The archive's 22-commit inventory supplied with the issue was compared by
subject and affected behavior with the current implementation. Nothing was
cherry-picked:

- The initial growth skeleton, WhatsApp queue/webhook/consent, order-ready
  template, tenant authentication, provider pinning, review fixes, and send
  gate commits were skipped because those facilities and their stricter
  current safeguards already exist on the current tree.
- The disguised/split medicine-name, generic medicine-promotion, `MS Contin`,
  and normalized Urdu/Roman-Urdu STOP fixes were skipped because the current
  shared copy guard, consent parser, and focused tests contain them.
- The consent-proof retention/minimization commits were skipped because their
  proposed archive/purge behavior has no corresponding pharmacy customer purge
  workflow in the current tree; adding orphan schema and retention machinery
  would not be a minimal recovery and is outside this issue's executable path.
- `BLOCKED.md` additions/removals and typecheck-attempt documentation were
  skipped as historical process artifacts, not product fixes.

The appropriate disposition is therefore **close as obsolete/already fixed**,
rather than re-opening the archived branch or replaying its commits.
