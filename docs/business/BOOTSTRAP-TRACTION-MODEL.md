# Bootstrap traction business model

**Internal - Confidential - Working model: 2026-07-12**  
**Status:** Proposed. All prices, conversion rates, costs, and forecasts are hypotheses until validated by signed customers and actual accounts.

## Executive decision

Bootstrap DevFathom Hub through a **service-led product path**, not an immediate self-serve SaaS launch.

The first commercial product is a paid operating outcome for 10-50 person software agencies and consultancies: a weekly, evidence-backed view of delivery risk, ownership gaps, deadlines, and cash actions. DevFathom operates the Hub internally to produce that outcome. External customers do not receive application access until the external-readiness gates in this document are satisfied.

This sequence turns the product's current strengths into learning and cash while respecting its verified boundary: the Hub is a single-company internal system with unresolved durability, migration, recovery, test, observability, and tenant-isolation work.

### Twelve-month bootstrap objective

| Outcome                             |                     Base-case target | Why it matters                                                         |
| ----------------------------------- | -----------------------------------: | ---------------------------------------------------------------------- |
| Paid delivery pilots                |                                    6 | Proves that the problem is worth money, not only interview interest    |
| Managed Control Desk clients        |                            6 maximum | Produces recurring cash while protecting founder delivery capacity     |
| External founding software partners | 4 maximum, only after readiness gate | Tests product pull without pretending to be a scaled SaaS business     |
| Month-12 recurring revenue          |                      `$10,500/month` | Six managed clients plus four gated software partners in the base case |
| Year-one cash revenue               |                            `$92,000` | Scenario, not forecast or promise                                      |
| Year-one operating surplus          | `$44,500` before founder pay and tax | Funds product hardening; excludes founder salary and personal runway   |
| Outside equity required             |                                 `$0` | The model is designed to fund learning from customer cash              |

## The model in one page

| Element                 | Bootstrap choice                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Beachhead customer      | Founder-led software agencies and consultancies with 10-50 staff, 3-15 concurrent client engagements, and visible delivery coordination pain           |
| Economic buyer          | Founder, managing director, COO, head of delivery, or operations lead                                                                                  |
| User                    | Delivery lead first; founder and project leads next; finance/people roles only when definitions are reliable                                           |
| Expensive problem       | Leaders learn about delivery, ownership, capacity, or cash issues late because truth is split across project tools, chat, sheets, meetings, and memory |
| Initial promise         | "Know what needs attention this week, why it matters, who owns it, and what to do next."                                                               |
| First paid product      | Six-week Delivery Control Pilot at `$3,000`, preceded by a `$750` paid diagnostic credited to the pilot                                                |
| Recurring offer         | Managed Control Desk at `$1,250/month`, three-month minimum, capped at six concurrent firms                                                            |
| Software offer          | Founding Partner at `$2,000` onboarding plus `$750/month` for up to 25 active users, only after readiness gates                                        |
| Acquisition             | Founder network, precise outbound, referrals, expert partners, and proof-led content; no paid ads in the first 90 days                                 |
| Differentiation         | A role-aware attention and action layer across delivery, clients, money, people, and operational evidence - not another generic task board             |
| Primary success measure | Customers repeatedly act on surfaced issues and renew because the operating rhythm saves time or prevents expensive surprises                          |
| Stop condition          | No three paid pilots after 30 qualified conversations, or no repeatable outcome after six pilots                                                       |

## Why service-led first

### Verified constraints

The current product is a coherent and broad internal modular monolith, but it is not ready for an external-customer promise. The diligence atlas identifies, among other items:

- no tenant boundary across the 60-model data schema;
- local runtime upload storage instead of durable private object storage;
- no checked-in Prisma migration history or demonstrated restore drill;
- no automated tests or CI workflow;
- insufficient health, error, metric, alert, and SLO coverage;
- open OAuth, webhook, direct-route account-status, audit-durability, and privileged-MFA controls;
- an external support, privacy, retention, DPA, billing, and offboarding program that does not yet exist.

### Commercial implication

