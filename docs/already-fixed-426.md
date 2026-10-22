# GitHub issue #426 — verification and follow-up

Static verification found that commit `5a5fe05a5b200280d96bfc8592471e88b185f9cb` fixed the
original false-success UI, but not the Agency preflight or retry-idempotency follow-ups. Those gaps
are addressed in the current change.

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
- `scripts/agency-e2e-environment.ts` now requires live delivery credentials and an HTTPS app URL
  before the Agency lane can start.
- `src/server/routers/team.ts` derives a stable token from the UI's operation UUID and passes that
  UUID as the provider idempotency key, so a retry cannot rotate a delivered link or duplicate a
  provider request.

Per the issue request, this conclusion and the follow-up were completed by reading the code only;
no dependency installation, database access, or test execution was performed.
