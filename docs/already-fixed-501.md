# GitHub issue #501 is already fixed

Issue #501 reports that LiveKit's namespaced participant identities could not be
resolved to admitted meeting participants. The current code already implements
the expected behavior:

- Authenticated admission emits `usr:<userId>` identities
  (`src/lib/meetings/admission.ts:159-179`).
- Guest admission emits `gst:<occurrenceParticipantId>` identities
  (`src/lib/meetings/admission.ts:182-216`).
- The provider event consumer parses non-empty `usr:` identities into `userId`
  lookups and non-empty `gst:` identities into participant `id` lookups; all
  other identity formats remain unattributed
  (`src/server/meetings/provider/events.ts:9-17`).
- Participant resolution remains scoped to the webhook's occurrence before the
  resolved participant and user IDs are written to the attendance session
  (`src/server/meetings/provider/events.ts:58-78`).
- Focused coverage uses the actual admitted member identity, verifies the
  occurrence-scoped member lookup, verifies the admitted guest identity lookup,
  and rejects an unnamespaced identity
  (`src/server/meetings/provider/events.test.ts:20-29,62-95`).

The fix is present in commit `967a0db163abfcb98e4c977ce6ab4e2ab2f47586`,
which is already an ancestor of the current branch. No production or test code
changes are needed for this issue.