The team should sell a result before selling a login. A service-led offer can use the Hub as DevFathom's internal operating instrument while customer inputs are transferred through explicitly agreed, low-risk methods. It validates the problem, vocabulary, cadence, willingness to pay, and repeatable signals without creating a false claim that the product is already a safe multi-tenant SaaS platform.

This is not intended to become an unbounded consultancy. Each engagement must turn repeated manual work into one of three assets:

1. a reusable diagnostic question;
2. a deterministic attention rule or workflow;
3. a product onboarding or integration requirement.

If work does not create one of these assets, it should be removed, separately priced, or declined.

## Beachhead market

### Ideal customer profile

The first segment should be narrow enough for one founder to recognize and reach directly.

| Attribute       | Required or preferred signal                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Firm type       | Software development agency, digital product studio, IT consultancy, or implementation partner                                 |
| Team size       | 10-50 staff; enough coordination pain, but a short buying path                                                                 |
| Delivery shape  | 3-15 concurrent client engagements with deadlines, dependencies, and shared specialists                                        |
| Existing stack  | A project tool plus chat plus spreadsheets or manual reports; data is fragmented but exportable                                |
| Trigger event   | Missed milestone, margin surprise, rapid hiring, a new delivery lead, client escalation, or tool consolidation review          |
| Buyer           | Founder/MD for 10-25 staff; COO/head of delivery for 25-50 staff                                                               |
| Budget signal   | Can authorize `$3,000` without procurement or a formal annual RFP                                                              |
| Behavior signal | Leadership already runs a weekly delivery or portfolio review                                                                  |
| Geography       | Start with the founder's highest-trust network and English-speaking remote firms; do not dilute effort into a global TAM story |

### Disqualifiers

- Solo consultants and teams below 8 people: coordination pain is usually too small.
- Firms looking only for a cheaper task board: mature alternatives already win this purchase.
- Enterprises with procurement, SSO, residency, or contractual SLA requirements: the control program is not ready.
- Highly regulated workloads in the first cohort: legal and security overhead will dominate learning.
- Buyers unwilling to share even aggregate operating data or attend a weekly review.
- Firms demanding custom development before paying for the standard pilot.

### Jobs to be done

1. Before the weekly leadership review, show which engagements need intervention and why.
2. Reduce status chasing across project leads without imposing another duplicate reporting ritual.
3. Make the next owner and action explicit when work is blocked or unowned.
4. Connect delivery changes to client commitments and cash consequences.
5. Preserve evidence for a decision so the same problem is not rediscovered in every meeting.

## Problem and positioning hypotheses

### Problem hypothesis

Small service firms do not primarily lack project-management features. They lack a trusted cross-project operating rhythm. Information exists, but decisions arrive late because it is spread across tools and interpreted differently by each lead.

### Positioning

**For founder-led software service firms that discover delivery problems too late, DevFathom is a delivery control system that turns fragmented operating data into a weekly, evidence-backed attention queue and named next actions. Unlike generic work-management tools, it is designed around client delivery, ownership, money, and operating decisions - not just task storage.**

### What not to say

- Do not call the current product "AI autonomous operations."
- Do not claim multi-tenant SaaS, enterprise readiness, compliance, guaranteed savings, or predictive accuracy.
- Do not pitch every existing module. Breadth supports the outcome; it is not the message.
- Do not lead with replacing ClickUp, Jira, Slack, or an accounting system. The initial wedge sits above the fragmented operating rhythm.
- Do not use employee productivity scoring or surveillance language.

## Offer ladder

### 1. Free Delivery Friction Triage

**Purpose:** qualify the pain, not provide free consulting.

- 20 minutes with the economic buyer.
- Five structured questions about late surprises, review cadence, ownership, data sources, and the cost of one recent failure.
- Output: fit/no-fit decision and one-page explanation of the paid diagnostic.
- No custom analysis, dashboard, integration, or written recommendation.

### 2. Paid Delivery Control Diagnostic

**Price hypothesis:** `$750`, paid upfront, credited if a pilot starts within 14 days.

**Scope:**

