# DevFathom — Security summary

> **Repo copy, sanitized 10 Nov 2026 (PKT).** Before this file was committed, identifiers were removed or replaced with placeholders: the AWS account ID, EC2 instance, volume and Elastic IP IDs, the public IP address, the load balancer DNS name, IAM user and role names, Secrets Manager secret names, snapshot names, contact email addresses and personal account names. **A second pass after the CTO's review (10 Nov 2026)** also removed stack, database and server names, the production image digest, secret name prefixes, every note on where credentials are kept, and an operational MFA note. The CTO holds the unredacted working copy.
>
> **Facts corrected 10 Nov 2026 (PKT), after the CTO's review against develop `1906b530`:** branch protection and CI, the platform-host guard (it lives in `src/proxy.ts`), who can approve campaigns and close the day or drawer, the catalogue editing gap, the pharmacist review sign-off check, the AI spend report, the controlled-drugs register (partly built), Bedrock profiles, the Azure code that still exists, and new open issues (#995, #996, #1240, DEV-735).

**Audience:** investors and a new CTO.  
**Written:** 2026-11-10 (Asia/Karachi).  
**Sources:** live AWS describe (read-only); repo `RealDevFathom/devfathom-commercial` develop tip `1906b530` (2026-11-07); GitHub repo settings read 10 Nov 2026; internal plan notes (Ask Fathom, HR roles, post-release backlog, security review logs).  
**Convention:** **Built** = evidenced in running infra or current develop code paths reviewed for this doc. **Decided** = Saad/product decision recorded, implementation may be incomplete. **TO CONFIRM** = needs a fresh check.

---

## Plain-language summary

DevFathom is a multi-tenant pharmacy POS. Each pharmacy’s data is meant to stay inside that pharmacy. The database uses **Postgres Row Level Security (FORCE)** so even a buggy query should not cross tenants. Sensitive actions (dispense, safety, catalogue review) are **exact-grant only** — a wildcard admin grant does not get them. Platform SuperAdmin login expects **MFA (TOTP)** unless explicitly disabled.

Production sits in AWS Singapore: private RDS (encrypted, SSL required, not public), public ALB terminating TLS, Fargate tasks that only accept traffic from the load balancer. App secrets are kept outside the code (this document never prints values or says where they are kept).

