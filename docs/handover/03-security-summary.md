# DevFathom — Security summary

> **Repo copy, sanitized 10 Nov 2026 (PKT).** Before this file was committed, identifiers were removed or replaced with placeholders: the AWS account ID, EC2 instance, volume and Elastic IP IDs, the public IP address, the load balancer DNS name, IAM user and role names, Secrets Manager secret names, snapshot names, contact email addresses, personal account names, and hints about where credentials are stored. Everything else, including every **TO CONFIRM** item, is unchanged. The CTO holds the unredacted working copy.
>
> **Also updated 10 Nov 2026 (PKT), at Saad's direction:** the missing branch protection on `develop` is recorded as Saad's decision, not an open gap (`main` stays TO CONFIRM), and a note was added that Saad ordered Azure removed from all code (DEV-755 / #1437).

**Audience:** investors and a new CTO.  
**Written:** 2026-11-10 (Asia/Karachi).  
**Sources:** live AWS describe (read-only); repo `RealDevFathom/devfathom-commercial` develop tip observed as `1906b530` (2026-11-07); `/workspace/plan/**` (incl. Ask Fathom, HR roles, post-release backlog, security review logs).  
**Convention:** **Built** = evidenced in running infra or current develop code paths reviewed for this doc. **Decided** = Saad/product decision recorded, implementation may be incomplete. **TO CONFIRM** = needs a fresh check.

---

## Plain-language summary

DevFathom is a multi-tenant pharmacy POS. Each pharmacy’s data is meant to stay inside that pharmacy. The database uses **Postgres Row Level Security (FORCE)** so even a buggy query should not cross tenants. Sensitive actions (dispense, safety, catalogue review) are **exact-grant only** — a wildcard admin grant does not get them. Platform SuperAdmin login expects **MFA (TOTP)** unless explicitly disabled.

Production sits in AWS Singapore: private RDS (encrypted, SSL required, not public), public ALB terminating TLS, Fargate tasks that only accept traffic from the load balancer. App secrets live in **AWS Secrets Manager** (this document never prints values).

**Open security work you should know about:** Saad’s SuperAdmin MFA was exposed in a screenshot and a **reset/re-enrol** was logged as required after launch; treat that as **pending until confirmed done**. Develop EC2 root volume is currently **unencrypted**. Several pharmacy policy items (manager PIN refunds, narcotics flag, per-org WhatsApp tokens, Ask Fathom provider chain on production) are **decided but not fully built / not enabled on prod**. Codex (+ Claude second opinion) security reviews gate merges; they are static reviews, not a penetration test.

**Compliance:** product targets **Punjab** pharmacy practice first. DRAP-related promotion rules were cleared with Saad (no drug names in campaigns). Formal DRAP licensing of the *software* as a medical device / national rollout paperwork is **not claimed here → TO CONFIRM with counsel**.

---

## 1. Tenant isolation (**Built**)

| Control | Status | Evidence |
|---|---|---|
| Postgres RLS + `FORCE ROW LEVEL SECURITY` on core and many domain tables | **Built** | Migration `20260728092000_row_level_security` and follow-ons; Ask Fathom plan notes `current_setting('app.current_organization_id')` + `createTenantDb` |
| App DB role is not superuser; runtime role prep in migrate path | **Built** (per deploy docs) | `docs/deploy/aws.md` migrate command includes `prepare-runtime-role.ts` |
| Host-based tenancy (`admin.` = platform; `{slug}.…` = tenant) | **Built** | `proxy.ts` platform-host rules (described in prod SuperAdmin plan + deploy docs) |
| Platform APIs only on platform host | **Mostly built** | Prod plan noted a residual gap: some `/api/*` paths reachable on admin host before a `PLATFORM_ONLY_DEPLOYMENT` hardening — **TO CONFIRM** whether that patch shipped |
| Uploads in private per-env S3 buckets | **Built** | `devfathom-production-uploads-<account-id>`, TLS-only, versioned (per deploy docs) |
| Future: separate ECS service + DB per large tenant | **Decided direction** | `post-release-backlog.md`; Abbasi still on **shared** prod DB today |

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
| Only managers/owner approve marketing campaigns and close day/drawer | **Decided** | |
| Refunds: only manager/owner, with PIN (cashiers cannot start) | **Decided** (superseding earlier cashier-starts rule; confirm Saad wording) | Documentation Lead reported **no PIN refund code** on develop as of 2026-11-02 → treat as **not built** until rechecked |
| Narcotics / controlled flag → pharmacist review | **Decided** (product intent) | **Not built** as of Doc Lead 2026-11-02 check — **TO CONFIRM** |
| Margins visible to Owner, Admin, Finance; Manager own branch | **Decided** | |
| WhatsApp: promote pharmacy / non-drug only; no drug names in campaigns; server enforce | **Decided** | Partial code paths exist; full Ask Fathom OTC/drug-name guards are a PR series |
| Ask Fathom never uses Azure | **Decided** | Azure provider code may still exist; must stay disabled. **Saad ordered Azure removed from all code on 10 Nov 2026.** The removal is planned for the next Codex batch and tracked as Linear [DEV-755](https://linear.app/devfathom/issue/DEV-755/remove-azure-from-the-codebase-entirely) and GitHub [#1437](https://github.com/RealDevFathom/devfathom-commercial/issues/1437). |
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
| **Reset Saad SuperAdmin MFA after key exposure in screenshot** | **Open / pending confirmation** | Logged 2026-10-22 in `post-release-backlog.md`. **TO CONFIRM** whether production and staging were both rotated |
| PIN for till / approval flows | **Partially built** historically; refund-PIN policy **Decided**, build **TO CONFIRM** | |
| Rate limiting on login | **Built** (tests present) | |

**Handover action:** assume MFA material may have been exposed historically; **force re-enrol** for every SuperAdmin and verify recovery codes are only in the password manager.

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

- Secrets Manager JSON secrets under `devfathom/<env>/…` (auth secret, platform encryption key, camera credential key, DB URLs, bootstrap passwords).  
- Platform encryption key retained across stack delete (by design) so encrypted MFA/SSO/camera material remains recoverable only with that key.  
- **Never** store secret values in git, Linear, Slack, or these docs.

### 4.3 Develop EC2 gaps

| Issue | Status |
|---|---|
| Develop EC2 EBS root volume **not encrypted** | **Open finding** (verified) |
| Local `.env` / creds files on host | Must stay mode `600`; never copy into chat — **TO CONFIRM** inventory |
| SSH | Prefer SSM only; confirm no lingering open SSH | **TO CONFIRM** |

### 4.4 Backups beyond RDS

- S3 upload versioning (30-day noncurrent per deploy docs).  
- Nightly `pg_dump` to S3 for a future single-box layout is **planned**, not the current prod mechanism.  
- CloudTrail log bucket present in account (name removed from the repo copy) — whether a full org trail is enabled for all regions **TO CONFIRM**.

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
| OpenAI `store:false`; Bedrock EU profile for fallback | **Decided** |
| No Azure in Ask Fathom chain | **Decided**; prod AI disabled today |
| WhatsApp opt-in + frequency/quiet hours (22:00–09:00 PKT decided) | **Decided**; enforcement completeness **TO CONFIRM** |
| Per-org WABA tokens encrypted | **Decided**; global env token still the older mainline pattern — migration **TO CONFIRM** |

---

## 7. Security reviews done

| Practice | Status |
|---|---|
| Codex automated security reviews on pharmacy branches / PRs | **Ongoing** — many `secreview-*.md` artifacts under `/workspace/plan/` (Oct 2026 wave and later) |
| Claude second-opinion on PRs | **Process** (Saad rule) |
| CTO + Security approval before merge; Saad for production | **Process** |
| Launch blockers tracked (#518 Rx bypass, #355 recall reactivation, #631 rule-set confirm, #633 batch re-check, etc.) | Addressed or mitigated with SOPs for Abbasi-1 — residual risk depends on what reached production image `b4599a59…`; **TO CONFIRM** post-launch patch level |
| Formal external penetration test / SOC2 | **Not claimed** — **TO CONFIRM** if any third-party assessment exists |
| Dependency / container scanning in CI | Present in culture (QA machine “scans”); exact tools/pass rates **TO CONFIRM** |

---

## 8. Known open security issues (as of this writing)

1. **SuperAdmin MFA reset after screenshot exposure** — pending confirmation of completion on staging **and** production.  
2. **Develop EBS unencrypted.**  
3. **Refund PIN workflow** — decided, likely unbuilt (recheck develop).  
4. **Narcotic / controlled review flag** — decided, likely unbuilt.  
5. **Admin-host `/api/*` exposure gap** — may remain if `PLATFORM_ONLY_DEPLOYMENT` never shipped.  
6. **Shared prod DB for Abbasi + platform** — stronger isolation (dedicated DB/service) still backlog.  
7. **Production AI disabled** while staging has provider secret *names* — ensure keys never leak into client bundles; rotate if any were pasted into chat historically.  
8. **QA/agent EC2 fleets** in eu-north-1 with large instance types — attack surface and cost; ensure SSM/IAM scoped.  
9. **Day-close counted cash wiped on full remount** — QA filed **DEV-754** (Sev2); product bug, integrity of cash reconciliation.  
10. **Email still capture mode in production** — reduces email-based reset risk but also means operational mail paths differ from staging plans.
11. **No branch protection on `develop`: Saad's decision (10 Nov 2026), not an open gap.** On RealDevFathom/devfathom-commercial, `develop` shows `protected:false`, with no rulesets and no required checks (verified 2026-11-10 05:20 PKT), so anyone with write access can push or merge without review or CI. Saad confirmed on 2026-11-10 (05:51 PKT) that `develop` stays without branch protection, and merges are held until every gate passes on the final commit. `main` status TO CONFIRM.

---

## 9. Compliance position (Punjab / DRAP)

| Topic | Position |
|---|---|
| Geographic focus | **Punjab first** (explicit in Ask Fathom and HR plans) |
| Qualified Person / Cat A pharmacist presence | **Decided** product direction; regulatory gate helpers exist (`regulatory.ts`); full shift roster + Rx block = **Phase 2** |
| Punjab Drugs Rules 2007 references | Used in research/planning; software does not replace a licence |
| Campaign / WhatsApp drug advertising | **Decided:** no drug names in promos; Saad noted DRAP clearance for *not* requiring approval-number checks on that rule set — **keep legal memo TO CONFIRM** |
| CNS Act / narcotics register | Research noted; **not built** |
| Patient / prescription data | Treated as sensitive; RLS + scrubber intent; retention schedule **TO CONFIRM** |
| Formal DRAP software certification / NDMA / PECA registrations | **Not asserted here** — counsel **TO CONFIRM** |
| Data residency | Primary data in **Singapore** AWS today (not Pakistan). Latency ~70 ms class to PK per cost plan. Whether contracts promise PK residency: **TO CONFIRM** |

---

## 10. Investor / new-CTO diligence checklist

1. Rotate all Secrets Manager values and SuperAdmin MFA; prove login on `admin.devfathom.com` with new TOTP.  
2. Confirm Abbasi data restore: restore the manual pre-launch snapshot or latest automated snapshot into an isolated instance and compare row counts (**do not** overwrite prod).  
3. Re-read latest develop for refund PIN, narcotics flag, and Ask Fathom provider PRs.  
4. Commission an external pen-test focused on tenancy (cross-org IDOR), `/api` on admin host, and POS privilege escalation.  
5. Get written legal note on DRAP/Punjab advertising + cross-border hosting in Singapore.  
6. Encrypt or replace the develop EBS volume; ban secrets in plan files (some historical credential files exist on the ops machine — treat as sensitive and relocate to the password manager / Secrets Manager only).

---

## 11. TO CONFIRM (security)

1. MFA reset completion for Saad SuperAdmin (staging + production).  
2. Whether `PLATFORM_ONLY_DEPLOYMENT` (or equivalent) is live on production.  
3. Current develop code for refund PIN and narcotics review.  
4. Last successful RDS restore test date.  
5. CloudTrail / GuardDuty / Security Hub enablement.  
6. External pen-test or audit reports, if any.  
7. Legal memo on DRAP + data residency.  
8. Inventory of any secret that ever appeared in screenshots or chat, and proof of rotation.  
9. Status of DEV-754 fix on a fresh head.  
10. Meta WhatsApp production app review status and token storage model actually deployed.
