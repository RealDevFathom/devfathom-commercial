# Issue #220 — already fixed

Issue #220 is already fixed in the current mainline snapshot.

## Verification

- `src/server/routers/anonymous-fallback.ts` copies `shape.data` into a new object and explicitly deletes `data.stack` before returning the formatted error.
- `src/server/trpc.ts` applies the same unconditional stack removal to errors from the real router.
- `src/server/routers/anonymous-fallback.test.ts` exercises both reported anonymous procedures, `invitations.get` and `passwordReset.reset`, through the fallback and real tRPC instances. Its response helper records whether any `stack` key was present, and each procedure test asserts equal stack presence and equal response bodies.
- Commit `fb3e4d85635ecf84825f7428b869dbb51d9cf981` introduced the fallback stack removal and records that both affected cases failed without the change and passed with it.

Per the task constraint for the old environment, this verification was performed by source and history inspection only; no dependencies were installed and no tests were run.