- one 75-minute operating interview;
- review of one portfolio report and up to three representative projects;
- a delivery-friction map;
- a baseline scorecard with 3-5 measurable risks;
- a 45-minute findings call;
- a fixed recommendation: pilot, fix process first, or no fit.

**Delivery ceiling:** 6 founder hours. If the median exceeds this after five diagnostics, narrow the input contract or raise the price.

### 3. Six-week Delivery Control Pilot

**Price hypothesis:** `$3,000` total, paid 60% at start and 40% at week three. The diagnostic credit applies to this amount.

**Included:**

- baseline and success criteria agreed with the buyer;
- one team and up to five active engagements;
- weekly attention brief covering delivery risk, ownership gaps, critical deadlines, and one optional cash signal;
- one 45-minute operating review each week;
- action log with owner and due date;
- week-six before/after review and recommendation;
- no application access in the service-led stage.

**Not included:** data migration, custom integrations, bespoke development, HR scoring, accounting reconciliation, autonomous consequential actions, 24/7 support, or a guaranteed business outcome.

### 4. Managed Control Desk

**Price hypothesis:** `$1,250/month`, three-month minimum, monthly in advance, capped at six concurrent clients.

**Included:**

- weekly attention brief;
- weekly 45-minute review;
- action and decision register;
- monthly operating trend summary;
- quarterly workflow reset;
- asynchronous clarification with a two-business-day response target.

**Capacity contract:** target 4 founder hours per customer per month after onboarding. At six clients, recurring delivery must remain at or below 24 hours/month. If it does not, stop selling and productize the repeated work.

### 5. Founding Software Partner

**Availability:** only after the external-readiness gate passes.

**Price hypothesis:** `$2,000` onboarding plus `$750/month`, up to 25 active users, six-month term, maximum five partners in the first cohort.

The price is intentionally not a cheap seat comparison. It includes controlled onboarding, weekly feedback, and direct influence on the initial product. Contract language must identify beta limitations, support hours, data responsibilities, and exit/export terms.

## Competitive frame and price logic

The crowded alternative set means DevFathom should not attempt to win on feature count or the lowest price per user.

| Alternative    | Current public reference                                                          | What it validates                                                                                | Implication for DevFathom                                         |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Teamwork.com   | Basics `$9.99/user/month`; Accelerate `$24.99/user/month`, billed yearly          | Agencies already pay for time, capacity, invoicing, and client delivery workflows                | A basic task-and-time pitch will be ignored                       |
| Productive     | Essential `$10`, Professional `$25`, Ultimate `$33` per user/month, billed yearly | Integrated budgeting, resourcing, time, expenses, reporting, and AI are established expectations | DevFathom must lead with a sharper operating outcome              |
| Scoro          | Core `$19.90`, Growth `$32.90` per user/month, billed yearly                      | Buyers recognize unified professional-services operations as a category                          | High-touch implementation can justify a premium during discovery  |
| Existing stack | Project tool + chat + sheets + meetings + manager memory                          | The default competitor is no change, not another vendor                                          | Every sale needs a quantified recent failure and a low-risk start |

At 25 users, public annual-billing references span roughly `$250-$822.50/month` before onboarding or services. The proposed `$750/month` Founding Partner offer sits inside that broad spend range but includes a high-touch discovery relationship. This is a pricing hypothesis, not proof of willingness to pay.

The Stripe Atlas pricing guide advises targeted positioning and pricing somewhat ahead of current maturity rather than repeatedly repricing early customers. That supports a paid, bounded founding offer rather than a free beta with undefined obligations.

## Go-to-market system

### Channel priority

