# Issue #220 — already fixed

Issue #220 is already fixed in the current code, so no implementation change is needed.

## File-and-line evidence

- `src/server/routers/anonymous-fallback.ts:50-60` builds a fresh error `data` object, deletes
  `data.stack`, and returns the sanitized data from the anonymous fallback formatter.
- `src/server/trpc.ts:127-136` performs the same unconditional stack removal in the real router's
  formatter, so neither response exposes a server stack.
- `src/server/routers/anonymous-fallback.test.ts:127-150` covers the reported
  `invitations.get` and `passwordReset.reset` refusals, compares the fallback response with the real
  router response, and records stack presence separately from the response-body comparison.
- `src/server/routers/anonymous-fallback.test.ts:74-94` detects and removes any nested `stack` key
  only for comparison. The absence guarantee itself comes from the unconditional deletion in both
  formatters above; this helper prevents a stack value from obscuring formatter-parity failures.

The follow-up security review classified this issue's documentation-only delta as passing. Its
shared authorization hold is outside issue #220 and does not change the stack-removal conclusion.

Per the issue instructions, this conclusion was reached by inspecting the current source and Git
history only. No dependencies were installed and no tests were run.
