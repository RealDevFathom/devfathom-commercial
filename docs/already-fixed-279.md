# GitHub issue #279 is already fixed

Issue #279 reported that a terminal comp created co-authorization evidence with a null
`terminalSessionId`. The current code already carries the authenticated, active terminal session
through the complete comp path:

- The terminal comp route passes `ctx.session.id` to `compLine` as `terminalSessionId`
  (`src/app/api/restaurant/checkout/comp/route.ts:24-31`). This value comes from the authenticated
  terminal request context rather than caller-controlled request data.
- `compLine` accepts that trusted session identifier and includes it when it persists the comp's
  co-authorization record (`src/lib/restaurant/bills.ts:846-855`,
  `src/lib/restaurant/bills.ts:994-1003`).
- The shared co-authorization builder preserves a non-blank session identifier in the normalized
  record (`src/lib/restaurant/co-authorization.ts:103-119`).
- Focused route/database coverage performs a terminal comp, reads the resulting co-authorization,
  and asserts both a non-null `terminalSessionId` and its relation to the active session for the
  same device (`src/lib/restaurant/terminal-checkout.db.test.ts:725-751`).

No additional production-code change or migration is required for #279.
