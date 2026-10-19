# Runbooks

**Snapshot:** 2026-07-12

**Standing caveat (Verified):** there is no health endpoint, error tracker, metric pipeline, or alerting. Every runbook below therefore starts from a user report or a manual log check — detection is the weakest step in all of them until risk R-008 closes. Commands assume the Vercel CLI is linked to project `dev-fathom-hub`.

## Severity model (Proposed)

| Severity | Definition                                                                    | Examples                                            | Response                                   |
| -------- | ----------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------ |
| SEV-1    | Hub unusable for everyone, data loss occurring, or active security compromise | Database down, credential leak, corrupted writes    | Immediate, all-hands, updates every 30 min |
| SEV-2    | A Tier-1 workflow broken with no workaround                                   | Invoices cannot be created; login broken for a role | Same working day                           |
| SEV-3    | Degraded but workable                                                         | Realtime down, assistant down, video down           | Next working day                           |
| SEV-4    | Cosmetic or single-user                                                       | UI glitch, one stuck record                         | Backlog                                    |

**Incident lifecycle:** detect → declare severity + owner → mitigate (stop the bleeding) → communicate → resolve → postmortem (template at the end). Every SEV-1/SEV-2 gets a postmortem.

## 1. Production deployment

Normal operation, not an incident — follow the [release checklist](../governance/RELEASE-CHECKLIST.md). Mechanics in [deployment and environments](DEPLOYMENT-ENVIRONMENTS.md). Key discipline: promote the validated Preview build; record the previous deployment ID before promoting; verify the canonical alias afterward.

## 2. Rollback

