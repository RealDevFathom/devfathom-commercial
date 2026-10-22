# Restaurant branches gap fixes — 2026-10-22

## Verification and issue exclusion

I verified the three highest-impact **High/Medium** findings in
`docs/rgap-restaurant-branches-20261022.md` against the current checkout before changing code. All
three were still present:

1. timezone and business-day-cutoff updates did not inspect already scheduled work;
2. deactivation submitted immediately from a neutral button without confirmation or success
   acknowledgement; and
3. server validation/conflict errors were toast-only and the form did not mirror all deterministic
   constraints.

No finding was skipped as already fixed. I also attempted `gh issue list --state open --limit 100
--json number,title,body,url`; the checkout has no Git remote and GitHub CLI has no authenticated
account, so the private repository's open issues could not be authoritatively checked. No finding
is known from this checkout to be covered by an open issue.

The report's Critical concurrency finding was not selected because this follow-up was explicitly
limited to the top three High/Medium findings.

## Changes

- **Scheduling configuration guard:** an update that changes timezone or cutoff now counts future
  scheduled shifts and unresolved future SOP occurrences inside the existing tenant-scoped,
  organization-locked transaction. It refuses the update with the exact affected counts and
  actionable rescheduling guidance; unchanged scheduling values do not trigger the guard.
  (`src/server/routers/restaurant-branches.ts:171-195`)
- **Unambiguous field conflicts:** create/update conflicts distinguish duplicate names from duplicate
  codes so the UI can associate the response with the correct input.
  (`src/server/routers/restaurant-branches.ts:112-134`,
  `src/server/routers/restaurant-branches.ts:196-210`)
- **Safe deactivation:** active branches use the destructive treatment and open a focus-managed
  dialog naming the branch and explaining immediate terminal/operational impact. Only the dialog's
  destructive action submits, and successful activation/deactivation is acknowledged.
  (`src/components/restaurant/restaurant-branches-console.tsx:111-118`,
  `src/components/restaurant/restaurant-branches-console.tsx:217-231`,
  `src/components/restaurant/restaurant-branches-console.tsx:368-403`)
- **Accessible field errors:** formatted server validation and conflict errors are persisted beside
  their inputs, wired through `aria-invalid`/`aria-describedby`, and the first invalid field is
  focused. Name/address lengths and branch-code syntax now mirror server constraints in HTML while
  the server remains authoritative.
  (`src/components/restaurant/restaurant-branches-console.tsx:65-109`,
  `src/components/restaurant/restaurant-branches-console.tsx:241-330`)
- **Behavioral coverage:** router tests cover blocking/allowing scheduling changes based on future
  work, and component tests cover the deactivation confirmation, deterministic constraints, and
  accessible server-error association.
  (`src/server/routers/restaurant-branches.test.ts:190-212`,
  `src/components/restaurant/restaurant-branches-console.test.tsx:85-137`)