|             Priority | Channel                                                | Weekly action                                                                                          | Cost rule                                                          |
| -------------------: | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
|                    1 | Founder and DevFathom network                          | 10 direct introductions or reactivation messages                                                       | Start here; trust compresses the sales cycle                       |
|                    2 | Precise outbound                                       | 20 researched accounts, each tied to one visible trigger or operating hypothesis                       | No bulk automation until message-to-meeting fit exists             |
|                    3 | Referral partners                                      | 2 conversations with agency coaches, fractional COOs/CFOs, accountants, and implementation consultants | Pay referral fees only from collected revenue                      |
|                    4 | Proof-led content                                      | 1 delivery-control teardown, checklist, or anonymized lesson                                           | Content supports sales; it is not a vanity publishing program      |
|                    5 | Communities and events                                 | 1 useful contribution or small roundtable                                                              | No unsolicited promotion; lead with the operating problem          |
| Excluded for 90 days | Paid search/social, broad sponsorships, affiliates, PR | 0                                                                                                      | Too early to buy traffic before conversion and retention are known |

### Founder outreach message

> We help 10-50 person software agencies spot delivery and ownership risks before the weekly review becomes an escalation meeting. I am interviewing a small group of agency leaders about how they currently surface cross-project risk. If late surprises or status chasing are still expensive, I can show you the six-week control pilot. This is not a generic task-tool demo.

Personalize the first sentence with a credible trigger. Do not manufacture familiarity or promise an outcome before diagnosis.

### Discovery questions

1. Tell me about the last delivery surprise leadership learned too late.
2. What did it cost in time, margin, client trust, or rescheduling?
3. Where did the warning signs exist before the problem became visible?
4. How is the weekly portfolio review assembled today, and by whom?
5. Which report or tool does leadership distrust, and why?
6. When ownership is unclear, how long does it take to resolve?
7. What have you already tried? Why did it fail to become a habit?
8. Who owns this problem and can authorize a `$3,000` pilot?
9. What measurable change in six weeks would justify continuing?
10. What data cannot leave your current systems?

The founder should talk less than the buyer. Record exact problem language, buying trigger, present workaround, consequence, decision path, and disqualifier. Do not count feature requests as demand.

## Ninety-day traction plan

### Funnel target

| Stage                            | 90-day target |      Working conversion | Evidence required                                   |
| -------------------------------- | ------------: | ----------------------: | --------------------------------------------------- |
| Qualified accounts researched    |           240 |                       - | Firm, buyer, trigger, stack, and why-now recorded   |
| Positive replies/referrals       |            36 |         15% of accounts | Buyer agrees the problem is relevant                |
| Completed discovery calls        |            24 | 67% of positive replies | Problem, consequence, owner, and next step captured |
| Paid diagnostics                 |             6 |        25% of discovery | Payment collected; not a verbal yes                 |
| Pilot proposals                  |             5 |      83% of diagnostics | Signed scope, baseline, and buyer                   |
| Paid pilots                      |             3 |        60% of proposals | Contract plus first payment                         |
| Managed Control Desk conversions |             2 |           67% of pilots | Three-month recurring agreement                     |

**Day-90 traction target:** three paid pilots representing `$9,000` of contracted pilot value and two Control Desk conversions representing `$2,500` exit monthly recurring revenue. Diagnostic credits mean audit cash is not added twice.

### Weeks 1-2: prepare and listen

- Select one ICP and one buyer title.
- Create a one-page offer, diagnostic worksheet, proposal, data-handling note, and simple CRM pipeline.
- Build the first 60-account list, starting with warm paths.
- Run 8-10 problem interviews before changing product scope.
- Establish a baseline from DevFathom's own internal pilot so the founder can show the operating method honestly.

### Weeks 3-4: sell the diagnostic

- Run at least six qualified conversations.
- Ask for payment when the problem, consequence, owner, and urgency are present.
- Deliver the first two diagnostics personally.
- Track every hour and every input requested.
- Refine one standard scorecard; do not build custom dashboards.

### Weeks 5-8: deliver the first pilots

- Start one or two pilots, never more than founder capacity allows.
- Use deterministic rules and clearly cited evidence.
- Record every surfaced item as acted, acknowledged, dismissed, false positive, or expired.
- Review customer language weekly and update the offer before updating the product.
- Request a referral only after a concrete useful moment.

### Weeks 9-12: prove repeatability

- Close the third pilot.
- Convert at least two pilots to the Managed Control Desk.
- Publish one anonymized case narrative with buyer approval.
- Decide whether the same five signal families, inputs, and review ritual repeat.
- Allocate collected cash to the external-readiness backlog, not acquisition scale.

