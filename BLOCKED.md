# PR #162 QA follow-up blocked

Stopped at the user's two-failed-attempt limit. Work remains incomplete.

## Changes prepared

- Shared inclusive licence-expiry helper, defaulting to Asia/Karachi, with the stored organization timezone used by save validation and the runtime gate.
- Schema validation routes expired licence errors to licenceValidTo.
- Regulatory status reflects runtime blocking and pending legal review; checklist explains licence/date and legal-review failures.
- Activation fake DB supplies jurisdictionRuleSet.
- Regression tests cover 05:00 PKT and the end-of-day boundary, status labels, and accessible field errors.
- No migrations or tenant RLS were changed.

## Checks and failures

1. Initial focused tests: 96 passed across six files.
2. Expanded focused test attempt: seven workers timed out starting while typecheck was running; no assertions executed.
3. Expanded focused test retry, alone with --maxWorkers=1: 125 passed, one failed across eight files. The new schema assertion expects the exact prefix `Licence valid to:`, but formatValidationError currently emits `Licence Valid To:`. Stopped rather than making a third attempt.
4. `NODE_OPTIONS=--max-old-space-size=6144 TMPDIR=/tmp bun run typecheck` completed with one error: VersionHistory referenced operational outside its scope. This was corrected by passing status and operational as props, but typecheck has not been rerun because the stop limit was reached.
5. Live visual QA across the design contract's viewport/theme/motion matrix has not been completed.

## Next work requiring a new authorized attempt

Resolve the exact licence-field message prefix, rerun the focused tests and one typecheck sequentially, and complete the relevant visual QA. Review the current diff before merging. No PR has been merged.
