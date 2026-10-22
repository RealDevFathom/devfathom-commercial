# GitHub issue #479 is already fixed

Issue #479 reported that the pharmacovigilance mutations and DRAP export were guarded only by
`auditedProtectedProcedure`, allowing any active organization member to use them. The current code
already applies the existing `reports:operational` capability procedure to all four endpoints:

- `src/server/routers/pharmacy-reports.ts:44` defines `reports` as
  `capabilityProcedure('reports:operational')`.
- `src/server/routers/pharmacy-reports.ts:179` uses `reports` for
  `createPharmacovigilanceReport`.
- `src/server/routers/pharmacy-reports.ts:225` uses `reports` for
  `transitionPharmacovigilanceReport`.
- `src/server/routers/pharmacy-reports.ts:245` uses `reports` for
  `recordPharmacovigilanceSubmission`.
- `src/server/routers/pharmacy-reports.ts:287` uses `reports` for
  `exportPharmacovigilanceDrap`.

Focused regression coverage is also present at
`src/server/routers/pharmacy-reports.test.ts:278-329`. It exercises all four endpoints without the
capability and verifies that each request is forbidden before any branch or report data access.

The fix is present in commit `9dfa46bfa2ab2c1a2c60a0f7b6331a4fb4a781cd` (`fix(#479)`). No
additional code change is needed.