## Customer delivery blueprint

### Required inputs

Keep the first service contract intentionally small:

- portfolio list with owner, client, status, and target date;
- milestone or commitment list;
- blockers and high-priority work;
- last meaningful activity or update date;
- optional invoice status and due date, with currency preserved;
- planned leave or capacity constraint only when policy permits.

Use customer-approved exports or structured summaries. Do not ingest raw chat, personnel review content, credentials, or unrestricted production data for convenience.

### Weekly output

Each attention item must include:

1. **signal:** what changed or crossed a rule;
2. **evidence:** source, date, and relevant values;
3. **impact:** why it may affect delivery, ownership, client trust, or cash;
4. **owner:** one named role/person responsible for resolution;
5. **next action:** a concrete decision or follow-up;
6. **state:** open, acknowledged, acted, dismissed, or expired;
7. **learning:** whether the rule was useful or a false positive.

### Initial deterministic rules

- milestone due within 14 days with an open blocker;
- high-priority work with no active owner;
- client commitment changed without an updated project date;
- project has no meaningful update for an agreed number of days;
- invoice due soon or overdue without a recorded next action;
- key owner is unavailable during a critical delivery window;
- decision request has exceeded the agreed response time.

AI may summarize evidence and draft communications. It must not invent risk facts, score employees, silently assign owners, or execute consequential actions without authorization.

## Economics and cash discipline

### Offer-level unit economics

Founder time is priced internally at `$50/hour` to prevent "free" founder labor from hiding an unsustainable service model.

| Offer                                |  Revenue | Delivery assumption |             Direct cost assumption | Contribution | Contribution margin |
| ------------------------------------ | -------: | ------------------: | ---------------------------------: | -----------: | ------------------: |
| Diagnostic                           |   `$750` |     6 founder hours |         `$300` labor + `$25` tools |       `$425` |                 57% |
| Six-week pilot                       | `$3,000` |    18 founder hours |        `$900` labor + `$150` tools |     `$1,950` |                 65% |
| Control Desk, monthly                | `$1,250` |     4 founder hours |   `$200` labor + `$75` tools/infra |       `$975` |                 78% |
| Founding software partner, recurring |   `$750` |     2 support hours | `$100` labor + `$75` infra/vendors |       `$575` |                 77% |
| Founding partner onboarding          | `$2,000` |    12 founder hours |      `$600` labor + `$100` tooling |     `$1,300` |                 65% |

These are planning assumptions. Replace them with time logs, vendor invoices, support time, AI usage, and hosting cost for each customer.

### Acquisition economics

Target a cash CAC below `$250` during founder-led selling. Count founder sales time separately:

- 8 founder hours from research through close at `$50/hour`: `$400`;
- cash tools, travel, or referral cost: maximum `$250`;
- fully loaded acquisition cost target: no more than `$650`;
- Control Desk contribution: about `$975/month` under the assumptions above;
- target payback: less than one month on recurring contribution, or less than two months if conversion and onboarding labor are included.

Do not use a lifetime-value ratio until real retention exists. A made-up churn rate makes an LTV:CAC chart look precise while proving nothing.

### Launch budget

| Item                                         | One-time cap | Monthly cap before recurring revenue |
| -------------------------------------------- | -----------: | -----------------------------------: |
| Contract/privacy/accounting review           |     `$1,500` |                       `$150` reserve |
| Security, monitoring, and backup foundations |     `$2,000` |                               `$300` |
| CRM, scheduling, email, and prospecting      |       `$250` |                               `$150` |
| Offer page and sales collateral              |       `$500` |                                `$50` |
| Customer research and contingencies          |       `$750` |                               `$150` |
| **Total**                                    | **`$5,000`** |                     **`$800/month`** |

Maintain at least `$7,500` of business cash before launch: the `$5,000` setup cap plus roughly three months of pre-revenue operating expense. This excludes the founder's personal living runway, taxes, and any existing company payroll.

### Hiring and spend gates

