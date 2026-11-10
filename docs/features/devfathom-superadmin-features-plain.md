# DevFathom admin console (SuperAdmin): every feature, in plain words

Last updated 10 November 2026 (PKT). This covers the current development version of DevFathom (develop, as of 7 November 2026, code version `1906b530`). The previous edition covered 1 November. DevFathom serves four kinds of business: **agencies** (studios and firms), **restaurants**, **pharmacies** and **hotels**. All four are run from one DevFathom admin console.

**What the labels mean**
- **Available now**: built and in the current development version. **This doesn't mean testing has finished.**
- **New**: added since the 1 November edition.
- **Built, waiting to be merged**: built and waiting for review (an open pull request).
- **Planned, not built yet**: agreed, but not built yet.

**Please note:** the DevFathom admin console hasn't been tested by our QA team yet, and no one has yet checked that one business can never see another business's data. Our examples use businesses in Lahore and across Punjab.

**What's new since 1 November:** AI settings and AI spending in the console, and new pharmacies are now set up so the owner can report side effects from the first day.

---

## 1. The DevFathom admin console (DevFathom staff only, for every kind of business)

**Staff sign-in with a phone code (Available now).** DevFathom's own staff sign in to a separate admin website, not the one customers use. After the password, they type a six-digit code from an authenticator app on their phone, or one of their backup codes. After too many wrong tries the system makes them wait. *Example:* Ayesha from our operations team signs in at the start of her shift in Johar Town, enters the code from her phone, and lands on the control room. If she loses her phone, a SuperAdmin resets her phone code and the reset is recorded.

**Staff roles (Available now).** Every DevFathom staff member has one of six roles. A *SuperAdmin* can do everything. *Operations* sets up and runs customer accounts. *Sales* manages leads and deals. *Finance* manages contracts, invoices and payments. *Support* can look at accounts and open a support session. An *Auditor* can read everything, including the audit history, but change nothing. Each person sees only the pages their role allows. The last SuperAdmin can never be switched off by mistake. *Example:* our new support hire in Faisalabad gets the Support role, so she can look up a Gulberg restaurant's account and help them, but she can't change their plan or bill.

**Creating a customer's account (Available now).** Operations picks the kind of business, then enters its name, web address, time zone, currency and plan. DevFathom builds the account with the right features, ready-made staff roles and departments for that kind of business, and the first administrator login. *Example:* a new pharmacy chain in Multan signs up. We choose "Pharmacy", the Professional plan and Asia/Karachi time, and the owner gets a login with Owner, Pharmacist, Cashier and other roles already in place.

**Account stages and the go-live checklist (Available now).** Every account moves through stages: prospect, onboarding, active, grace period, suspended, terminated and deleted. An account can't go live until four things are true: it has a plan, at least one feature is switched on, it has an administrator, and its website is ready. The console shows each missing item with a link to fix it. Pharmacies and hotels have extra checks of their own. We can also suspend and resume an account, export all its data, or delete it for good. *Example:* a Lahore hotel's account is stuck in onboarding. The checklist shows "no administrator yet", so we add the general manager and the account goes live.

**Self-sign-up requests (Available now).** Businesses can ask for an account from the website, and our staff approve or turn down each request.

**Brand, web address and email (Available now).** We set each customer's logo and colours, connect their own web address (for example `orders.yourcafe.pk`, with a check that it's set up correctly and a retry if not), and set the name and address their system emails come from.

**Company sign-in (SSO) and automatic staff lists (SCIM) (Available now).** Large customers can let staff sign in with their company login, using Google Workspace, Microsoft or another provider. Their IT system can also add and remove DevFathom users automatically. Only a SuperAdmin can set this up, and there's a "test connection" button. *Example:* a 40-outlet restaurant group in Punjab connects its Microsoft login, so a new manager in Sialkot can sign in on day one without us creating an account.

**Plans, features and limits (Available now).** The console holds the list of every feature and every plan.
- **Restaurants:** *Essentials* covers 1 location, 2 tills and 5,000 orders a month. *Operations* adds purchasing, loyalty, reports and integrations, for 5 locations and 50,000 orders. *Enterprise* covers up to 100 locations and 1 million orders a month.
- **Pharmacies:** *Essentials* covers 1 branch, 2 counters and 10 users. *Professional* covers 5 branches, 10 counters and 50 users. *Chain* covers up to 100 branches and 2,500 users.
- **Hotels:** *Essentials* covers 1 property, 50 rooms and 15 users. *Pro* covers 3 properties and 250 rooms. *Chain* covers up to 100 properties. *Venue* is for wedding and event halls with no rooms.
- **Agencies:** charged per user.

For any single customer we can switch a feature on or off, or raise or lower a limit. A missing limit counts as zero, never as unlimited. *Example:* a DHA pharmacy on Essentials opens a second branch, so we raise its branch limit to 2 without changing its whole plan.

**New pharmacies are ready for side-effect reporting from day one (Available now, new).** When we create a pharmacy account, its first administrator is now given the safety permission, which a general "all permissions" grant doesn't include, and is assigned to the main branch. Existing pharmacies were updated the same way. Without this, a one-person pharmacy couldn't file or review a side-effect report. *Example:* a new single-counter pharmacy in Okara goes live, and on day one the owner can record a customer's reaction to a medicine and export it for DRAP.

