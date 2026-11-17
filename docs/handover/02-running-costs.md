# DevFathom — Running costs

> **Repo copy, checked 10 Nov 2026 (PKT).** This file was scanned for secrets, account IDs, IP addresses and login details before committing. After the CTO's review (10 Nov 2026), server names and internal file paths were also removed. Otherwise the content is unchanged from the CTO's draft, including every **TO CONFIRM** item.

**Audience:** investors and a new CTO.  
**Written:** 2026-11-10 (Asia/Karachi).  
**Money source of truth for AWS:** Cost Explorer `UnblendedCost`, excluding Credit/Refund/Tax/Upfront/Support record types, queried read-only on 2026-11-10.  
**Rule:** if a number was not measured, it is marked **ESTIMATE** or **TO CONFIRM**.

---

## Plain-language summary

In **October 2026**, AWS usage across the whole account was about **USD 143**. Credits covered that month almost exactly (**net ≈ USD 0** after credits — credit **balance remaining and expiry are TO CONFIRM**).

Only part of that bill is the **customer product** (Singapore production + staging). A large share is **engineering/QA machines** and a **separate product** (plansmithy) that share the same AWS account. Treat those separately when you model unit economics.

On top of AWS, Saad set **monthly AI provider budgets** (caps, not invoices): Claude **USD 190**, OpenAI **USD 190**, Bedrock **USD 300**, shared across all pharmacies. WhatsApp default allowance is **5,000 messages per pharmacy per month** (SuperAdmin-set). Actual Anthropic/OpenAI/Meta invoices for October–November were **not pulled in this pass → TO CONFIRM**.

---

## 1. Verified AWS spend

### 1.1 Whole-account monthly totals (usage only)

| Period | Usage (USD) | Notes |
|---|---:|---|
| 2026-08 | ≈ 1.8 | Pre-product; tiny |
| 2026-09 | ≈ 20.9 | Mostly early RDS / VPC |
| 2026-10 | **143.05** | Abbasi launch month (prod from ~22–23 Oct); credits −143.05 → net ≈ 0 |
| 2026-11-01 → 2026-11-10 | **≈ 474** (MTD, estimated by CE) | Dominated by **eu-north-1 / us-east-2 QA–agent Spot**, not by Abbasi |

### 1.2 October 2026 by region (usage)

| Region | USD | What it mostly is |
|---:|---:|---|
| `ap-southeast-1` | **44.52** | **DevFathom product** (prod + staging ALB/RDS/ECS/Secrets/VPC/CodeBuild) |
| `us-east-1` | 41.22 | Develop pharmacy EC2 **plus** plansmithy RDS **plus** other EC2 — **mixed** |
| `eu-north-1` | 31.39 | Agent/QA compute (not customer traffic) |
| `us-east-2` | 21.94 | Agent/QA Spot |
| `ap-east-1` | 3.39 | A small VPN instance — ownership **TO CONFIRM** |
| global | 0.50 | Route 53 etc. |

### 1.3 October 2026 — product region detail (`ap-southeast-1`)

| Service | USD |
|---|---:|
| RDS | 14.52 |
| Elastic Load Balancing | 12.21 |
| VPC (incl. public IPv4 charges) | 7.26 |
| ECS (Fargate) | 5.81 |
| Secrets Manager | 2.99 |
| CodeBuild | 1.58 |
| ECR | 0.15 |
| **Region total** | **44.52** |

**Interpretation:** production only existed for ~the last third of October, and staging was already running. A **full calendar month** of the current prod+staging dual-stack is higher than USD 44.

### 1.4 November 2026 (1–10) — product vs noise

| Region | USD MTD | Comment |
|---|---:|---|
| `ap-southeast-1` | **35.38** | Product path — implies roughly **~USD 100–110 / month** if this pace continues (**ESTIMATE**: 35.38 × 30/9 ≈ 118; treat as **~USD 100–120** pending a quiet full month) |
| `us-east-1` | 18.75 | Develop EC2 + plansmithy RDS + misc (mixed) |
| `eu-north-1` | **282.62** | QA/agent — **exclude from product COGS** |
| `us-east-2` | **134.16** | QA/agent Spot storage/other — **exclude from product COGS** |
| `ap-east-1` | 2.47 | Unrelated nano |

### 1.5 Develop pharmacy server — run-rate **ESTIMATE**

Verified resources: `t4g.medium` On-Demand in `us-east-1`, 50 GB gp3, 1 Elastic IP.

| Line | ESTIMATE USD / month | Basis |
|---|---:|---|
| `t4g.medium` compute | ~24–26 | Public list-price recollection for us-east-1; **TO CONFIRM** in Pricing Calculator |
| Elastic IP attached | ~3.65 | USD 0.005/hour |
| 50 GB gp3 | ~4 | ~USD 0.08/GB-month list recollection; **TO CONFIRM** |
| **Subtotal develop box** | **~32–35** | Always-on assumption |

This box is for **engineering/demos**, not Abbasi production traffic.

### 1.6 Earlier internal plan numbers (for context, not CE)

The internal min-cost plan (2026-10-31) estimated DevFathom Singapore serving Abbasi at roughly **USD 45–50/month run-rate** mid-build, with a full dual ALB+RDS month closer to **~USD 100**, and proposed a future single-EC2 architecture around **~USD 20–25**. Those were planning estimates; prefer §1.1–1.4 for diligence.