- **Trigger:** post-deploy verification fails or a regression is reported shortly after release.
- **Verify:** confirm the symptom is new to this deployment (check the previous deployment's Preview URL if still live).
- **Act:** `vercel rollback` (or dashboard → Deployments → previous Ready production deployment → Promote). Instant — no rebuild.
- **Caution:** if the release included a schema change, the previous app version must be compatible with the current database. Expand/contract discipline makes this true; until migrations exist (R-002), any `db push` schema change makes rollback **unsafe** — prefer roll-forward with a fix.
- **Recover:** re-run the smoke pass on the restored version; announce.
- **Follow-up:** the failed deployment gets a postmortem entry; fix goes through the full checklist.

## 3. Database outage or degradation

- **Symptoms:** widespread 500s; tRPC failures. Note (Verified): JWT claim refresh **fails open**, so already-logged-in users keep stale sessions while all data operations fail — the app looks half-alive.
- **Verify:** provider status page/console; connection test from a local shell with the production `DATABASE_URL` (never paste the value anywhere).
- **Consider pool exhaustion:** `pg.Pool` is `max: 10` **per function instance**; a traffic spike multiplies instances and can exhaust the provider's connection cap. Check the provider's connection count. Mitigation: reduce concurrency (pause deployments/traffic), or move to a pooled connection string (PgBouncer/provider pooler).
- **Recover:** if the instance is lost, restore per the [business-continuity procedure](BUSINESS-CONTINUITY.md#database-restore-procedure-proposed) — restore to a new instance, validate, switch `DATABASE_URL`, redeploy.
- **Follow-up:** record measured RPO/RTO in the evidence log; revisit R-020 (fail-open sessions) and the unverified aggregate-connection budget.

## 4. Authentication or session compromise

- **Trigger:** suspected credential theft, leaked `AUTH_SECRET`, or a session behaving as the wrong user.
- **Act, in order:**
  1. **Single account:** admin resets the user's password (bumps `tokenVersion`, revoking that user's sessions ≤ ~1 min later); review that user's `AuditLog` rows.
  2. **Systemic / secret leak:** rotate `AUTH_SECRET` in Vercel Production and redeploy — this invalidates **every** JWT at once (all users sign in again). Then rotate any other exposed secrets per runbook 5.
  3. Deactivate compromised accounts (status change removes them from `ACTIVE_STATUSES`; tRPC/REST access stops on the next claim refresh or token check).
- **Known gap (Verified):** `/api/assistant`, `/api/ably-token`, `/api/upload`, and `/api/files/[name]` check session identity but not current account status — a deactivated user's still-valid JWT can use them until the token expires (≤ 8 h) or `AUTH_SECRET` rotates. For a real compromise, rotate the secret; don't rely on deactivation alone.
- **Follow-up:** audit review for the exposure window; postmortem; prioritize MFA policy (OD-004).

## 5. Secrets rotation

- **Inventory:** the [environment catalogue](../reference/ENVIRONMENT-VARIABLES.md) lists every variable, its consumer, and failure behavior. Values live only in Vercel and issuer consoles.
- **Generic procedure:** create the new credential at the issuer → update the Vercel env var in Production (and Preview if applicable) → redeploy → verify the consumer works → revoke the old credential at the issuer → log the rotation (date, variable name, rotator — never the value).
- **Variable-specific notes:**
  - `AUTH_SECRET`: rotation signs out everyone; schedule deliberately unless responding to compromise.
  - `DATABASE_URL`: rotate the DB password at the provider; expect a brief connection blip.
  - `ABLY_API_KEY`: clients hold ≤ 30-min tokens; old tokens die naturally after rotation.
  - `JAAS_PRIVATE_KEY`/`JAAS_KID`: generate a new key pair in the 8x8 console; signed room JWTs last 2 h.
  - `EMAIL_TOKEN_ENC_KEY`: rotating **orphans every stored mailbox refresh token** (AES-GCM decrypt fails). Users must reconnect mailboxes. Feature is currently disabled, so rotation is free today.
  - API tokens (`df_…`) and webhook secrets are application records, not env vars — runbooks 13 and 12.

## 6. Ably outage

- **Symptoms:** chat/typing/presence frozen; messages appear only after refresh.
- **Verify:** Ably status page; `/api/ably-token` response (503 means config missing, not vendor outage). Note (Verified): server publish helpers are silent no-ops on failure — writes keep persisting, so no data is lost.
- **Act:** nothing destructive — announce degraded mode ("refresh to see new messages").
- **Follow-up:** production logs previously showed an Ably timeout group (unverified currently); if recurring, capture instances and open a vendor ticket.

## 7. AI outage or cost spike

- **Outage symptoms:** assistant errors; everything else fine. Verify Google AI status; check `GEMINI_MODEL` validity after any model-name change.
- **Cost spike:** there is **no in-app kill switch, rate limit, or budget** (`/api/assistant` accepts unvalidated bodies, R-010). To stop spend immediately: remove/rotate `GOOGLE_GENERATIVE_AI_API_KEY` in Vercel and redeploy (assistant fails gracefully; app unaffected), and/or cap the key in the Google console.
- **Follow-up:** review audit rows (`assistant.*` actions) for the driving user/pattern; accelerate R-010 controls.

## 8. Brevo / transactional-email outage

- **Symptoms:** invites, password resets, invoice sends, HR notices not arriving. In-app records are still created (Verified: `sendEmail` throws per call; callers vary in how loudly they surface it).
- **Verify:** Brevo dashboard/status; sender reputation and suppression list.
- **Act:** wait out vendor outage; afterward re-trigger flows (re-send invite, user re-requests reset). **Never** copy raw tokens/links out of the database by hand — they are stored hashed for good reason; re-issue instead.
- **Follow-up:** delivery/bounce monitoring is undocumented (diligence gap) — assign an owner.

## 9. Email OAuth / connected-mailbox incident

- **Current state (Verified):** the feature is disabled by missing configuration, and must stay disabled until OAuth state validation and Microsoft ID-token verification are fixed (R-005).
- **If it was enabled and is now suspect:** disable by removing provider OAuth variables (connect buttons vanish, `isProviderConfigured` gates); revoke grants in the Google/Microsoft consoles; delete `Mailbox` rows (cascades cached `EmailMessage` rows); rotate `EMAIL_TOKEN_ENC_KEY` (orphans any remaining tokens by design).

## 10. JaaS / video outage

- **Symptoms:** "Video calling is not configured" (config missing — check `NEXT_PUBLIC_JAAS_APP_ID`, `JAAS_KID`, `JAAS_PRIVATE_KEY`) vs join failures/black screens (vendor outage — check 8x8 status).
- **Act:** announce fallback to an external meeting link; meeting records and attendance history are unaffected.

## 11. File-storage incident

- **Reality (Verified, R-001):** uploads live on function-local disk. Instance recycle/redeploy loses them silently; database rows keep pointing at `/api/files/<name>`.
- **Symptoms:** attachment and document downloads 404 while records look intact.
- **Act:** confirm scope (which records reference missing files — `MessageAttachment`, `ProjectFile`, `Document` URLs); announce honestly; ask owners to re-upload critical files.
- **There is no recovery** — no backup exists for these files. Every occurrence is more evidence for D-012 (durable object storage); this runbook's real fix is that migration.

## 12. Webhook failure or SSRF response

- **Delivery failures:** check `WebhookDelivery` rows (admin UI → webhooks; last-20 view). Single-attempt delivery means a receiver blip loses the event (R-023) — re-trigger the business action or hand-deliver the payload to the consumer.
- **SSRF / malicious target (Verified gap, R-006):** URL validation accepts any http(s) target including internal addresses.
  1. Deactivate or delete the webhook (admin UI; delete cascades its delivery history — screenshot/export first for forensics).
  2. Review `AuditLog` for who created/updated it and `WebhookDelivery` for what was sent where.
  3. Treat delivered payload contents as disclosed; assess sensitivity (payloads are small — task/invoice IDs and amounts — Verified).
  4. Rotate the webhook secret by recreating the hook once the target is trusted.
- **Follow-up:** implement private-network/redirect blocking before webhook management is treated as safe admin functionality.

## 13. API-token compromise

1. Admin → settings → API tokens → **revoke** (hard delete; next request 401s immediately — Verified).
2. Review usage: audit rows carry `tokenId`, `tokenName`, IP, user agent, path, and outcome for every REST call (Verified) — establish what the token read/wrote via its bound user's attribution.
3. Re-issue with the narrowest scopes; remember write scopes imply read, and finance endpoints additionally require an admin-bound token.
4. If the token was scope `*` and admin-bound, treat as an account compromise (runbook 4) for the bound user.

## 14. Data repair

For corrupted or mistaken records (bad import, wrong bulk change, gap after restore):

1. **Snapshot first** — confirm a backup/PITR point covering the pre-damage state before touching anything.
2. Diagnose in read-only queries; write the repair as an idempotent script (see `prisma/backfill-attendance-log.ts` as the house pattern) with a dry-run mode.
3. Four-eyes review of the script; run against a restored copy first when the blast radius is more than a handful of rows.
4. Execute inside a transaction where feasible; record an `AuditLog`-visible trace (run the script with a clear actor/reason in its output; attach output to the incident record).
5. Verify with the same queries used to diagnose; announce closure.

## 15. Postmortem template

```text
Incident:           <one-line title>
Date/duration:      <detected → resolved, UTC>
Severity:           SEV-<n>
Owner:              <name>
Impact:             <who/what, quantified where possible>
Detection:          <how we found out — user report vs monitoring; time to detect>
Timeline:           <timestamped events>
Root cause:         <technical + contributing process causes>
What went well:     <...>
What went poorly:   <...>
Action items:       <owner → action → due date → linked risk-register ID>
Evidence:           <logs, deployment IDs, audit queries, screenshots>
```

File postmortems under `docs/operations/postmortems/` (create on first use) and link action items to the [risk register](../executive/RISK-REGISTER.md).