- No paid acquisition until at least 3 of 6 pilots convert or renew and one channel converts predictably.
- No full-time sales hire before the founder closes 10 customers using a documented process.
- No full-time customer-success hire before recurring delivery exceeds 30 founder hours/month and gross contribution supports the role.
- No major product expansion until six pilots repeat the same signal and workflow needs.
- No owner distribution from setup cash until tax, refund, and three-month operating reserves are funded.
- Add a contractor only from collected revenue, with a defined deliverable and stop date.

## Twelve-month cash model

The base case assumes a six-client cap on the service-heavy Control Desk and delays external software customers until month 9. "Operating cost" includes modeled founder delivery labor at `$50/hour`, tools, infrastructure, modest contractor help, and the launch program. It excludes founder salary, income tax, sales tax/VAT, financing costs, and existing DevFathom overhead.

|      Month | Commercial activity                                          |       Revenue | Operating cost | Operating surplus |
| ---------: | ------------------------------------------------------------ | ------------: | -------------: | ----------------: |
|          1 | 2 diagnostics; foundation work                               |      `$1,500` |       `$1,200` |            `$300` |
|          2 | 1 diagnostic; 2 pilots                                       |      `$6,750` |       `$2,200` |          `$4,550` |
|          3 | 1 pilot; 1 Control Desk                                      |      `$4,250` |       `$2,200` |          `$2,050` |
|          4 | 1 pilot; 2 Control Desks                                     |      `$5,500` |       `$2,600` |          `$2,900` |
|          5 | 1 pilot; 3 Control Desks                                     |      `$6,750` |       `$3,000` |          `$3,750` |
|          6 | 1 pilot; 4 Control Desks                                     |      `$8,000` |       `$3,500` |          `$4,500` |
|          7 | 5 Control Desks; productization                              |      `$6,250` |       `$3,800` |          `$2,450` |
|          8 | 6 Control Desks; readiness verification                      |      `$7,500` |       `$4,200` |          `$3,300` |
|          9 | 6 Control Desks; first software onboarding + subscription    |     `$10,250` |       `$5,200` |          `$5,050` |
|         10 | 6 Control Desks; second software onboarding; 2 subscriptions |     `$11,000` |       `$5,900` |          `$5,100` |
|         11 | 6 Control Desks; third onboarding; 3 subscriptions           |     `$11,750` |       `$6,500` |          `$5,250` |
|         12 | 6 Control Desks; fourth onboarding; 4 subscriptions          |     `$12,500` |       `$7,200` |          `$5,300` |
| **Year 1** | Base-case scenario                                           | **`$92,000`** |  **`$47,500`** |     **`$44,500`** |

### Scenario boundaries

| Scenario | Year-one cash revenue | Month-12 recurring revenue | Interpretation                                                                                    |
| -------- | --------------------: | -------------------------: | ------------------------------------------------------------------------------------------------- |
| Floor    |             `$30,000` |             `$2,500/month` | Two Control Desk clients; no external software launch; preserve cash and revisit segment          |
| Base     |             `$92,000` |            `$10,500/month` | Six managed clients plus four gated software partners                                             |
| Stretch  |            `$140,000` |            `$15,000/month` | Faster pilot conversion and eight software partners; requires delivery help and verified capacity |

The floor is a survival signal, not success. The stretch case must not be pursued by bypassing readiness or exceeding service capacity.

## Readiness gate for external software access

No customer receives a login until all mandatory conditions have an owner and evidence.

| Gate                      | Minimum evidence                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Commercial boundary       | Leadership has approved the internal-first-to-commercial transition and customer cohort limit                                           |
| Tenant/isolation strategy | Tenant-scoped schema and authorization or a deliberately isolated deployment model, reviewed and tested                                 |
| Durable data and files    | Private durable object storage, migration baseline, backup ownership, and a completed restore drill                                     |
| Security blockers         | OAuth state/token validation, webhook SSRF protection, active-user enforcement on direct routes, privileged MFA decision, durable audit |
| Quality                   | Automated critical-path tests, CI gate, green typecheck/lint/build/audit policy, and release evidence                                   |
| Operations                | Health/readiness, error tracking, metrics, alerts, incident owner, support window, and rollback procedure                               |
| Privacy/legal             | Terms, privacy notice, DPA/subprocessor register, retention/deletion/export process, breach workflow, and data classification           |
| Customer lifecycle        | Onboarding, billing, support, access review, offboarding, and export runbooks                                                           |
| Product proof             | At least six paid pilots with a repeated problem, repeated signals, and buyer-confirmed outcome                                         |