Production SuperAdmin Option A plan estimated **~USD 62–68/month** for a dedicated prod stack alone — consistent with “two stacks cost more than one.”

---

## 2. Non-AWS product costs

| Cost | Status | Amount |
|---|---|---|
| Anthropic Claude API | **Budget cap** decided 2026-11-01 | **USD 190 / month** across all pharmacies (warn 80%, stop 100%). Actual invoice **TO CONFIRM** |
| OpenAI API | **Budget cap** | **USD 190 / month** shared. Actual **TO CONFIRM** |
| Amazon Bedrock | **Budget cap** | **USD 300 / month** shared. Actual **TO CONFIRM** (also appears inside AWS bill when used) |
| WhatsApp / Meta messaging | **Policy** default 5,000 msgs / pharmacy / month | Meta conversation pricing **TO CONFIRM** (varies by category: utility vs marketing) |
| Cloudflare | DNS for `devfathom.com` | Free tier assumed; paid add-ons **TO CONFIRM** |
| GitHub | Private org | Plan/seat cost **TO CONFIRM** |
| Linear | Issue tracker | Plan cost **TO CONFIRM** |
| Email (Resend/Brevo/SES) | Prod still `capture` | Near USD 0 until live send; SES sandbox |
| Codex / ChatGPT Pro / Claude seats | Builder tooling | Billed to Saad's seats — **not** customer COGS; amount **TO CONFIRM** |
| Azure | Forbidden for Ask Fathom / new work | Should be **USD 0** going forward. Azure code removal tracked in DEV-755 / #1437 |

---

## 3. Per-pharmacy cost model (**ESTIMATE**, labelled)

Assumptions (explicit):

1. One live pharmacy (Abbasi) on the **shared** production stack today.  
2. Production + staging Singapore stacks stay always-on as today.  
3. Develop EC2 stays always-on for engineering.  
4. QA/agent Spot fleets are **excluded** from pharmacy COGS.  
5. plansmithy costs are **excluded**.  
6. Ask Fathom and WhatsApp usage are **add-ons**.

### 3.1 Shared platform AWS (not per pharmacy)

| Bucket | Monthly ESTIMATE | Notes |
|---|---:|---|
| Singapore prod + staging (ALB, RDS×2, ECS×2, IPv4, Secrets, …) | **~100–120** | From Nov MTD pace §1.4; refine after one quiet full month |
| Develop EC2 | **~32–35** | §1.5 |
| **Platform subtotal** | **~130–155** | Before AI/WhatsApp |

With **one** pharmacy, almost all of that lands on Abbasi. With **N** pharmacies on a shared stack, divide the Singapore line by N for a rough average — acknowledging staging/develop stay relatively fixed.

### 3.2 Ask Fathom model fees per pharmacy (**ESTIMATE** from Ask Fathom plan)

From the Ask Fathom plan (model-fee only, not measured in production):

| Usage profile | Turns / month | ESTIMATE USD |
|---|---:|---:|
| Light (≈5/day) | 150 | ~3 |
| Typical (≈20/day) | 600 | ~8 |
| Heavy (≈50/day) | 1,500 | ~26 |

Suggested default per-org cap in the plan: **~USD 15 / month** (product decision; SuperAdmin credits override). Global provider budgets still apply as hard ceilings.

### 3.3 WhatsApp per pharmacy

- Default allowance: **5,000 messages / month** (decided).  
- **USD cost: TO CONFIRM** from Meta pricing × actual template mix (utility refill vs marketing).  
- Campaigns must not promote drugs (server-side rule decided); that also caps marketing-template exposure.

### 3.4 Example all-in for one typical pharmacy (**ESTIMATE**)

| Component | USD / month |
|---|---:|
| Share of Singapore platform if alone | ~100–120 |
| Ask Fathom “typical” | ~8 |
| WhatsApp | **TO CONFIRM** |
| **Illustrative total** | **~110–130 + WhatsApp** until more tenants share the stack |

This is **not** a pricing recommendation; it is a cost floor for diligence.

---

## 4. Cost hygiene actions (no changes made in this pass)

1. Tag or separate accounts for **product** vs **QA/agent** vs **plansmithy** so CE is readable.  
2. Stop or schedule QA Spot fleets when idle (Nov MTD shows why).  
3. Confirm AWS credit expiry so net-zero months are not mistaken for zero burn.  
4. Turn on AWS Budgets for: `ap-southeast-1` product, Bedrock, and account-wide anomaly detection.  
5. Decide keep-or-retire develop `t4g.medium` vs future min-cost single-box plan (internal min-cost plan) — Saad decision still open in that plan.

---

## 5. TO CONFIRM (costs)

1. AWS credit balance and expiry date.  
2. Full November invoice once the month closes (strip QA regions).  
3. Anthropic, OpenAI, Meta actual invoices / card statements.  
4. Cloudflare / GitHub / Linear subscription amounts.  
5. Exact us-east-1 split: develop EC2 vs plansmithy RDS dollars.  
6. Whether staging can scale to DesiredCount 0 + stop RDS when idle.  
7. Meta WhatsApp price per conversation category for Pakistan.  
8. Builder-tool seat costs if investors ask for “total cash burn,” separate from COGS.