**Contracts, invoices, payments and renewals (Available now).** Finance records each customer's contract and the features it includes, raises our invoices, records payments by hand (there's no online card payment for our own bills), and tracks renewals. *Example:* a Model Town agency pays its annual fee by bank transfer, and Finance marks the invoice paid.

**Sales pipeline (Available now).** Sales records leads, companies, contacts and deals, moves each deal through its stages, sends proposals, sets follow-up reminders, and turns a won deal straight into a customer account. *Example:* after a demo at a Liberty Market restaurant, Sales logs the deal, sends a proposal, and on signature converts it into a live account in one step.

**Behind-the-scenes jobs and system health (Available now).** Setting up accounts, connecting web addresses, applying brands, syncing company logins, exporting and deleting data, and camera snapshots all run as background jobs every five minutes. Staff can retry or cancel a job, and a health page shows whether the system is OK.

**Support sessions (Available now).** A support person can open a short, recorded session inside a customer's account to help them. They have to give a reason, and the session lasts between 5 and 60 minutes, then closes on its own. The customer's own history also shows that support was there. *Example:* a cashier in Bahawalpur can't see a receipt, so Support opens a 15-minute session with the reason "checking missing receipt for branch 2", looks, and leaves. (We're still confirming exactly what support can do while inside an account.) *Checked in the code:* during the session, the support person acts as one of the customer's administrators and can do anything that administrator can do, including changing data. It is not read-only. It can only be opened as an administrator, never as a cashier or other staff member. Every customer administrator gets a notice when it starts, a banner shows on screen, and every action is marked with the support session in the history. Only one session per support person per customer can be open at a time, and the account must be onboarding, active or in its grace period. This has not been QA-tested.

**Audit history (Available now).** Every action in the console is recorded, including failed attempts, and passwords and secrets are hidden from the record. Only Auditors and SuperAdmins can read it. *Known problem:* inside customer accounts, the history can currently be edited by the business itself. A fix is coming soon.

**Setting up each kind of business (Available now).** There are one-click starting setups for restaurants (first branch and brand) and for pharmacies, plus tools to switch hotel properties off and on and to register CCTV cameras for a customer.

**AI on/off and AI provider order (Available now, new).** In the console settings, a SuperAdmin chooses how DevFathom's AI runs. "Auto" tries Claude first, then OpenAI, then Amazon Bedrock if one is down. The SuperAdmin can also force one provider, or switch AI off completely for every customer. They can turn off falling back to the next provider, choose which model is used for quick, standard and deep work, and reset everything to the defaults. Azure is never used by default. AI also has to be switched on in the server settings before it runs at all. *Example:* Anthropic has an outage on a Friday evening. With fallback on, Ask Fathom at a Lahore pharmacy keeps answering through OpenAI, and nobody at the counter notices.

**Monthly AI spending limits and alerts (Available now, new).** Each AI provider has a monthly spending limit, counted in Pakistan time: Claude $190, OpenAI $190 and Amazon Bedrock $300 by default, and a SuperAdmin can change them. A spending panel shows this month's spend for each provider, and only SuperAdmins can see it. SuperAdmins get one alert at 80% and another at 100%. The console also keeps a price list for each model, which a SuperAdmin can correct. *Example:* on 24 November, OpenAI spending reaches $152. Our SuperAdmin gets a "near cap" alert and decides whether to raise the limit before the month ends.

**Planned:** AI-assistant allowances and WhatsApp message allowances per customer, set from the console, and a switch for choosing which AI service is used.

---


## Setup and limits handled by our team (moved from the business-feature file)

**WhatsApp limit of 5,000 a month per pharmacy, set by SuperAdmin (Planned, not built yet).** A planned cap of 5,000 WhatsApp messages a month per pharmacy, set by SuperAdmin. Who uses it: nobody yet, because this is not on the main code line. Limits: it does not work in the live product until the change is merged and released. *Example:* A Lahore chain would stop at 5,000 messages unless raised.

**Activation blocked until checklist done (Available now).** Our team can't switch a hotel customer live until its checklist is complete. That stops a half-set-up hotel going live by mistake. How it works: SuperAdmin activation of a hotel org refuses while any checklist step is open. Who uses it: staff of the business with access to this screen (the code behind this row is a page or shared setting, not a single permission check). Limits: no extra limits beyond the permission check were found in the code for this row. *Example:* A Murree hotel can't go live until rooms and tax are set.

**Hotel org created with first property (Available now).** When our team signs up a new hotel customer, the system creates their first property and its manager. It also adds the standard meal plans automatically, so the customer doesn't start from a blank screen. How it works: When SuperAdmin creates a hotel org, it gets a first property, a manager assignment and default meal plans. Who uses it: staff of the business with access to this screen (the code behind this row is a page or shared setting, not a single permission check). Limits: no extra limits beyond the permission check were found in the code for this row. *Example:* A new Lahore hotel account starts with its first property.

**Hotel org template and staging seed (Built, waiting to be merged).** A ready-made hotel setup for new customers, and sample data for demos and testing. This isn't available yet. Work on it was started but is paused and hasn't been reviewed or added to the product. How it works: SuperAdmin hotel template and demo data with hotel roles. Work exists only on a local, unreviewed branch and hotel building is paused (Saad, 22 Oct 15:28 PKT). Nothing is on develop or in an open PR. [/workspace/plan/hotel-build-plan.md M8 fix/hotel-template-seed]. Who uses it: nobody yet, because this is not on the main code line. Limits: it does not work in the live product until the change is merged and released. *Example:* A hotel account template and test data for staging.

