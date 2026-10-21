# Blocked: PR #174 typecheck resource limit

`NODE_OPTIONS=--max-old-space-size=6144 TMPDIR=/tmp bun run typecheck`
was terminated by SIGKILL (exit 137) twice in this shared 16 GB environment.
The retry ran without another check launched by this task. Other builders were
running concurrently; available memory after the second kill was about 3 GiB.
No third attempt was made, as required by the task's two-attempt stop rule.

Implemented changes are committed, but typecheck has not been verified. Resume
with adequate shared memory and run the same typecheck command before approval.
No full build or full test suite was run.

Validation completed (TZ=UTC):
- Substitute finder, router, and existing counter component tests: 99 passed.
- Canonical resolver integration with existing ABAC and substitute tests: 76 passed.
- Final substitute finder and #107 fail-closed adapter tests: 14 passed.
- Changed TypeScript ESLint: no errors; three unused-parameter warnings in the
  temporary #107 adapter. git diff --check passed.

Dependencies/scope:
- #107 is not in the base. Its duplicate migration/model were removed. The
  documented adapter denies member assignments until its canonical helper lands;
  the existing capability-gated audited organization-admin fallback remains.
- Only the minimal capability matcher and custom decision function from #163
  were ported identically. The global resolver is unchanged because the base's
  legacy growth permissions failed four tests when using the strict matcher.
  Those tests passed after limiting the port to this gate.
- Automatic suggestions are lower-or-equal price, including stockouts. Missing
  reference prices fail closed. The explicit pharmacist override mutation requires
  dispense permission and a nonblank reason; its reason and results are persisted
  to the tenant audit before returning, and audit failure refuses the results.
- Unrelated expiry, stock-signal and counter-alert changes are isolated on
  fix/substitutes-branch-gate-misc, draft PR #189 into improve/ai-growth.
  That draft's focused checks remain pending; no DB tests were run here.