If leadership chooses isolated single-customer deployments as a temporary bridge, price the operational overhead explicitly and document upgrade, migration, and shutdown obligations. Do not confuse deployment isolation with a complete commercial control program.

## Metrics and weekly operating cadence

### One source-of-truth scorecard

| Category  | Metric                                                |                   Week-12 target | Warning signal                                      |
| --------- | ----------------------------------------------------- | -------------------------------: | --------------------------------------------------- |
| Market    | Qualified discovery calls                             |                               24 | Fewer than 12 means the channel or ICP is too weak  |
| Demand    | Paid diagnostics                                      |                                6 | Buyers accept interviews but not payment            |
| Sales     | Paid pilots                                           |                                3 | Proposals stall without a quantified recent failure |
| Revenue   | Contracted pilot value                                |                         `$9,000` | Discounts or custom scope are doing the selling     |
| Recurring | Control Desk conversions                              |                                2 | Pilot produces interest but no ongoing habit        |
| Value     | Attention items acted/acknowledged                    |                    More than 60% | Most signals are ignored or dismissed               |
| Outcome   | Status-chasing time                                   |     25% lower for the pilot lead | New reporting creates more work                     |
| Delivery  | Control Desk founder time                             | At or below 4 hours/client/month | Service cannot become a software-shaped business    |
| Trust     | Severity-1 incidents or unresolved privacy complaints |                                0 | Stop expansion immediately                          |
| Learning  | Repeated signal families across pilots                |       At least 3 shared families | Every customer needs a different product            |

### Weekly founder meeting - 45 minutes

1. **Cash:** collected, overdue, committed, runway, tax/refund reserve.
2. **Pipeline:** movement by stage, not total lead count.
3. **Customer value:** acted items, ignored items, false positives, outcome evidence.
4. **Capacity:** delivery hours, support burden, work to standardize or remove.
5. **Product learning:** repeated signal, input, workflow, or integration.
6. **Risk:** data, security, contract, or customer-trust issue.
7. **One decision:** continue, change, or stop one hypothesis.

## Experiment backlog

| ID   | Hypothesis                                                              | Test                                              | Pass condition                                            | Timebox             |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | ------------------- |
| E-01 | Delivery leaders will pay for diagnosis before software                 | Offer the `$750` diagnostic after qualified calls | 6 payments from 24 calls                                  | 6 weeks             |
| E-02 | The weekly attention brief is more valuable than another dashboard      | Deliver brief first; no login                     | More than 60% of items acted/acknowledged                 | 3 pilots            |
| E-03 | Delivery risk + ownership is a sharper wedge than all-in-one operations | Run two message variants                          | Wedge message produces at least 1.5x qualified reply rate | 80 accounts/variant |
| E-04 | `$3,000` is an acceptable pilot price                                   | Quote without automatic discount                  | 3 of 5 proposals close                                    | 90 days             |
| E-05 | The outcome repeats across firms                                        | Compare signals and inputs                        | At least 3 common signal families in 5 of 6 pilots        | 6 pilots            |
| E-06 | Managed service can be product-shaped                                   | Time every task                                   | At or below 4 hours/client/month by month two             | 3 clients           |
| E-07 | Buyers will renew for an operating habit                                | Offer three-month Control Desk                    | 2 of first 3 pilots convert                               | 4 months            |
| E-08 | Founding price is credible                                              | Offer `$2,000 + $750/month` after readiness       | 3 of 5 qualified design partners sign                     | Post-gate           |

## Stop, narrow, and scale rules

### Stop or redesign

