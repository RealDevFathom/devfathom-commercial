# GitHub issue #426 — already fixed

Static verification against the current branch shows that issue #426 was already fixed by
commit `5a5fe05a5b200280d96bfc8592471e88b185f9cb` (`fix(#426): codex off main`). No additional
production-code change is required.

## Evidence

- `src/server/routers/team.ts:215-242` commits the invitation before attempting delivery, records
  either `SENT` or the typed `EMAIL_DELIVERY_FAILED` result, and returns that result together with
  the copyable invitation URL. A provider failure therefore remains recoverable without being
  represented to the caller as a successful send.
- `src/app/(app)/team/team-content.tsx:305-310` stores the returned delivery status rather than
  assuming that a successful mutation means successful email delivery.
- `src/app/(app)/team/team-content.tsx:373-397` renders distinct sent and delivery-failed states and
  explicitly tells the administrator that no email was delivered.
- `src/app/(app)/team/team-content.tsx:406-423` retains the invite-link fallback and offers a resend
  action after delivery failure.
- `src/lib/email/theme.ts:56-77` parses the configured application URL and rejects a non-HTTPS
  public URL in production while retaining loopback HTTP for local production-build checks.
- `src/server/routers/team.invite.test.ts:116-140` covers both the typed failure response with a
  preserved invitation and the explicit success response.
- `src/app/(app)/team/team-content.test.tsx:110-141` covers the failed-delivery message, copy-link
  fallback, resend action, and transition to a successful-delivery state.
- `src/lib/email/theme.test.ts:7-27` covers rejection of public production HTTP, acceptance of
  production HTTPS, and the local loopback exception.

Per the issue request, this conclusion was reached by reading the current code only; no dependency
installation, database access, or test execution was performed.