**Open security work you should know about:** any signed-in user, including a cashier, can edit the medicine catalogue today, including MRP and barcodes (**Sev2**, fix #995 has merge conflicts). Marketing approval is owner-only, so managers are locked out, and closing a drawer needs only the counter permission (fix #996 pending). Input-tax bill flags are wrong on PKR 0 claims (DEV-735, **Sev2**, no PR yet). GitHub Actions is off by Saad's decision; checks run on the AWS worker before every merge instead. Azure code and Azure-only deploy workflows still exist (DEV-755). Develop EC2 root volume is **unencrypted**. Several pharmacy policy items (manager PIN refunds, narcotics flag, per-org WhatsApp tokens, Ask Fathom provider chain on production) are **decided but not fully built / not enabled on prod**. Codex (+ Claude second opinion) security reviews gate merges; they are static reviews, not a penetration test.

**Compliance:** product targets **Punjab** pharmacy practice first. DRAP-related promotion rules were cleared with Saad (no drug names in campaigns). Formal DRAP licensing of the *software* as a medical device / national rollout paperwork is **not claimed here → TO CONFIRM with counsel**.

---

## 1. Tenant isolation (**Built**)

| Control | Status | Evidence |
|---|---|---|
| Postgres RLS + `FORCE ROW LEVEL SECURITY` on core and many domain tables | **Built** | Migration `20260728092000_row_level_security` and follow-ons; Ask Fathom plan notes `current_setting('app.current_organization_id')` + `createTenantDb` |
| App DB role is not superuser; runtime role prep in migrate path | **Built** (per deploy docs) | `docs/deploy/aws.md` migrate command includes `prepare-runtime-role.ts` |
| Host-based tenancy (`admin.` = platform; `{slug}.…` = tenant) | **Built** | `src/proxy.ts`: `/platform` pages only on the admin host; admin-host page requests redirect to `/platform` |
| Platform APIs only on platform host | **Built** for `/api/platform/*` | The guard is in `src/proxy.ts`: `/api/platform/*` returns 404 on any non-admin host (the cron worker endpoint is the only exception). There is **no** `PLATFORM_ONLY_DEPLOYMENT` setting. Other `/api/*` routes pass through the proxy on the admin host and rely on their own auth checks — **TO CONFIRM** that each refuses there |
| Uploads in private per-env S3 buckets | **Built** | TLS-only, versioned (per deploy docs) |
| Future: separate ECS service + DB per large tenant | **Decided direction** | Post-release backlog; Abbasi still on **shared** prod DB today |

---

## 2. Roles, permissions, separation of duties

### 2.1 Capability model (**Built**)

Pharmacy actions go through a central capability/`can()` style gate. Critical actions are **exact-grant only** (wildcards such as `pharmacy:*` do **not** grant them):

- `pharmacy:dispense`
- `pharmacy:prescriptions` (also covered by a dispense grant)
- `pharmacy:safety`
- `pharmacy:catalogue-review`

Other capabilities in active use include `pharmacy:counter`, `pharmacy:close`, `pharmacy:manage`, `pharmacy:procurement`, `pharmacy:inventory`, `pharmacy:orders`, plus report and inventory verbs. Maker/checker style co-approval (`coauth:approve`) exists for sensitive flows.

### 2.2 Role templates (**Built** base set; **Decided** expansions)

**Built templates** (from HR roles plan reading of develop): owner, owner-operator, pharmacist, manager, cashier, procurement, inventory, finance, auditor (names per `PHARMACY_ROLE_TEMPLATES`).

**Decided (Punjab HR plan, largely unbuilt or in flight — TO CONFIRM on latest develop):** Qualified Person, Pharmacy Technician Cat B, Dispenser, Delivery Rider, richer registration fields, PIN re-entry on role/QP changes, Phase-2 Rx blocking by registration.

### 2.3 Product policy decisions vs build status

| Policy | Status | Notes |
|---|---|---|
| Pharmacists can sell, take payment, open cash drawer | **Decided** (2026-11-01) | Enforcement **TO CONFIRM** against current develop |
| Manager or owner approves marketing campaigns and closes the day/drawer | **Decided** (Saad's rule) | **Not what the code does today.** Campaign approval is **owner-only** (tenant admin role + Pharmacy CRM module, `src/server/routers/pharmacy-marketing.ts`), so managers are locked out. Closing the day needs the `pharmacy:close` permission. Closing a **drawer** needs only the **counter** permission (`closeDrawer` in `src/server/routers/pharmacy-sales.ts`). **#996** fixes both (manager or owner) but has merge conflicts and no QA or Security verdict on its latest commit |
| Medicine catalogue edits go through review | **Decided** | **Not built.** Any signed-in user, including a cashier, can create medicines, add pack levels, record printed MRP and add barcodes (`protectedProcedure` in `src/server/routers/pharmacy-medicine.ts`). **Sev2.** **#995** fixes it but has merge conflicts |
| A pharmacist review can't be signed off by the person who requested it | **Partly built** | A database trigger refuses a decision from the user who requested the review. The server code (`pharmacyDispensing.decideReview`) doesn't check this itself, and nothing stops a review being **decided twice**. **Sev3** |
| Refunds: only manager/owner, with PIN (cashiers cannot start) | **Decided** (superseding earlier cashier-starts rule; confirm Saad wording) | Documentation Lead reported **no PIN refund code** on develop as of 2026-11-02 → treat as **not built** until rechecked |
| Narcotics / controlled flag → pharmacist review | **Decided** (product intent) | The **controlled-drugs register is partly built**: register entries with consecutive serials per branch, recorder and witness must be different people (database check), entries must match the stock ledger, entries can't be edited or deleted, and an open incident blocks controlled dispensing (`src/lib/pharmacy/controlled-register.ts`, migration `20260902170000_…`). Whether every controlled line is routed to pharmacist review end-to-end — **TO CONFIRM** |
| Margins visible to Owner, Admin, Finance; Manager own branch | **Decided** | |
| WhatsApp: promote pharmacy / non-drug only; no drug names in campaigns; server enforce | **Decided** | Partial code paths exist; full Ask Fathom OTC/drug-name guards are a PR series |
| Ask Fathom never uses Azure | **Decided** | The routed chain (Anthropic → OpenAI → Bedrock) has no Azure, but **Azure code still exists**: a legacy Azure AI provider in `src/lib/ai/provider.ts`, the Azure storage adapter in `src/lib/storage.ts`, three packages (`@ai-sdk/azure`, `@azure/identity`, `@azure/storage-blob`), and the staging and production deploy workflows, which point only at Azure. It must stay disabled. **Saad ordered Azure removed from all code on 10 Nov 2026.** The removal is planned for the next Codex batch and tracked as Linear [DEV-755](https://linear.app/devfathom/issue/DEV-755/remove-azure-from-the-codebase-entirely) and GitHub [#1437](https://github.com/RealDevFathom/devfathom-commercial/issues/1437). |
| Ask Fathom paid add-on; SuperAdmin sets per-pharmacy credits + WhatsApp limits; server enforce | **Decided** | Production `AiProvider=disabled` today |
| AI budgets: Claude $190 / OpenAI $190 / Bedrock $300 / month shared | **Decided** (caps) | |

---

## 3. Authentication and MFA

| Control | Status | Notes |
|---|---|---|
| Tenant login + optional TOTP | **Built** | Login forms and `/api/login` support `totp` |
| Platform SuperAdmin MFA enforced unless `PLATFORM_MFA_ENFORCE=false` | **Built** | `src/lib/platform/auth.ts` |
| Staging SuperAdmin MFA enrolled | **Done** (2026-10-22 journal) | Unblocked Abbasi org creation |
| MFA enrolment UX: QR beside setup key | **Decided / backlog** | Post-release backlog item |
| PIN for till / approval flows | **Partially built** historically; refund-PIN policy **Decided**, build **TO CONFIRM** | |
| Rate limiting on login | **Built** (tests present) | |

**Handover action:** **force MFA re-enrolment** for every SuperAdmin at handover and issue fresh recovery codes.

---

## 4. Data protection, encryption, backups

### 4.1 Production database (**Built**, verified 2026-11-10)

| Control | Verified |
|---|---|
| Encryption at rest | Yes (`StorageEncrypted=true`) |
| Public accessibility | No |
| `rds.force_ssl` / verify-full for app | Documented in `docs/deploy/aws.md` (Prisma migrate engine encrypts but does not fully verify — known limitation, same as prior Azure) |
| Multi-AZ | **No** (single-AZ `db.t4g.micro`) — availability trade-off for cost |
| Backup retention | **7 days** automated (+ a manual pre-launch snapshot kept) |
| Deletion protection | On |
| PITR window | Standard RDS for retention period — exact restore drill date **TO CONFIRM** |

### 4.2 Application secrets & field encryption (**Built**)

- App secrets per environment (auth secret, platform encryption key, camera credential key, DB URLs, bootstrap passwords), kept outside the code.  
- Platform encryption key retained across stack delete (by design) so encrypted MFA/SSO/camera material remains recoverable only with that key.  
- **Never** store secret values in git, Linear, Slack, or these docs.

### 4.3 Develop EC2 gaps

| Issue | Status |
|---|---|
| Develop EC2 EBS root volume **not encrypted** | **Open finding** (verified) |
| SSH | Prefer SSM only; confirm no lingering open SSH | **TO CONFIRM** |

### 4.4 Backups beyond RDS

- S3 upload versioning (30-day noncurrent per deploy docs).  
- Nightly `pg_dump` to S3 for a future single-box layout is **planned**, not the current prod mechanism.  
- A CloudTrail log bucket exists — whether a full org trail is enabled for all regions **TO CONFIRM**.

---

## 5. Network and platform hardening (**Built** unless noted)

- No NAT gateway; tasks in public subnets with **security group only from ALB:3000**; DB in private subnets.  
- ALB: HTTPS listener, HTTP redirects / no plain HTTP app traffic once cert attached; TLS 1.2 minimum (per deploy docs).  
- `TRUSTED_PROXY_HOPS` required for correct client IP / rate limits.  
- Health: `/api/live` (ALB) vs `/api/ready` (deploy readiness).  
- Fargate **Spot**: cheaper, can interrupt — acceptable for current scale, means brief admin/pharmacy blips.  
- Cloudflare in front of DNS; if orange-cloud proxy is used, SSL mode must be Full (strict). Per-host proxy mode **TO CONFIRM**.

---

## 6. AI / WhatsApp / privacy controls

| Control | Status |
|---|---|
| PII scrubber before model calls (names, PK phones, CNIC, Rx/patient) | **Decided** + planned PRs; partial helpers exist (`mask-personal-data`) — full gate **TO CONFIRM** |
| Metric tools read-only via tenant DB + role/branch scope | **Decided** / in build |
| Writes are drafts until a human confirms | **Decided** |
| OpenAI `store:false` | **Decided** |
| Bedrock fallback uses the `global.anthropic.*` cross-region inference profiles, called from `ap-southeast-1` | **Built** (`src/lib/ai/model-defaults.ts`) |
| No Azure in Ask Fathom chain | **Built** for the routed chain; legacy Azure provider code still exists (DEV-755); prod AI disabled today |
| AI spend report (`platformAIUsage.currentMonth`) | **Built**, SuperAdmin only. Signed-out callers get no data back, but they see an error page instead of a proper "not allowed" response. **Sev3** |
| WhatsApp opt-in + frequency/quiet hours (22:00–09:00 PKT decided) | **Decided**; enforcement completeness **TO CONFIRM** |
| Per-org WABA tokens encrypted | **Decided**; global env token still the older mainline pattern — migration **TO CONFIRM** |

---

## 7. Security reviews done

| Practice | Status |
|---|---|
| Codex automated security reviews on pharmacy branches / PRs | **Ongoing** — many review write-ups in the internal plan notes (Oct 2026 wave and later) |
| Claude second-opinion on PRs | **Process** (Saad rule) |
| CTO + Security approval before merge; Saad for production | **Process** |
| Launch blockers tracked (#518 Rx bypass, #355 recall reactivation, #631 rule-set confirm, #633 batch re-check, etc.) | Addressed or mitigated with SOPs for Abbasi-1 — residual risk depends on what reached the production image; **TO CONFIRM** post-launch patch level |
| Formal external penetration test / SOC2 | **Not claimed** — **TO CONFIRM** if any third-party assessment exists |
| CI checks | **GitHub Actions is off, by Saad's decision (10 Nov 2026)**; all six workflows are disabled. Before every merge, the deterministic checks (lint, typecheck, unit tests, build, Prisma generate, Docker check) run on the AWS worker on the exact final commit, and nothing merges until they all pass. develop currently fails its own unit tests at `1906b530`; Codex will fix it |
| Merge discipline | **#1240** was marked ready for review 52 seconds before it was merged (3 Nov 2026, 06:50 PKT), with no review and no checks |
| Dependency / container scanning in CI | Present in culture (QA machine “scans”); exact tools/pass rates **TO CONFIRM** |

---

## 8. Known open security issues (as of this writing)

1. **Medicine catalogue editable by any signed-in user** — including a cashier, including MRP and barcodes. **Sev2.** Fix **#995** has merge conflicts.  
2. **Marketing approval and drawer close don't match Saad's "manager or owner" rule** — campaign approval is owner-only (managers locked out); closing a drawer needs only the counter permission. Fix **#996** has merge conflicts and no QA or Security verdict on its latest commit.  
3. **DEV-735: input-tax bills with a PKR 0 claim are wrongly flagged** as missing NTN/STRN. **Sev2**, still live, no PR yet.  
4. **GitHub Actions is off, by Saad's decision (10 Nov 2026).** Pre-merge checks run on the AWS worker instead; develop currently fails its own unit tests at `1906b530` (Codex will fix it).  
5. **Deploy workflows are Azure-only.** The staging and production deploy workflows point only at Azure, so there is no automated AWS deploy; deploys are done by hand. All workflows are disabled; `deploy-develop.yml` must stay disabled because it starts after QA gate.  
6. **Azure code still exists** — Azure AI provider, Azure storage adapter, three packages, the deploy workflows, and Azure image names in `qa.yml`. Removal tracked in **DEV-755 / #1437**.  
7. **#1240 was merged with no review and no checks** — marked ready 52 seconds before merge.  
8. **Pharmacist review sign-off** — a database trigger blocks the requester from deciding their own review, but the server code doesn't check it, and a review can be decided twice. **Sev3.**  
9. **AI spend report** (`platformAIUsage.currentMonth`) — signed-out callers get no data, but see an error page instead of a proper "not allowed" response. **Sev3.**  
10. **Develop EBS unencrypted.**  
11. **Refund PIN workflow** — decided, likely unbuilt (recheck develop).  
12. **Narcotic / controlled review flag** — the controlled-drugs register is partly built; end-to-end routing to pharmacist review **TO CONFIRM**.  
13. **Other `/api/*` routes on the admin host** — the `src/proxy.ts` guard covers `/api/platform/*` only; confirm other routes refuse on the admin host.  
14. **Shared prod DB for Abbasi + platform** — stronger isolation (dedicated DB/service) still backlog.  
15. **Production AI disabled** — ensure provider keys never leak into client bundles; rotate any key that was ever shared outside the secrets store.  
16. **QA/agent EC2 fleets** in eu-north-1 with large instance types — attack surface and cost; ensure SSM/IAM scoped.  
17. **Day-close counted cash wiped on full remount** — QA filed **DEV-754** (Sev2); product bug, integrity of cash reconciliation.  
18. **Email still capture mode in production** — reduces email-based reset risk but also means operational mail paths differ from staging plans.  
19. **Branch protection.** `develop` is **unprotected, by Saad's decision (10 Nov 2026)**. `main`'s protection is unchanged: it requires two `verify / …` checks (`verify / Lint, typecheck and formatting`, `verify / Tests, RLS, build and end-to-end`), but no workflow on `main` produces them (the names come from an old workflow that is no longer there), so a PR into `main` can never pass them and can only be merged by an admin, because admins are exempt from `main`'s protection. Nobody should change this unless Saad decides. Nothing merges until the AWS worker checks pass on the exact final commit.

---

## 9. Compliance position (Punjab / DRAP)

| Topic | Position |
|---|---|
| Geographic focus | **Punjab first** (explicit in Ask Fathom and HR plans) |
| Qualified Person / Cat A pharmacist presence | **Decided** product direction; regulatory gate helpers exist (`regulatory.ts`); full shift roster + Rx block = **Phase 2** |
| Punjab Drugs Rules 2007 references | Used in research/planning; software does not replace a licence |
| Campaign / WhatsApp drug advertising | **Decided:** no drug names in promos; Saad noted DRAP clearance for *not* requiring approval-number checks on that rule set — **keep legal memo TO CONFIRM** |
| CNS Act / narcotics register | **Partly built** — controlled-drugs register with witness, consecutive serials and stock-ledger match; full legal fit **TO CONFIRM** with counsel |
| Patient / prescription data | Treated as sensitive; RLS + scrubber intent; retention schedule **TO CONFIRM** |
| Formal DRAP software certification / NDMA / PECA registrations | **Not asserted here** — counsel **TO CONFIRM** |
| Data residency | Primary data in **Singapore** AWS today (not Pakistan). Latency ~70 ms class to PK per cost plan. Whether contracts promise PK residency: **TO CONFIRM** |

---

## 10. Investor / new-CTO diligence checklist

1. Rotate all app secrets and re-enrol SuperAdmin MFA; prove login on `admin.devfathom.com` with new TOTP.  
2. Confirm Abbasi data restore: restore the manual pre-launch snapshot or latest automated snapshot into an isolated instance and compare row counts (**do not** overwrite prod).  
3. Re-read latest develop for refund PIN, narcotics flag, and Ask Fathom provider PRs.  
4. Commission an external pen-test focused on tenancy (cross-org IDOR), `/api` on admin host, and POS privilege escalation.  
5. Get written legal note on DRAP/Punjab advertising + cross-border hosting in Singapore.  
6. Encrypt or replace the develop EBS volume; keep secrets out of plan files.  
7. Land #995 and #996 (after conflicts are fixed and QA + Security pass) and a fix for DEV-735.

---

## 11. TO CONFIRM (security)

1. SuperAdmin MFA re-enrolment done at handover (staging + production).  
2. That every non-platform `/api/*` route refuses on the admin host (the `src/proxy.ts` guard covers `/api/platform/*`).  
3. Current develop code for refund PIN, and end-to-end controlled-drug routing to pharmacist review.  
4. Last successful RDS restore test date.  
5. CloudTrail / GuardDuty / Security Hub enablement.  
6. External pen-test or audit reports, if any.  
7. Legal memo on DRAP + data residency.  
8. Proof that every app secret and operator login was rotated at handover.  
9. Status of DEV-754 fix on a fresh head.  
10. Meta WhatsApp production app review status and token storage model actually deployed.  
11. develop's unit tests passing again at a new tip (Codex fix).