- Fewer than 3 paid pilots after 30 qualified discovery conversations.
- Fewer than 2 of the first 6 pilots produce buyer-confirmed value.
- Most surfaced items are ignored, cannot be evidenced, or recreate status-reporting labor.
- A serious privacy, security, or data-loss incident remains unresolved.
- Customers buy custom consulting rather than the standard operating outcome.

### Narrow

- One subsegment converts at least twice the rate of the rest.
- Only one buyer title owns budget and renewal.
- One signal family consistently drives action while the rest are noise.
- A specific source-system combination makes onboarding repeatable.

### Scale carefully

Scale one channel or cohort only when:

1. six pilots have been completed;
2. at least 50% convert or renew;
3. the standard offer produces positive contribution including founder time;
4. delivery remains within capacity;
5. the external-readiness gate is complete for any software access;
6. one case study demonstrates a measurable, buyer-approved outcome;
7. the last 90 days contain no unresolved severity-1 trust incident.

## Governance and ownership

| Decision                     | Accountable owner                   | Approval required before        |
| ---------------------------- | ----------------------------------- | ------------------------------- |
| Segment and offer            | Founder/Product                     | First outbound campaign         |
| Customer data contract       | Privacy/Security + Founder          | First diagnostic data transfer  |
| Pilot scope and claims       | Founder + Delivery                  | First proposal                  |
| Finance and tax treatment    | Finance/accounting adviser          | First invoice                   |
| External software readiness  | Engineering + Security + Leadership | First customer login            |
| Pricing change               | Founder                             | Quoting a new cohort            |
| Hiring or paid acquisition   | Founder/Finance                     | Committing recurring spend      |
| Employee analytics guardrail | People/Privacy/Leadership           | Any people-related pilot signal |

## Immediate 10-day action list

1. Leadership accepts or amends this model and keeps external software access gated.
2. Select the single beachhead: 10-50 person software agencies/consultancies.
3. Name one founder seller and protect 10 hours/week for 12 weeks.
4. Write the one-page diagnostic and six-week pilot scope from this document.
5. Obtain local legal/accounting review for contracting, invoicing, tax, privacy, and customer data handling.
6. Create a 60-account list with 20 warm or referral paths.
7. Run the first 8 interviews without showing a feature tour.
8. Ask qualified buyers to pay `$750`; do not substitute enthusiasm for demand.
9. Run DevFathom's internal attention-queue pilot in parallel and document one honest before/after story.
10. Review evidence on day 10 and change only the ICP, message, price, or input contract - not all four at once.

## Source notes

External references were checked on 2026-07-12. Public pricing changes; re-check before customer-facing use.

1. [Teamwork.com pricing](https://www.teamwork.com/pricing/) - public plan and annual-billing price references.
2. [Productive pricing](https://productive.io/pricing/) - public plan, feature, and annual-billing price references.
3. [Scoro pricing](https://www.scoro.com/pricing/) - public professional-services plan references.
4. [Stripe Atlas: Pricing low-touch SaaS](https://stripe.com/guides/atlas/saas-pricing) - targeted positioning and early pricing guidance.
5. [DevFathom product strategy](../product/PRODUCT-STRATEGY.md) - internal-first wedge, pilot, and commercial gates.
6. [Project status](../executive/PROJECT-STATUS.md) - verified current readiness and release blockers.
7. [Technical due diligence](../executive/TECHNICAL-DUE-DILIGENCE.md) - evidence behind the service-led sequencing decision.
8. [Risk register](../executive/RISK-REGISTER.md) - control risks that gate external access.

## Decision record

| Field                    | Value                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Recommended model        | Service-led traction, then gated founding software partners                                                        |
| Current status           | Proposed                                                                                                           |
| Decision owner           | Leadership/Founder - TBD                                                                                           |
| Review date              | 30 days after first paid diagnostic                                                                                |
| Replace assumptions with | Signed contracts, collected cash, time logs, vendor invoices, conversion, retention, and customer outcome evidence |
| Non-negotiable           | No external customer login before the readiness gate passes                                                        |
