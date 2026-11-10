# DevFathom: business features by vertical, SuperAdmin excluded (technical)

Refreshed on **10 Nov 2026 (PKT)** from repo `RealDevFathom/devfathom-commercial`, branch **develop at `1906b53076286b2e1438eb821969c0d50e5575c6`** (committed 7 Nov 2026, 02:43 PKT; still the head when fetched on 10 Nov). The previous edition used `47518cbf` (1 Nov). Open PRs come from `gh pr list --state open --limit 2000`, which returned **378 open PRs** (Appendix E). The inventory was rebuilt from the code: 140 pages, 139 API routes, 80 router files with 1,094 procedures, 491 Prisma models and 271 enums (Appendices A-D).

**Status key**
- **LIVE**: the code is on develop at `1906b530`. **LIVE does not mean QA passed it.** Known bugs are noted against the feature.
- **NEW**: merged since `47518cbf`.
- **OPEN PR #n**: in an unmerged open PR.
- **KNOWN BUG**: a defect in live code, with the PR that fixes it if one exists.
- **DECISION, not built**: Saad decided it, but no code implements it yet.
- **PLANNED**: only in plans or Linear, with no code.

**What changed since `47518cbf` (25 commits on develop, 22 merged PRs)**
- **Ask Fathom and AI:** a provider router replaces the Azure-only path (Anthropic → OpenAI → Bedrock, per-provider monthly caps, model prices, confirmed AI writes) (#1238). Saad ordered Azure removed from all code on 10 Nov 2026; planned for the next Codex batch (DEV-755 / #1437).; the tool-schema fix for "fails on every request" (#1364, DEV-721); the launcher stays hidden until availability is confirmed (#1373, DEV-512).
- **Pharmacy, new features:** procedures (SOPs) on the shared SOP engine with a new `/pharmacy/sop` page (#1418, #1430); an owner/admin switch for supplier compliance checks (#1421); receiving same-lot packs from a pack photo (#1419); live DVR camera view (#1415) and camera evidence stills (#1408, #1429), both hardware-untested; the hardware acceptance matrix doc (#1407); the counter redesign (#1240).
- **Pharmacy, role gaps closed:** purchasing and supplier links (#994), the cash drawer (#1086), inventory branch access (#1120), pharmacovigilance (#247), patient read and export (#1279), batch safety re-checked at tender (#928), and the Cashier receipt gate (#1368).
- **Restaurant:** voids, cancels and SOP verification take the actor from the session and need server-verified approvers (#684).
- **Agency:** invoice numbers are unique per organization (#1226).
- **Removed:** nothing. No page, API route, router procedure or Prisma model was deleted.

**Read first**
- **Cross-tenant isolation is still untested** (QA has only one tenant). SuperAdmin features are in a separate file.
- **Still open on develop (CTO-checked 10 Nov):** any signed-in user, including a cashier, can edit the medicine catalogue, including MRP and barcodes (Sev2; fix PR #995 has merge conflicts). Marketing is owner-only, so managers are locked out, against Saad's "manager or owner" rule; closing a drawer needs only the counter permission (fix PR #996, merge conflicts). Pharmacist review: a database trigger blocks the requester from deciding their own item, but `decideReview` doesn't check it in server code and an item can be decided twice (Sev3). Cashier dashboard layout save returns 403 (DEV-602). Saad's four 3 Nov screen problems are open PRs or unstarted (DEV-734 #1422, DEV-735 no PR, DEV-736 #1389, DEV-737 #1423).
- **Fixed in code, not re-tested by QA:** Ask Fathom 503 (DEV-583) and the expiry-advisor SQL (DEV-579/580/581) were folded into #1238; growth insights "unavailable" (DEV-591) had the same cause (no provider). Each still needs a QA pass on an environment where `AI_PROVIDER` is set. Production keeps AI disabled by default.
- **Decisions, not built features:** refund approval by manager or owner PIN, and the narcotic flag for pharmacist review. Rechecked on `1906b530`: neither has code.
- Every file path and router/procedure pair cited in sections 2-7 was re-checked against `1906b530`, and all exist.
- Regulatory: the 2022 draft advertising rules and S.R.O. 1047(I)/2025 aren't verified, so this document doesn't cite them as settled.


## 2. Shared core (every vertical's tenants)

These features belong to `agency-core`, and restaurant, pharmacy and hotel tenants reuse the same routers. Vertical gating hides some of them, such as HR and agency pages, from pharmacy tenants. That gating is incomplete: PR #986 and #1005 fix it.

### 2.1 Organization administration (tenant side), sign-in and security
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Organization profile and brand | LIVE | The tenant admin edits the name, logo and colours. | `organization-admin` router (profile, brand); `/organization` page |
| Departments | LIVE | Add, edit or remove departments. Each vertical seeds defaults; for agency these are Leadership, Engineering, Product, Quality, Marketing and Design. | `organization-admin.upsertDepartment/removeDepartment`; `OrganizationDepartment` |
| Custom roles | LIVE | Create, edit or remove roles and set their permission keys. | `organization-admin.upsertRole/removeRole` |
| Members | LIVE | Create a member directly, edit their role and department, or reset their password. | `organization-admin.createMember/updateMember/resetMemberPassword` |
| Domains | LIVE | Add a domain or retry its verification. | `organization-admin.addDomain/retryDomain` |
| Outbound email settings | LIVE | | `organization-admin.updateEmail` |
| SCIM tokens (tenant side) | LIVE | | `organization-admin.createScimToken/revokeScimToken` |
| Ask Fathom on/off | LIVE | The tenant admin switches Ask Fathom on or off. Since DEV-512 (`02c108dff`) the top-bar launcher only appears once availability is confirmed for the organization. | `organization-admin.askFathomSettings/setAskFathomEnabled`; `src/lib/ai/ask-fathom-settings.ts`; `src/components/layout/topbar.tsx` |
| Deep-strategy opt-in (tenant) | LIVE (API only, no screen found) **NEW** | A tenant admin opts the organization in to the deep model for strategy questions. Without it, `deep` requests run on the standard model. The weekly owner summary always uses the deep model and doesn't need the opt-in. | `organization-admin.deepStrategySettings/setDeepStrategyEnabled`; `src/lib/ai/workload.ts` `needsDeepStrategyOptIn`; migration `20261102140000_organization_ai_deep_strategy` |
| Login, register, till login | LIVE | The login hero and the register (workspace request) form were restyled in #1240. | `/login`, `/login/register`, `/login/till`; `src/app/login/register/request-form.tsx`; `PendingLoginIntent` |
| Password reset by email | LIVE | Request a link, validate the token, set a new password. | `password-reset.request/validate/reset`; `PasswordResetToken` |
| Two-factor authentication (TOTP) | LIVE | (1) Start enrolment. (2) Confirm with a code. (3) Save the recovery codes. Users can check their status and how many recovery codes are left. | `two-factor.beginEnrollment/confirmEnrollment/getStatus/recoveryStatus/disable`; `TwoFactorRecoveryCode` |
| Tenant SSO / SCIM endpoints | LIVE | See 1.3. | `api/auth/sso/*`, `api/scim/v2/*` |
| Per-user permission overrides | LIVE | | `UserPermissionOverride`; `src/lib/abac/*` |
| Rate limiting | LIVE | | `RateLimitBucket` |
| Invite seat check has no lock | KNOWN BUG, fix in PR #36 | Concurrent invites can exceed the seat limit. | |

### 2.2 Ask Fathom (AI assistant), cross-vertical
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Ask Fathom chat | LIVE. The 503 on every question (DEV-583) and the "tool input_schema has no object root" failure (DEV-721) are fixed in code (#1238, #1364); **not re-tested by QA** | `POST /api/assistant`. Each write tool checks the user's role itself. Relative dates resolve in PKT. Missing setup is told apart from a passing failure. | `src/app/api/assistant/route.ts`; `src/lib/ai/*`; `src/lib/ai/tool-input-schema.test.ts` |
| Launcher shown only when available | LIVE **NEW** (#1373, DEV-512) | The top-bar Ask Fathom button appears only after availability is confirmed for this organization; otherwise the dashboard explains why. | `src/components/layout/topbar.tsx`; `src/lib/assistant-store.ts` |
| AI provider routing | LIVE **NEW** (#1238, DEV-576) | **AI is off unless `AI_PROVIDER` is set**; production defaults to disabled. With `auto`, calls go Anthropic → OpenAI → Bedrock, failing over on availability errors only, with a circuit breaker. Azure remains only as a legacy, explicit-only selector and is never a default or fallback. Saad ordered Azure removed from all code on 10 Nov 2026; planned for the next Codex batch (DEV-755 / #1437). | `src/lib/ai/provider.ts`, `router.ts`, `model-defaults.ts` |
| Model tiers | LIVE **NEW** | Three tiers. Quick lookups (`cheap`) run on Sonnet unless `AF_HAIKU_LOOKUPS=true` (Haiku is off by default, matching Saad's decision); `standard` is Sonnet; `deep` is Opus, used only for the weekly owner summary or when the organization opts in to deep strategy. OpenAI and Bedrock have equivalent models per tier. | `src/lib/ai/tiers.ts`, `workload.ts`, `model-defaults.ts` `DEFAULT_MODELS` |
| Weekly owner summary | LIVE (routing rule) **NEW** | Always the deep model, Anthropic only, never failed over; retried at +15 min, +1 h and +6 h. | `src/lib/ai/workload.ts` |
| Per-provider monthly spend caps | LIVE **NEW** | Default caps per Asia/Karachi calendar month: Anthropic $190, OpenAI $190, Bedrock $300 (SuperAdmin can change them). SuperAdmins are alerted once at 80% and again at 100%. | `src/lib/ai/model-defaults.ts` `DEFAULT_MONTHLY_CAPS_USD`; `src/lib/ai/usage.ts` `NEAR_CAP_PERCENT`; `AIBudgetAlertMonth`, `PlatformNotification` |
| AI usage metering | LIVE | Usage is recorded per provider and priced from `AIModelPrice` (SuperAdmin price rows win over list prices). | `src/lib/ai/spend.ts`, `usage.ts`; `AIUsage`, `AIProviderUsage`, `AIModelPrice` |
| Confirmed, idempotent AI writes; per-turn limits | LIVE **NEW** | Write actions are recorded as `AIAssistantAction` rows and run once after confirmation; turns have hard tool-call and budget limits. | `src/lib/ai/mutation-authorization.ts`, `tool-call-limit.ts`, `turn-budget.ts`; `AIAssistantAction` |
| Deep-strategy opt-in | LIVE (API only) **NEW** | See 2.1. | `organization-admin.setDeepStrategyEnabled` |
| SuperAdmin AI settings and spend panel | LIVE **NEW** | In the SuperAdmin file (section 1.11). | `ai-settings` router |
| Per-pharmacy AI credits shown to owners | PLANNED | Saad decided owners see credits, not tokens. No per-organization credit code exists yet; only the provider-wide caps above. | |
| Remove the forced requestLeave tool choice | OPEN PR #1007 | | |
| inviteMember tool skips the seat-limit check | KNOWN BUG, fix in PR #154 | | |
| Model price seeding and budget ledger | Largely covered by #1238; OPEN PR #859 and #140 may now be obsolete | | |
| AI suggestion panels in analytics, growth, finance and marketing | PLANNED | | ask-fathom-plan.md |


### 2.3 Platform services used by every vertical
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Public REST API v1 | LIVE | Endpoints for clients, invoices, projects, tasks, team, transactions, meetings and the finance summary, plus an OpenAPI spec. Calls use bearer API tokens. Docs are at `/api-docs`. | `src/app/api/v1/*`; `api-tokens.list/usage/create/revoke`; `ApiToken` |
| Outgoing webhooks | LIVE | Create, list, update or delete a webhook, and see its recent deliveries. | `webhooks` router; `Webhook`, `WebhookDelivery` |
| Tenant audit log screen | LIVE | Filters and stats. **Not append-only (PR #171).** | `/audit-logs`; `audit.list/filters/stats`; `AuditLog` |
| Global search | LIVE | | `search.global` |
| In-app notifications | LIVE | | `Notification`; `team` router notifications |
| File upload and download | LIVE | Licence scans can be read by any tenant member (PR #252). | `/api/upload`, `/api/files/[name]` |
| Realtime (Ably) | LIVE, needs credentials | | `/api/ably-token` |
| Video meetings (LiveKit) | LIVE, needs credentials | | `/meet`, `/api/livekit/webhook` |
| Apple and Google wallet passes | LIVE, needs credentials | Used by loyalty. | `/api/wallet/*`, `/wallet/join`; `WalletPass*`, `WalletTenantConfig`, `WalletEnrollment*` |
| Customer identity, consent and tags (shared CRM base) | LIVE | | `CustomerIdentifier`, `CustomerConsent`, `CustomerTag*`, `CustomerInteraction` |
| Cameras: gateway, credentials, stream grants, evidence | LIVE | Shared by restaurant and pharmacy. Since #1415 the MediaMTX transport takes a `vertical` binding (`restaurant` or `pharmacy`); bindings without one stay restaurant-only. Since #1408 evidence stills can come from a gateway-side snapshot service. **Hardware untested** (DEV-740/DEV-745 stay open). | `Camera*` models; `restaurant-cameras`, `pharmacy-cameras`; `src/lib/cameras/mediamtx.ts`, `snapshot-transport.ts`, `png-still.ts`; `src/components/camera/camera-live-player.tsx` |
| Growth insights | LIVE; showed "unavailable" because no AI provider was configured (DEV-591). The provider router from #1238 removes that cause where `AI_PROVIDER` is set; not re-tested by QA | Provider diagnostics were removed from the owner growth view (DEV-721). | `GrowthInsight`; `src/app/(app)/pharmacy/marketing/growth-panel.tsx` |
| Background jobs for procedures | LIVE **NEW** | An hourly parent job fans out per-branch child jobs on the existing job queue for pharmacy SOP auto-scheduling (restaurant job handlers register it). | `src/lib/pharmacy/sop-auto-schedule-job.ts`; `src/lib/restaurant/job-handlers.ts` |


### 2.x Dashboard


| Feature | Implementation status | Detail |
|---|---|---|
| Dashboard page | LIVE | Home screen with stats, activity, deadlines, project cards, my tasks and revenue. [src/app/(app)/dashboard] |
| Headline stats | LIVE | Counts of projects, tasks, clients and money at a glance. [src/server/routers/dashboard.ts getStats] |
| Recent activity feed | LIVE | What changed lately across the workspace. [src/server/routers/dashboard.ts getRecentActivity] |
| Upcoming deadlines | LIVE | Tasks and milestones due soon. [src/server/routers/dashboard.ts getUpcomingDeadlines] |
| Project cards | LIVE | Progress card per project. [src/server/routers/dashboard.ts getProjectCards] |
| My tasks | LIVE | Tasks assigned to you. [src/server/routers/dashboard.ts getMyTasks] |
| Revenue chart | LIVE | Revenue over time. [src/server/routers/dashboard.ts getRevenueChart] |
| Dashboard layout preferences | LIVE | Choose which widgets show. [src/server/routers/dashboard.ts getPreferences / updatePreferences] |
| Appearance (theme) | LIVE | Light or dark theme and look. [src/server/routers/dashboard.ts updateAppearance] |
| Global search | LIVE | Search across projects, tasks, clients, notes and more from one box. [src/server/routers/search.ts global] |


### 2.x Team & HR


| Feature | Implementation status | Detail |
|---|---|---|
| Team page | LIVE | Staff directory. [src/app/(app)/team] |
| Team member page | LIVE | One person's profile. [src/app/(app)/team/[id]] |
| HR page | LIVE | HR overview for admins. [src/app/(app)/hr/hr-content.tsx] |
| Team list | LIVE | See everyone. [src/server/routers/team.ts getAll] |
| Roster | LIVE | Who's working and who's on leave. [src/server/routers/team.ts getRoster] |
| Invite member | LIVE | Send an email invite to join. [src/server/routers/team.ts inviteMember] |
| View member | LIVE | Open a profile. [src/server/routers/team.ts getById] |
| Request leave | LIVE | Ask for time off. [src/server/routers/team.ts createLeaveRequest] |
| Cancel leave request | LIVE | Withdraw a request. [src/server/routers/team.ts cancelLeaveRequest] |
| Edit leave request | LIVE | Change dates. [src/server/routers/team.ts updateLeaveRequest] |
| Approve / reject leave | LIVE | Manager decides. [src/server/routers/team.ts updateLeaveStatus] |
| List leave requests | LIVE | See requests. [src/server/routers/team.ts getLeaveRequests] |
| Leave balances | LIVE | Days remaining per person. [src/server/routers/team.ts getLeaveBalances] |
| Set leave balance | LIVE | Admin sets allowance. [src/server/routers/team.ts setLeaveBalance] |
| Team leave calendar | LIVE | Who's off when. [src/server/routers/team.ts getTeamLeaveCalendar] |
| Edit own profile | LIVE | Name, photo, details. [src/server/routers/team.ts updateProfile] |
| Change password | LIVE | Change your password. [src/server/routers/team.ts changePassword] |
| Sign out everywhere | LIVE | Log out all devices. [src/server/routers/team.ts signOutEverywhere] |
| My sign-ins | LIVE | See where you're logged in. [src/server/routers/team.ts mySignIns] |
| Notifications list | LIVE | In-app notifications. [src/server/routers/team.ts getNotifications] |
| Mark notification read | LIVE | Clear one. [src/server/routers/team.ts markNotificationRead] |
| Mark all read | LIVE | Clear all. [src/server/routers/team.ts markAllNotificationsRead] |
| Notification preferences | LIVE | Choose what you're notified about. [src/server/routers/team.ts getNotificationPrefs / updateNotificationPrefs] |
| Admin edit member | LIVE | Admin changes someone's details or role. [src/server/routers/team.ts adminUpdateMember] |
| Admin reset password | LIVE | Admin resets someone's password. [src/server/routers/team.ts adminResetPassword] |
| Lay off member | LIVE | Admin offboards someone. [src/server/routers/team.ts layOffMember] |
| Performance notes | LIVE | Private manager notes per person: list, add, delete. [src/server/routers/team.ts listPerformanceNotes / addPerformanceNote / deletePerformanceNote] |
| HR overview | LIVE | Headcount, leave and HR stats. [src/server/routers/team.ts getHrOverview] |
| Team stats | LIVE | Workload and output per person. [src/server/routers/team-stats.ts getAll / getForUser] |
| Submit resignation | LIVE | Employee resigns in-app. [src/server/routers/resignations.ts submit] |
| My resignation | LIVE | See own status. [src/server/routers/resignations.ts mine] |
| Withdraw resignation | LIVE | Take it back. [src/server/routers/resignations.ts withdraw] |
| All resignations | LIVE | HR list. [src/server/routers/resignations.ts listAll] |
| Review resignation | LIVE | HR accepts or declines. [src/server/routers/resignations.ts review] |
| Create review cycle | LIVE | Start a performance review round. [src/server/routers/reviews.ts createCycle] |
| List review cycles | LIVE | See rounds. [src/server/routers/reviews.ts listCycles] |
| Close / reopen cycle | LIVE | Lock or unlock a round. [src/server/routers/reviews.ts closeCycle / reopenCycle] |
| Add review | LIVE | Assign a reviewer. [src/server/routers/reviews.ts addReview] |
| Submit review | LIVE | Fill in the review. [src/server/routers/reviews.ts submitReview] |
| List reviews | LIVE | See reviews. [src/server/routers/reviews.ts listReviews] |
| My reviews | LIVE | Reviews about or by you. [src/server/routers/reviews.ts myReviews] |
| Team REST API | LIVE | Public API for team. [src/app/api/v1/team/route.ts] |
| Payroll | PLANNED | No payroll. [src/server/routers/team.ts (no payroll procedures)] |


### 2.x Chat


| Feature | Implementation status | Detail |
|---|---|---|
| Chat page | LIVE | Team messaging with channels and DMs; messages appear live. [src/app/(app)/chat] |
| Channel list | LIVE | Your channels. [src/server/routers/chat.ts getChannels] |
| Read messages | LIVE | Message history. [src/server/routers/chat.ts getMessages] |
| Threads | LIVE | Reply in a thread. [src/server/routers/chat.ts getThread] |
| Send message | LIVE | Post a message. [src/server/routers/chat.ts sendMessage] |
| Edit message | LIVE | Change it; edit history kept. [src/server/routers/chat.ts editMessage / getMessageEditHistory] |
| Delete message | LIVE | Remove it. [src/server/routers/chat.ts deleteMessage] |
| Reactions | LIVE | Emoji reactions. [src/server/routers/chat.ts toggleReaction] |
| Mark read | LIVE | Unread tracking. [src/server/routers/chat.ts markRead] |
| Search messages | LIVE | Find old messages. [src/server/routers/chat.ts searchMessages] |
| Pin message | LIVE | Pin in channel. [src/server/routers/chat.ts togglePin / getPins] |
| Save message | LIVE | Bookmark for yourself. [src/server/routers/chat.ts toggleSave / getSaved] |
| @mentions | LIVE | Mention people. [src/server/routers/chat.ts getMentionTargets] |
| Create channel | LIVE | New channel. [src/server/routers/chat.ts createChannel] |
| Edit channel | LIVE | Rename, describe. [src/server/routers/chat.ts updateChannel] |
| Archive channel | LIVE | Archive. [src/server/routers/chat.ts archiveChannel] |
| Delete channel | LIVE | Delete. [src/server/routers/chat.ts deleteChannel] |
| Browse channels | LIVE | Find channels to join. [src/server/routers/chat.ts browseChannels] |
| Join / leave channel | LIVE | Join or leave. [src/server/routers/chat.ts joinChannel / leaveChannel] |
| Channel members | LIVE | Add, remove, list members. [src/server/routers/chat.ts addMembers / removeMember / getMembers] |
| Direct messages | LIVE | Start a 1:1 chat. [src/server/routers/chat.ts createOrGetDM] |
| Mute channel | LIVE | Silence notifications. [src/server/routers/chat.ts setMuted] |


### 2.x Notes


| Feature | Implementation status | Detail |
|---|---|---|
| Notes page | LIVE | Shared docs/wiki. [src/app/(app)/notes] |
| List notes | LIVE | Your notes. [src/server/routers/notes.ts list] |
| View note | LIVE | Open one. [src/server/routers/notes.ts getById] |
| Create note | LIVE | Write a note. [src/server/routers/notes.ts create] |
| Edit note | LIVE | Change it. [src/server/routers/notes.ts update] |
| Delete note | LIVE | Remove it. [src/server/routers/notes.ts delete] |
| Search notes | LIVE | Find notes. [src/server/routers/notes.ts search] |
| Mentions of me | LIVE | Notes that @mention you. [src/server/routers/notes.ts notesMentioningMe] |
| Version history | LIVE | See old versions. [src/server/routers/notes.ts getNoteRevisions / getRevision] |
| Restore version | LIVE | Roll back. [src/server/routers/notes.ts restoreRevision] |
| Share note | LIVE | Choose who can see or edit. [src/server/routers/notes.ts setShares] |


### 2.x Meetings


| Feature | Implementation status | Detail |
|---|---|---|
| Meetings page | LIVE | Schedule and join video meetings (LiveKit). [src/app/(app)/meetings; src/server/meetings/provider/livekit.ts] |
| Guest join link | LIVE | Outside guests join via a public meeting page. [src/app/meet/[publicId]] |
| Upcoming meetings | LIVE | Next meetings. [src/server/routers/meetings.ts getUpcoming] |
| All / past meetings | LIVE | History. [src/server/routers/meetings.ts getAll / getPast] |
| Schedule meeting | LIVE | Create, incl. repeating. [src/server/routers/meetings.ts create] |
| Edit meeting | LIVE | Change it. [src/server/routers/meetings.ts update] |
| Delete meeting | LIVE | Cancel entirely. [src/server/routers/meetings.ts delete] |
| View meeting | LIVE | Details. [src/server/routers/meetings.ts getById] |
| Join meeting | LIVE | Join and log attendance. [src/server/routers/meetings.ts markJoined / logJoin / logLeave] |
| Repeat occurrences | LIVE | See dates of a repeating meeting. [src/server/routers/meetings.ts getOccurrences] |
| Reschedule one occurrence | LIVE | Move one date. [src/server/routers/meetings.ts rescheduleOccurrence] |
| Cancel one occurrence | LIVE | Skip one date. [src/server/routers/meetings.ts cancelOccurrence] |
| Invite guest | LIVE | Create a guest invite. [src/server/routers/meetings.ts createGuestInvitation] |
| Revoke guest invite | LIVE | Cancel it. [src/server/routers/meetings.ts revokeGuestInvitation] |
| Attendance report | LIVE | Who joined and for how long. [src/server/routers/meetings.ts getAttendanceReport] |
| Meetings REST API | LIVE | Public API for meetings. [src/app/api/v1/meetings/route.ts] |
| Meeting recording / transcripts | PLANNED | Not built. [src/server/meetings (no recording code)] |


### 2.x Email inbox


| Feature | Implementation status | Detail |
|---|---|---|
| Email page | LIVE | Read and send your own Gmail or Outlook mail inside DevFathom. Needs Google/Microsoft OAuth configured on the server; buttons are disabled otherwise. [src/app/(app)/email; src/server/routers/email.ts providers] |
| Connect Gmail / Outlook | LIVE | Sign in to link a mailbox. [src/server/routers/email.ts connectStart / connectCallback] |
| List mailboxes | LIVE | Linked accounts. [src/server/routers/email.ts listMailboxes] |
| List messages | LIVE | Inbox. [src/server/routers/email.ts listMessages] |
| Read message | LIVE | Open one. [src/server/routers/email.ts getMessage] |
| Send email | LIVE | Send from your mailbox. [src/server/routers/email.ts sendMessage] |
| Mark read | LIVE | Mark read. [src/server/routers/email.ts markRead] |
| Refresh | LIVE | Sync now. [src/server/routers/email.ts refresh] |
| Disconnect mailbox | LIVE | Unlink. [src/server/routers/email.ts disconnect] |


### 2.x Integrations & admin


| Feature | Implementation status | Detail |
|---|---|---|
| Webhooks | LIVE | Send events to other systems: list, create, edit, delete, see recent deliveries. [src/server/routers/webhooks.ts list / create / update / delete / recentDeliveries] |
| API tokens | LIVE | Create, list, revoke tokens and see usage for the public API. [src/server/routers/api-tokens.ts list / create / revoke / usage] |
| API docs page | LIVE | In-app public API reference. [src/app/(app)/api-docs; src/app/api/v1/spec/route.ts] |
| Audit log page | LIVE | Who did what, for admins. [src/app/(app)/audit-logs; src/server/routers/audit.ts] |
| Organization admin page | LIVE | Manage people and org settings. [src/app/(app)/organization; src/server/routers/organization-admin.ts] |
| Settings page | LIVE | Profile, preferences and plan details. [src/app/(app)/settings] |

## 3. Pharmacy

Status labels in this section already use current develop and current PR numbers. Router abbreviations: `ps` = pharmacy-sales, `pp` = pharmacy-purchasing, `pm` = pharmacy-medicine, `pi` = pharmacy-inventory, `app` = `src/app/(app)/pharmacy`.

**Role gaps, rechecked on `1906b530` (10 Nov 2026):**
- **Closed since 2 Nov:** purchasing and supplier links (#994, deny-by-default with explicit capabilities), the cash drawer (#1086), inventory branch access (#1120), pharmacovigilance (#247), patient read and export (#1279). Day close was already closed on 2 Nov.
- **Still open:** catalogue edits in `pharmacy-medicine` are open to any signed-in user (`createMedicine`, `createPackLevel`, `revisePackLevel`, `recordPrintedMrp`, `addBarcode`, `addAlias` are bare `protectedProcedure`; Sev2; fix PR #995, merge conflicts). Campaigns in `pharmacy-marketing` are owner-only (`owner()` requires session role `ADMIN` plus the `pharmacy-crm` module), so managers are locked out; `closeDrawer` needs only `pharmacy:counter`. Fix PR #996 (manager or owner; merge conflicts, no QA or Security verdict on its latest commit). Neither router changed since `47518cbf`.
- **Decisions, not built features:** refund approval by manager or owner PIN, and the narcotic flag for pharmacist review. See the rows below.

### 1. POS and sales

| Feature | Status | Evidence |
|---|---|---|
| Counter sale: search, scan, cart, lot pick, tender, receipt | LIVE, **layout redesigned** (#1240, DEV-618, merged as a draft-titled PR) | New header with branch picker, returns and orders actions, drawer controls and bill/held/drawer pills; bill-context chips (patient and prescription, safety blocks, loyalty and khata); a sticky Pay bar on small screens. Backend calls unchanged. Since DEV-295 (#1368, `11660b315`) the receipt gate accepts the canonical `pharmacy:counter` grant, so the shipped Cashier template works without legacy dotted grants. Since #928 (`72fdd5588`) batch expiry, recall and quarantine are re-checked at tender and at completion, not only at add-to-cart. Evidence: `app/counter/page.tsx`; `src/components/pharmacy/counter/counter-console.tsx`, `counter-cart.tsx`, `counter-rx-panel.tsx`, `counter-tender-panel.tsx`; `ps` counterSearch, counterCart, counterLotOptions, tender, tenderOutcome, counterReceipt; `src/lib/pharmacy/sale-batch-safety.ts`; `docs/qa/dev-618-counter-redesign.md` |
| Pack authentication by scan at the counter | LIVE | `ps` authenticatePack |
| Custom keyboard shortcuts per cashier | LIVE | `ps` counterKeymap, counterSaveKeymap |
| Receipt format and printing (browser print and print jobs) | LIVE | `ps` counterReceiptFormat, counterReceiptPrintJob; `src/app/api/pharmacy/print`; `src/lib/pharmacy/counter-browser-print.ts` |
| Manual payment settings (bank or wallet details) and a payment sandbox | LIVE | `ps` manualPaymentSettings, saveManualPaymentSettings, sandboxPayment. The sandbox is removed in PR #1162 |
| Cash drawer: open, cash in and out, close | LIVE. **Sev1 gap closed by #1086 (merged 6 Nov)** | `openDrawer`, `drawerMovement` and `closeDrawer` now call `requireCounterReceiptAccess(ctx, branchId, true)`, the same gate cash tender uses: deny-wins `can('pharmacy:counter')`, the counter family check, then an active assignment to this active branch (or the audited session-ADMIN exception, which still needs the counter grant). So closing a drawer needs only the counter permission today; manager-or-owner drawer close is still only in PR #996 (merge conflicts). Evidence: `ps` openDrawer, drawerMovement, closeDrawer, drawerStatus; `pharmacy-sales.drawer-auth.test.ts` |
| Day close: preview, close and evidence | LIVE. **Code differs from notes: the gap is fixed on develop.** `closePreview`, `closeDay` and `dailyClose` call `requireCloseAccess` (ADMIN, or `can(...,'pharmacy:close')`); `dailyCloseEvidence` is `adminProcedure` | `app/counter/close`; `ps` closePreview, closeDay, dailyClose, dailyCloseEvidence. Fix: PR #996 (manager or owner only). #992 adds the `requireCloseAccess` check; #802 must not loosen it |
| Returns and refunds with receipt lookup | LIVE | `returnLine` and `refundTender` require counter receipt access (`requireCounterReceiptAccess`); a controlled-medicine return needs a witness PIN. There is **no manager or owner approval** step. Branch-scoped lookup: PR #997; counter capability and branch assignment on returns: PR #917. Evidence: `ps` lookupReceiptByNumber, returnLine, returnHistory, refundTender |
| Refund approval by manager or owner PIN | **DECISION, not built** | Saad decided that only a manager or the owner can approve a refund, with their PIN. Rechecked on `1906b530`: refunds still need only counter access, no PIN-approval code exists, the `fix/refund-manager-approval` branch no longer exists on the remote, and no open PR implements it (#917 and #251 only add counter capability and branch checks). Document it as a decision until code lands. Evidence: Searched `src/` for refund PIN/approval code on 10 Nov 2026: none |
| Offline counter (device enrolment, lease, replay, quota) | LIVE | `src/server/routers/pharmacy-offline.ts`; `src/app/api/pharmacy/counter/{establish,lease,replay,quota,snapshot}` |
| Customer ordering and delivery (place, cancel, staff queue, runners, checkout) | LIVE | `src/server/routers/pharmacy-ordering.ts`; `app/orders` |
| Lost-sale demand capture and restock interest (tell the customer when stock is back, opt-out) | LIVE | `ps` captureDemand, demandAggregate, addRestockInterest, captureSafeRestockArrival, optOutRestockInterest, restockRecoveryReport |
| Substitution and upsell suggestions, duplicate-salt warning | LIVE | `ps` substituteProposals, upsellSuggestions, declineSubstitute, acknowledgeDuplicateSalt; `app/substitution` |
| Settlement controls shown only to people with the capability | PR #1163 | |
| Direct sign-out from Counter | PR #1162 | |
| Tenant currency in day-close totals | PR #1101 | |
| Readable mobile receipts / responsive layout | PR #1189, #1003 | |
| Faster counter scan and search (Sev1 perf) | OPEN PR #1382 (DEV-575) | |
| Counter follow-ups opened since 2 Nov | OPEN PRs | Khata repayment #1362 (DEV-731), manual wallet tenders #1363, brand first in results #1365, quantity entry #1367, keymap selector #1369, keep the receipt after payment #1371, tender speed #1372, counter shell v2 #1375, Pharmacist and Cashier can take payment for an Rx bill #1376, server-side Rx check #1377, receipt details #1378, change-due display #1384, consistent branch admission #1247 |


### 2. Dispensing and prescriptions

| Feature | Status | Evidence |
|---|---|---|
| Patients, consent, prescription uploads and reading, extraction, capture, fill | LIVE | `src/server/routers/pharmacy-prescriptions.ts`; `app/prescriptions`; `src/app/api/pharmacy/prescription-files` |
| Patient read and export | LIVE, **gated since #1279 (DEV-624)** | `readPatient` and `exportPatient` now require the exact-grant `pharmacy:prescriptions` capability before lookup, and export masks CNIC and phone. Patient scope stays organization-wide. Evidence: `pharmacy-prescriptions.ts` readPatient, exportPatient (`capabilityProcedure('pharmacy:prescriptions')`) |
| Refill reminders (capture) | LIVE | captureRefillReminder; `src/app/api/pharmacy/whatsapp/reminders` |
| Counter patient panel | LIVE | counterPatients, counterPatientPanel |
| Rx-only sale gate (a prescription reference is needed) | LIVE | `ps` tests `pharmacy-sales.rx-sale-gate.db.test.ts`, `rx-prescription-reference.db.test.ts` |
| Pharmacist queue / dispensing | LIVE, **gaps found in code** | Read by hand on 2 Nov 2026; `pharmacy-dispensing.ts` is **unchanged** at `1906b530`, so these gaps still stand. `src/server/routers/pharmacy-dispensing.ts` (109 lines) has six procedures, all `capabilityProcedure('pharmacy:dispense')`: `returnVerificationQueue` (branch-checked queue of quarantined returns; verification never credits AVAILABLE stock), `reviewQueue`, `substitutionWorkspace`, `enqueueReview` (prescriptionLineId and saleLineId), `decideReview` (VERIFY / CLARIFY / REFUSE / OVERRIDE / COUNSEL / SIGN, optional reason, `signedAt` set on SIGN) and `recordSubstitution` (prescribed vs supplied presentation, equivalence basis, patient communication and jurisdiction rule ref, all required). Gaps: `decideReview` doesn't check in server code that the decider isn't the requester. A database trigger (`pharmacy_review_no_self_approval`, migration `20260902170000`) does refuse it, so self sign-off fails, but only as a database error (CTO-checked 10 Nov; Sev3). A reason is optional for REFUSE and OVERRIDE (the database requires one for OVERRIDE). The item's state isn't checked and decisions have no uniqueness rule, so an item can be decided twice. `reviewQueue` and `substitutionWorkspace` have no branch or status filter and no paging; they rely on tenant DB scoping only. UI: `components/pharmacy/dispensing/pharmacist-queue-console.tsx`, `substitution-console.tsx` |
| Medicine-name search in prescription capture | PR #1152 | |
| Capability checks for patient and consent | PR #1006 | |
| Patient denial test coverage | PR #1172, #1072 | |


### 3. Inventory and batches

| Feature | Status | Evidence |
|---|---|---|
| Stock on hand, stock signals dashboard and digest | LIVE, **branch-gated since #1120** | `onHand`, `stockSignalDashboard`, `stockSignalDigest` and 15 other inventory procedures admit a caller only with an active assignment to an active branch, or as a verified active tenant ADMIN (Saad's "ADMIN = Owner" decision, inventory only). The pages show a "branch assignment required" panel otherwise. Evidence: `pi` onHand, stockSignalDashboard, stockSignalDigest (`admittedScopeFor`); `app/inventory`; `src/components/pharmacy/inventory/branch-assignment-required.tsx` |
| Medicine catalogue: ingredients, medicines, pack levels, printed MRP, loose-unit price, barcodes, aliases, scan resolve | LIVE, **Sev2 gap** on edits: any signed-in user, including a cashier, can create medicines and pack levels, record printed MRP and add barcodes and aliases (bare `protectedProcedure`). Fix PR #995 (merge conflicts) | `pm` createIngredient, createMedicine, createPackLevel, revisePackLevel, recordPrintedMrp, addBarcode, addAlias; `app/medicines` |
| Price notices, price confirmation, pack prices and overrides | LIVE | `pm` priceNotices, confirmPrices, setPackPrice, priceOverrides; `app/medicines/prices` |
| Reference catalogue connector (proposals and decisions) | LIVE | `pm` configureReferenceConnector ... decideReferenceConnectorProposal |
| Duplicate detection and catalogue review decisions | LIVE | `pm` duplicateGroups, recordReviewDecision, publishAssertions |
| Staged catalogue import review | LIVE | `src/server/routers/pharmacy-staged-review.ts`; `app/medicines/staged` |
| Opening-stock import (upload, preview, commit, history) | LIVE | `src/server/routers/pharmacy-owner-import.ts`; `app/inventory/import`, `app/inventory/imports`. Fixes: flat packs #1149, publishing creates pack and barcode #993 |
| Branch transfers | LIVE | `transferBoard` now needs `pharmacy:inventory` (#994), and every transfer step is branch-admitted (#1120). Evidence: `pi` transferBoard, transfer, allocateTransfer, approveTransfer, dispatchTransfer, receiveTransferLine, receiveTransferWithVariance; `app/inventory/transfers` |
| Expiry board and near-expiry lots | LIVE | `pi` nearExpiryBoard, expiryBoardLots; `app/inventory/expiry` |
| Expiry advice / expiry returns / work-pack expiry evidence | LIVE. The wrong-table/column SQL (DEV-579/580) and the missing org and branch filter (DEV-581) were folded into #1238 (merged 3 Nov), which adds `expiry-advisor.db.test.ts`; not re-tested by QA | Bounded owner expiry advice: PR #1156; clearer failures: PR #1150; distributor grouping and return claims: PR #1388. Evidence: `src/lib/pharmacy/expiry-advisor-operations.ts` |
| Temperature zones / cold chain | LIVE | `pi` temperatureZoneStatuses |
| DRAP recall actions and recall trace, recall write-off guard | LIVE | `pi` drapRecallActions, recallTrace; `src/lib/pharmacy/inventory-operations.ts`. A failing writeOff test is tracked as DEV-577 |
| Catalogue edits go through review (separation of duties) | PR #995 | |
| Inventory capability plus branch assignment | **LIVE (merged #1120, 6 Nov)** | See "Stock on hand". `pharmacy-inventory.branch-assignment.db.test.ts` |
| Default catalogue for new pharmacies | PR #970 | Catalog data: 18,933 rows; DRAP reg. numbers and Rx, restricted and controlled flags are empty (`/workspace/research/catalog-filled-report.md`) |
| Pack and barcode edits | PR #993 | |
| Pharmacy record retention periods | PR #1165, **failed security** (a global lock serializes every tenant) | |
| Narcotic flag for pharmacist review | **DECISION, not built** | Saad decided narcotics get flagged for a pharmacist to review. Rechecked on `1906b530`: there is no narcotic flag or review queue for it (the only "narcotic" string is a marketing word filter in `rfm-winback.ts`). What does exist is separate: a medicine marked `controlled` needs patient address, an independent pharmacist PIN, and a prescription or emergency supply at the counter, and is written to the controlled register. PR #25 (`improve/narcotics-provinces`) covers provincial register rules, not the flag. Evidence: `ps` controlledAuthorization (pre-existing); `src/lib/pharmacy/controlled-register.ts` |


### 4. Purchasing and goods-in

Since #994 merged (6 Nov, `1906b5307`), every purchasing and staff supplier-link procedure is `denyByDefaultProcedure` with explicit capabilities: `pharmacy:procurement` for buying work, `pharmacy:procurement-approve` for approving and sending, and financial permission for returns and credits, plus tenant and active-branch scope. **Not re-tested by QA.**
| Feature | Status | Evidence |
|---|---|---|
| Suppliers, supplier licences and authorization | LIVE | Now capability-gated (#994). New `verifySupplierLicence`: verification keeps independent filing attribution and stored evidence, so the filer is recorded separately from the verifier. Evidence: `pp` createSupplier, recordSupplierLicence, verifySupplierLicence, setSupplierAuthorization; `app/purchasing/suppliers` |
| Supplier compliance switch (owner/admin) | LIVE **NEW** (#1421, DEV-753) | One pharmacy setting turns the two supplier checks (licence evidence and trade authorization) on or off. **Default ON and fails closed**: a missing or unreadable policy is enforced; only a stored `false` turns them off. When OFF, purchasing, receiving, central ordering, quotes and onboarding stop asking for them and suppliers show "Not checked"; the UI says the pharmacy stays responsible for legal sourcing. Controlled-drug safeguards (witness PIN at goods-in, the register, counter checks) are never affected. Evidence: `src/server/routers/pharmacy-supplier-compliance.ts` policy, history, skips, setPolicy; `src/lib/pharmacy/supplier-compliance-policy.ts`; `app/purchasing/suppliers/_components/supplier-compliance-panel.tsx`; migration `20261106190000_pharmacy_supplier_compliance_policy` |
| Requisitions, quotes, quote comparison | LIVE | `pp` createRequisition, submitRequisition, recordQuote, compareQuotes |
| Purchase orders: create, submit, approve, send, landed cost | LIVE | Approval now needs `pharmacy:procurement-approve` and is separate from raising the order (#994). A solo owner may approve their own order after a fresh PIN, with transaction-local proof and an audit row; `provisionMyPurchasePin` lets them set that PIN. The owner-operator template is excluded from the solo-owner path. Evidence: `pp` ...PurchaseOrder, landedCost, provisionMyPurchasePin; `src/lib/pharmacy/purchase-approval.ts`, `solo-owner.ts`; migrations `20261106200000`, `20261106200100`, `20261106200200` |
| Goods receiving: post, reverse, scan, pack authentication, exceptions queue | LIVE | Capability-gated since #994. Evidence: `pp` createGoodsReceipt, postGoodsReceipt, reverseGoodsReceipt, receivingExceptions; `app/purchasing/receiving` |
| Receive same-lot packs from a pack photo | LIVE **NEW** (#1419, DEV-752), **off unless `PHARMACY_PACK_OCR_ADAPTER` is `FIXTURE` or `VISION`** | While receiving against a PO, the receiver photographs one pack. Batch and expiry come back as editable suggestions, the receiver enters how many packs share them and optionally a shelf, and the values fill that line. The photo never drafts, posts, prices or identifies anything; stock still moves only through the normal receipt post. Needs procurement capability and the `pharmacy-procurement` module; 20 reads a minute per person and 60 per tenant; blocked for demo tenants; the photo is re-encoded, sent once, never stored and kept out of audit rows. Evidence: `src/server/routers/pharmacy-pack-label.ts` read; `src/lib/pharmacy/pack-label-ocr.ts`, `pack-photo-receiving.ts`; `app/purchasing/_components/pack-photo-reader.tsx` |
| Controlled-drug witnesses at goods-in (co-auth; the second checker must hold dispense) | LIVE | `pp` controlledWitnesses; `pharmacy-witness-enumeration.test.ts` |
| Purchase returns, debit notes, supplier credits | LIVE | `pp` createPurchaseReturn ... allocateSupplierCredit; `app/purchasing/returns` |
| Central (multi-branch) purchasing | LIVE | `pp` centralDemand, createCentralPurchaseOrder, allocateCentralReceipt; `src/lib/pharmacy/central-purchasing.ts` |
| Supplier portal links (issue, revoke, document upload, proposals) | LIVE. **Permission gap closed by #994**: staff procedures now need `pharmacy:procurement` and branch scope | `src/server/routers/pharmacy-supplier-links.ts`; `src/app/supplier/po/[token]` |
| Server-side role guard and branch membership (deny by default, approver permission) | **LIVE (merged #994, 6 Nov)** | PR J and #984 remain open; check whether they are now superseded. Evidence: `src/server/trpc.ts` denyByDefaultProcedure; `src/server/pharmacy-procurement-scope.ts`; `pharmacy-purchasing.authz.test.ts` |
| PO approval with PIN self-approval for solo owners, with audit | **LIVE (folded into #994)** | #994 says it "composes the normal merge of #246"; PR #246 is still open and probably redundant. Evidence: see Purchase orders |
| Goods-receipt branch check before the PO is locked | PR #1148 | |
| Returns access for procurement roles | PR #1151 | |
| Supplier-return claim journal | PR #1116 | |
| Branch-limited staff can't touch other branches' POs | PR #855 | Rebase after J |
| Shared PO eligibility validation, partial invoice balances | PR #1193, #1182 | |
| Goods-in live search; progressive PO line fields | OPEN PR #1422 (DEV-734), #1381 (DEV-517) | |


### 5. Customers and loyalty

| Feature | Status | Evidence |
|---|---|---|
| Customer directory, link a customer to a sale, customer snapshot | LIVE | `ps` customerDirectory, linkCustomer, customerSnapshot |
| Loyalty points redemption | LIVE | `ps` redeemPoints; `app/loyalty` |
| Khata (customer credit) accounts and statements | LIVE | `ps` khataAccounts, khataStatement |
| Khata WhatsApp reminders | LIVE | `src/app/api/pharmacy/whatsapp/khata-reminders/route.ts` |
| Khata Urdu templates and language choice | PR #814 | |


### 6. HR and roles

| Feature | Status | Evidence |
|---|---|---|
| Pharmacy role templates: Owner (`pharmacy:*`, both reports, exact `pharmacy:safety`), Owner/Operator (12 exact grants incl. `pharmacy:procurement-approve`), Pharmacist (dispense, catalogue-review, close), Manager (manage, orders, procurement, procurement-approve), Cashier (counter, orders), Procurement, Inventory, Finance, Auditor; new tenants also get `sop:*` grants per role | LIVE | `src/lib/vertical-catalog.ts:781` (base) and `:874` (`PHARMACY_SOP_TEMPLATE_GRANTS`). The bootstrap admin of a new pharmacy gets `*` plus exact `pharmacy:safety` and is assigned to the MAIN branch (#247). |
| Separation-of-duties permissions `pharmacy:dispense`, `pharmacy:prescriptions`, `pharmacy:safety`, `pharmacy:catalogue-review` (exact grant only; `*` and `pharmacy:*` never match them) | LIVE | `src/lib/abac/capabilities.ts` `EXACT_GRANT_ONLY_ACTIONS`; `policies.ts`; `owner-access.ts` |
| Org roles, custom roles, deny overrides (ABAC) | LIVE | `src/server/authz.ts`; `src/server/routers/organization-admin.ts` |
| Branch assignments and branch scope | LIVE | `src/server/routers/pharmacy-branch-assignments.ts`; `src/lib/pharmacy/branch-scope.ts`; `app/settings/branches` |
| Navigation by access | LIVE **NEW** (#994) | The sidebar asks the server which pharmacy areas the user can open, so hidden links match the server checks. Evidence: `src/server/routers/pharmacy-access.ts` navigation; `src/components/layout/sidebar.tsx` |
| Team, invites, last-admin guard | LIVE | `src/server/routers/team.ts` |
| Role-based dashboards | LIVE, bug: a cashier can't save a layout (403) and sees "Owner command centre" (DEV-602) | `src/app/(app)/dashboard/pharmacy-dashboard-content.tsx` |
| Updated role templates (pharmacist sells, takes payment and opens the drawer; manager closes the day) | PR #992 | Security PASS at b3522d4 |
| Deny-wins ABAC | LIVE on develop (per #1086 and #1120 bodies: "develop is already deny-wins"); PR #683 (Codex HIGH h1) is still open for its other changes | `src/lib/abac/index.ts` |
| Device co-approval; device revoke needs `devices:revoke` | PR #685, #1064 | |
| OTP login with email masking | PR #988 | |
| Pharmacy HR roles plan | PLANNED | `/workspace/plan/pharmacy-hr-roles-plan.md` |
| Role landing pages, dark mode | PLANNED | CTO notes |


### 7. Reports and finance

| Feature | Status | Evidence |
|---|---|---|
| Reports hub: replenishment, branch comparison, repeat purchasing, supplier credit follow-up | LIVE | `app/reports/*`; `src/server/routers/pharmacy-reports.ts` |
| Financial figures limited to people with `reports:financial` | LIVE | pharmacy-reports.ts. Small fix: `pharmacyReports.branches` (:1045-1072) needs an org check in the #992 follow-up |
| Finance: gross margin, margin comparison, leakage report, perpetual valuation, cash-flow forecast | LIVE | `src/server/routers/pharmacy-finance.ts`; `app/finance` |
| Bookkeeping: post and reverse journal entries, period close and reopen, bank import and reconciliation, settlement batches, tax profile | LIVE | pharmacy-finance.ts |
| Accounts: P&L, balance sheet, cash flow, trial balance, journal lookup and evidence export, cheque maturity, fiscal exceptions, tax-profile review, account activity bridge, account-code reference | LIVE | `app/accounts/*` |
| Report date controls, print/PDF, CSV export, filters | PR #1157, #1153, #1002, #1001 | |
| Account-code report | PR #934 | |
| Owner data export and import ("no lock-in" button) | PR #949 (security PASS) | |
| Margins visible to Owner, Admin, Manager (own branch only) and Finance | PLANNED | Today it's gated by `reports:financial` only; Manager doesn't have it |
| Readable trial balance labels and journal | OPEN PR #1389 (DEV-736), #1423 (DEV-737) | Saad's 3 Nov screen reports; reconciliation noise (DEV-735) has no PR yet |


### 8. Compliance (DRAP, controlled drugs, pharmacovigilance, FBR)

| Feature | Status | Evidence |
|---|---|---|
| Controlled-drug register, witnesses, controlled pharmacists | LIVE | `app/controlled-register`; `src/server/routers/pharmacy-safety.ts`; `src/lib/pharmacy/controlled-register.ts` |
| DRAP recalls | LIVE | see Inventory |
| Pharmacovigilance reports: create, transition, record submission, DRAP export | LIVE. **Gap closed by #247 (merged 6 Nov)** | Filing needs `pharmacy:safety` or `pharmacy:dispense`; transition, submission and DRAP export need exact `pharmacy:safety`; all check the `pharmacy-reports` licence and branch assignment. A solo owner can mark their own report READY only with no other active staff, a fresh PIN and an audit row. Migrations `20261101120000` and `20261106120000` backfill the grant and MAIN assignment for existing owners. PR #987 is still open. Evidence: `pharmacy-reports.ts` (`safety` = `capabilityProcedure('pharmacy:safety')`) |
| Regulatory profile and onboarding gates | LIVE | `src/server/routers/pharmacy-onboarding.ts`; `app/regulatory` |
| FBR Tier-1 | LIVE | `app/regulatory/fbr-tier-1`; pharmacy-onboarding-fbr-tier1 tests |
| Cameras: gateway, retention, viewer grants, evidence, privacy | LIVE | `src/server/routers/pharmacy-cameras.ts`; `app/cameras`, `app/settings/cameras/privacy` |
| Live DVR camera view through the shared gateway | LIVE code **NEW** (#1415, DEV-740), **hardware untested** | Configured mode registers an exact `https://host/` gateway and cameras by stream path; DVR credentials are rejected and cameras start disabled. `issueLiveViewGrant` issues 55-second grants; the stream proxy re-authorizes every manifest and segment request. Needs the pharmacy vertical, no support session, and branch access (session ADMIN or an active assignment). Evidence: `pharmacy-cameras` configuredConnectionDiagnostics, issueLiveViewGrant; `src/app/api/pharmacy/cameras/[cameraId]/stream/route.ts`; `src/components/pharmacy/cameras/pharmacy-configured-setup.tsx`; `industry-specific-docs/pharmacy/cameras/001-configured-gateway-live-view.md` |
| Evidence stills from cameras (tender, refund, day close, cold-chain excursions) | LIVE code **NEW** (#1408, #1429, DEV-745), **hardware untested** | A small service beside MediaMTX reads one frame with ffmpeg and returns a PNG; it never touches recordings or the DVR and writes nothing to disk. It refuses to start unless the host `/proc` is mounted with `hidepid`. Evidence: `docker/camera-snapshot-gateway/*`; `src/lib/cameras/snapshot-transport.ts`, `evidence.ts`; `docs/pharmacy/camera-snapshot-evidence-DEV-745.md` |
| Hardware setup and acceptance matrix | DOCS **NEW** (#1407, DEV-744) | Test matrices for cameras, printers, scanners and card terminals. **Every device row is UNTESTED**; no compatibility is claimed. Evidence: `docs/pharmacy/hardware-acceptance-matrix.md`; `tests/pharmacy-hardware-*.test.ts` |
| Thermal receipt printing and card-terminal seam | OPEN PR #1412 (DEV-741), #1409 (DEV-742), #1410 (DEV-743) |  |
| Licence expiry by local date | PR #812 (QA PASS, needs a rebase) | |
| Emergency-supply caps by jurisdiction | OPEN PR #1160 (#1087 was closed unmerged) | |
| Postgres backup and restore drill | PR #1161 | |
| Sindh profile | PR #983 | Out of scope for now (Punjab only) |
| Audit-actor immutability | PR #864, **failed security** (migration timestamp clash) | |


### 8b. Procedures (SOPs) — NEW since `47518cbf`

Built in #1418 and #1430 (DEV-751) on the shared restaurant SOP engine. **Procedures are instructions plus proof. They never block, gate or authorize any pharmacy workflow** (pinned by `tests/pharmacy-sop-separation.test.ts`). Gated by `sop:*` capabilities plus the `pharmacy-safety` module. New tenants' role templates get Owner, Owner/Operator and Manager: manage, complete, verify; Pharmacist: complete, verify; Cashier, Procurement and Inventory: complete. Existing tenants' roles are not changed.

| Feature | Status | Evidence |
|---|---|---|
| Procedures page (`/pharmacy/sop`): board, runner, review, setup | LIVE **NEW** | `src/app/(app)/pharmacy/sop/page.tsx`; `src/components/pharmacy/sop/sop-runner.tsx`, `sop-review.tsx`, `sop-setup.tsx` |
| Library of nine pharmacy packs: opening, closing, temperature log, controlled counts, expiry pull, receiving, hygiene, incident and CAPA, training attestation | LIVE **NEW** | `src/lib/pharmacy/sop-library.ts`; `pharmacy-sop` installLibrary, templates |
| Enable a branch, assign procedures, pharmacy job roles (manager, qualified person, assistant) | LIVE **NEW** | `pharmacy-sop` enableSite, joinSite, assignments, createAssignment, setAssignmentActive, roleHoldings, setRoleHolding. The qualified-person role needs `pharmacy:dispense` |
| Do a procedure: claim, start, complete steps, add proof, submit; on-demand procedures | LIVE **NEW** | `pharmacy-sop` board, occurrence, claim, start, completeStep, startOnDemand, onDemandTemplates, submit; `src/app/api/pharmacy/sop/evidence/route.ts` |
| Link existing records as proof (limited by type, time window and temperature zone; cancelled and reversed records excluded) | LIVE **NEW** | `pharmacy-sop` linkableRecords, linkRecord, evidenceTarget; `PharmacySopRecordLink` |
| Out-of-range temperature readings must be explained with a note on opening and closing | LIVE **NEW** (#1430) | `pharmacy-sop` completeStep, linkRecord; `src/components/pharmacy/sop/sop-model.ts` |
| Independent verification: you can't check your own work or give yourself a checking role; send-back needs a rework note | LIVE **NEW** | `pharmacy-sop` verify, reject, addReworkNote; `PharmacySopReworkNote`; `tests/pharmacy-sop-role-grants.db.test.ts` |
| Durable, append-only proof receipts written by the server | LIVE **NEW** | `src/lib/pharmacy/sop-evidence.ts`, `sop-evidence-mac.ts`; `PharmacySopEvidenceCapture` |
| Automatic scheduling per branch (opt-in, off by default, no assumed times, no default escalation) | LIVE **NEW** | `pharmacy-sop` siteSettings, setAutoSchedule, generate; `src/lib/pharmacy/sop-auto-schedule-job.ts` |
| Procedures report and an SOP section in the inspection pack | LIVE **NEW** | `pharmacy-sop` report; `src/lib/pharmacy/inspection-pack.ts`; `pharmacy-safety` |


### 9. Growth and WhatsApp

| Feature | Status | Evidence |
|---|---|---|
| WhatsApp webhook (incl. STOP) | LIVE | A replay regression test for STOP acknowledgements was added (#1154, test-only; production behaviour unchanged). Evidence: `src/app/api/pharmacy/whatsapp/webhook`; `src/lib/pharmacy/whatsapp/inbound.test.ts` |
| Campaigns: templates, drafts, review, approve, preview, delivery history, sandbox, receipt attribution, AI assist | LIVE. **Owner-only today:** `owner()` requires session role `ADMIN` plus the `pharmacy-crm` module, so managers are locked out, against Saad's "manager or owner" rule. Fix: PR #996 (manager or owner; merge conflicts) | `src/server/routers/pharmacy-marketing.ts`; `app/marketing` |
| Basket analysis and growth suggestions (generate and review) | LIVE; the "UNAVAILABLE CONFIGURATION" state came from having no AI provider (DEV-591). #1238 adds the provider router; behaviour on a configured environment is not re-tested | pharmacy-marketing.ts; `src/lib/ai/growth-recommendations.ts` |
| Consent re-checked before claimed sends | OPEN PR #1192 (the STOP replay test from #1154 merged on 6 Nov) | |
| Back-in-stock WhatsApp (no drug name) | PR #782 | |
| Campaign cost preview plus a server-side drug-name block | PR #776 | |
| Bilingual order confirmation | PR #1177 | |
| Rule: campaigns never name a medicine (Drugs Act 1976 limits public drug advertising) | PLANNED in full; partly in #776 / #782 | |


### 11. Settings and onboarding

| Feature | Status | Evidence |
|---|---|---|
| Pharmacy onboarding overview and gates, first-run checklist | LIVE | pharmacy-onboarding.ts; `src/lib/vertical-catalog.ts:131` |
| Branch settings | LIVE | `app/settings/branches` |
| Grouped owner navigation, dismissible onboarding | PR #1155 | |
| Access-denial guidance | PR #1164 | |
| Vertical gating and branded 404; agency and HR pages hidden from pharmacy | PR #1005, #986 | |
| Team page showing 0 members | PR #1000 (bug fix) | |
| SehatCart as a separate app | PLANNED | CTO notes |



## 4. Restaurant

Caveats: card payments use a MOCK provider only; printing is simulated server-side, and the ESC/POS print bridge (`scripts/print-bridge.ts`, `/api/restaurant/print-bridge`) hasn't been tested on real printers; there's no FBR integration (OPEN PR #20); notifications are in-app only (email, SMS and WhatsApp are stubs); menu-import AI needs an AI provider.

### Branches & settings


| Feature | Implementation status | Detail |
|---|---|---|
| List branches | LIVE | See all restaurant branches. [src/server/routers/restaurant-branches.ts list] |
| Create a branch | LIVE | Add a new outlet. [src/server/routers/restaurant-branches.ts create] |
| Edit a branch | LIVE | Change a branch's name and details. [src/server/routers/restaurant-branches.ts update] |
| Activate / deactivate a branch | LIVE | Switch a branch on or off. [src/server/routers/restaurant-branches.ts setActive] |
| Branch settings screen | LIVE | Page for managing branches. [src/app/(app)/restaurant/settings/branches/page.tsx; src/components/restaurant/restaurant-branches-console.tsx] |
| Branch commercial terms | LIVE | Per-branch commercial rules, such as limits. [src/lib/restaurant/branch-commercial-terms.ts; src/app/api/restaurant/orders/commercial-terms/route.ts] |
| Dashboard preferences | LIVE | Choose what the restaurant dashboard shows. [src/server/routers/restaurant-dashboard.ts getPreferences/updatePreferences] |
| Restaurant home dashboard | LIVE | Landing page for the restaurant module. [src/app/(app)/restaurant/page.tsx] |
| Business date | LIVE | Works out which trading day a sale belongs to, including after midnight. [src/lib/restaurant/business-date.ts] |
| Invite role fixes | OPEN PR | Fixes to invite roles and role labels. PR #21. [PR #21] |


### Catalogue: brands & products


| Feature | Implementation status | Detail |
|---|---|---|
| Default brand | LIVE | Create the first brand automatically. [src/server/routers/restaurant-catalog.ts ensureDefaultBrand] |
| Create a brand | LIVE | Add a brand, for example a second restaurant concept. [src/server/routers/restaurant-catalog.ts createBrand] |
| Edit a brand | LIVE | Rename or change a brand. [src/server/routers/restaurant-catalog.ts updateBrand] |
| Set the default brand | LIVE | Choose the main brand. [src/server/routers/restaurant-catalog.ts setDefaultBrand] |
| Brand status | LIVE | Activate or archive a brand. [src/server/routers/restaurant-catalog.ts setBrandStatus] |
| List / view brands | LIVE | See your brands. [src/server/routers/restaurant-catalog.ts listBrands/getBrand] |
| Categories list | LIVE | See menu categories. [src/server/routers/restaurant-catalog.ts listCategories] |
| Create / edit / delete a category | LIVE | Manage categories, such as Burgers or Drinks. [src/server/routers/restaurant-catalog.ts createCategory/updateCategory/deleteCategory] |
| Products list | LIVE | See all dishes and items. [src/server/routers/restaurant-catalog.ts listProducts/getProduct] |
| Create / edit a product | LIVE | Add or change a dish. [src/server/routers/restaurant-catalog.ts createProduct/updateProduct] |
| Product status | LIVE | Activate or archive a dish. [src/server/routers/restaurant-catalog.ts setProductStatus] |
| Variants | LIVE | Sizes or versions of a dish (small, medium, large). [src/server/routers/restaurant-catalog.ts createVariant/updateVariant/deleteVariant] |
| Modifier groups | LIVE | Groups of add-ons, such as 'Choose sauce'. [src/server/routers/restaurant-catalog.ts createModifierGroup/updateModifierGroup/deleteModifierGroup] |
| Modifier options | LIVE | Individual add-ons, such as extra cheese. [src/server/routers/restaurant-catalog.ts createModifierOption/updateModifierOption/deleteModifierOption] |
| Attach / detach a modifier group | LIVE | Link add-ons to a dish. [src/server/routers/restaurant-catalog.ts attachModifierGroup/detachModifierGroup] |
| Combo groups | LIVE | Meal-deal slots, such as 'Pick a drink'. [src/server/routers/restaurant-catalog.ts createComboGroup/updateComboGroup/deleteComboGroup] |
| Combo options | LIVE | The choices inside a combo slot. [src/server/routers/restaurant-catalog.ts createComboOption/updateComboOption/deleteComboOption] |
| Allergens | LIVE | Define allergens, such as nuts or gluten. [src/server/routers/restaurant-catalog.ts createAllergen/updateAllergen/deleteAllergen] |
| Product allergens | LIVE | Mark which dishes contain which allergens. [src/server/routers/restaurant-catalog.ts attachProductAllergen/detachProductAllergen] |
| Catalogue screen | LIVE | Page for the catalogue. [src/app/(app)/restaurant/catalog/page.tsx; src/components/restaurant/catalog] |


### Catalogue: ingredients, units & recipes


| Feature | Implementation status | Detail |
|---|---|---|
| Units | LIVE | Define units such as gram, litre or piece. [src/server/routers/restaurant-catalog.ts createUnit/updateUnit/deleteUnit] |
| Unit conversions | LIVE | For example, 1 kg = 1000 g. [src/server/routers/restaurant-catalog.ts upsertConversion/deleteConversion] |
| Ingredients | LIVE | Add raw ingredients. [src/server/routers/restaurant-catalog.ts createIngredient/updateIngredient] |
| Ingredient allergens | LIVE | Mark the allergens in each ingredient. [src/server/routers/restaurant-catalog.ts attachIngredientAllergen/detachIngredientAllergen] |
| Create a recipe | LIVE | Define what goes into a dish. [src/server/routers/restaurant-catalog.ts createRecipe/listRecipes] |
| Recipe versions | LIVE | Change a recipe while keeping the history. [src/server/routers/restaurant-catalog.ts createRecipeVersion/updateRecipeVersion/listRecipeVersions/getRecipeVersion] |
| Activate a recipe version | LIVE | Choose which version is live. [src/server/routers/restaurant-catalog.ts activateRecipeVersion/getActiveRecipeVersion] |
| Recipe lines | LIVE | The ingredients and quantities in a recipe. [src/server/routers/restaurant-catalog.ts createRecipeLine/updateRecipeLine/deleteRecipeLine] |
| Ingredient substitutes | LIVE | Allowed replacements for an ingredient. [src/server/routers/restaurant-catalog.ts addRecipeLineSubstitute/removeRecipeLineSubstitute] |
| Recipe cost | LIVE | What a dish costs to make. [src/server/routers/restaurant-catalog.ts getRecipeCost/listRecipeCosts; src/lib/restaurant/recipe-costing.ts] |


### Menus, pricing & availability


| Feature | Implementation status | Detail |
|---|---|---|
| Menus list / view | LIVE | See your menus. [src/server/routers/restaurant-menus.ts listMenus/getMenu] |
| Create / edit / delete a menu | LIVE | Manage menus, such as Lunch or Dinner. [src/server/routers/restaurant-menus.ts createMenu/updateMenu/deleteMenu] |
| Menu sections | LIVE | Sections inside a menu. [src/server/routers/restaurant-menus.ts createSection/updateSection/deleteSection] |
| Menu items | LIVE | Put dishes on a menu. [src/server/routers/restaurant-menus.ts createItem/updateItem/deleteItem] |
| Price lists | LIVE | Separate price sets, for example dine-in vs delivery. [src/server/routers/restaurant-menus.ts listPriceLists/getPriceList/createPriceList] |
| Price list versions | LIVE | Schedule price changes, with history. [src/server/routers/restaurant-menus.ts createPriceListVersion/activatePriceListVersion/supersedePriceListVersion] |
| Price entries | LIVE | The price of each item in a list. [src/server/routers/restaurant-menus.ts addPriceEntry/updatePriceEntry/removePriceEntry] |
| Menu publications | LIVE | Publish a menu so it goes live. [src/server/routers/restaurant-menus.ts createPublication/publishPublication/retirePublication/listPublications/getPublication] |
| Publication channels | LIVE | Choose where a menu is shown: dine-in, takeaway or delivery. [src/server/routers/restaurant-menus.ts setPublicationChannels] |
| Availability windows | LIVE | Times when an item can be sold, such as breakfast only. [src/server/routers/restaurant-menus.ts addAvailabilityWindow/removeAvailabilityWindow/listAvailabilityWindows] |
| Availability exceptions | LIVE | One-off changes, such as closed on Eid. [src/server/routers/restaurant-menus.ts setAvailabilityException/removeAvailabilityException/listAvailabilityExceptions] |
| Item overrides (86 / out of stock) | LIVE | Turn an item off or change it for a branch. [src/server/routers/restaurant-menus.ts setItemOverride/clearItemOverride/listItemOverrides] |
| Effective menu | LIVE | What is actually sellable right now. [src/server/routers/restaurant-menus.ts effectiveMenu; src/lib/restaurant/menu-availability.ts] |
| Menus screen | LIVE | Page for menus. [src/app/(app)/restaurant/menus/page.tsx] |


### Menu import (AI)


| Feature | Implementation status | Detail |
|---|---|---|
| Upload limits | LIVE | Shows the allowed file sizes and types. [src/server/routers/restaurant-menu-import.ts uploadLimits] |
| Upload a menu | LIVE | Upload a photo or PDF of a menu. [src/server/routers/restaurant-menu-import.ts upload; src/lib/restaurant/menu-import-uploads.ts] |
| Import list / detail | LIVE | See past imports. [src/server/routers/restaurant-menu-import.ts list/get/summary] |
| Review lines | LIVE | Check each item read from the file. [src/server/routers/restaurant-menu-import.ts reviewLine] |
| Commit an import | LIVE | Add the reviewed items to the catalogue. [src/server/routers/restaurant-menu-import.ts commit] |
| Discard an import | LIVE | Throw away an import. [src/server/routers/restaurant-menu-import.ts discard] |
| AI vision reading | LIVE | Reads the menu image using the configured AI provider. It needs AI_PROVIDER and a key; without them it reports the adapter as unavailable, and nothing is guessed. [src/lib/restaurant/menu-extraction-vision.ts:16-19,157; src/lib/restaurant/menu-extraction.ts:154] |
| Menu import screen | LIVE | Page for menu import. [src/app/(app)/restaurant/menu-import/page.tsx; src/components/restaurant/menu-import/menu-import-console.tsx] |


### Floor, tables & kitchen stations


| Feature | Implementation status | Detail |
|---|---|---|
| Floors | LIVE | Define the dining floors or areas. [src/server/routers/restaurant-floor.ts listFloors/createFloor/updateFloor/deleteFloor] |
| Tables | LIVE | Add tables to a floor. [src/server/routers/restaurant-floor.ts createTable/updateTable/deleteTable] |
| Sections | LIVE | Group tables into waiter sections. [src/server/routers/restaurant-floor.ts listSections/createSection/updateSection/deleteSection/setSectionTables; src/lib/restaurant/sections.ts] |
| Assign a server | LIVE | Give a waiter a section. [src/server/routers/restaurant-floor.ts assignServer/unassignServer] |
| Kitchen stations | LIVE | Define stations such as grill, fryer or bar. [src/server/routers/restaurant-floor.ts listStations/createStation/updateStation/deleteStation] |
| Default station | LIVE | Where items go if no rule matches. [src/server/routers/restaurant-floor.ts setDefaultStation] |
| Routing rules | LIVE | Send each item to the right station or printer. [src/server/routers/restaurant-floor.ts createRoutingRule/updateRoutingRule/deleteRoutingRule; src/lib/restaurant/station-routing.ts] |
| Floor screen | LIVE | Page for the floor plan. [src/app/(app)/restaurant/floor/page.tsx; src/components/restaurant/floor/floor-console.tsx] |


### Orders (back office)


| Feature | Implementation status | Detail |
|---|---|---|
| Orders list / detail | LIVE | See orders. [src/server/routers/restaurant-orders.ts listOrders/getOrder] |
| Open an order | LIVE | Start a dine-in, takeaway or delivery order. [src/server/routers/restaurant-orders.ts open; src/lib/restaurant/order-channels.ts DINE_IN, TAKEAWAY, DELIVERY] |
| Add / adjust / remove an item | LIVE | Change what's on the order. [src/server/routers/restaurant-orders.ts addItem/adjustItem/removeItem] |
| Send to kitchen | LIVE | Send the items to the kitchen. [src/server/routers/restaurant-orders.ts send] |
| Fire / hold a course | LIVE | Release or hold back a course, such as starters then mains. [src/server/routers/restaurant-orders.ts fireCourse/holdCourse] |
| Advance an item | LIVE | Move an item along (cooking, ready). [src/server/routers/restaurant-orders.ts advanceItem] |
| Request a remake | LIVE | Ask the kitchen to redo an item. [src/server/routers/restaurant-orders.ts requestRemake] |
| Void an item | LIVE | Remove an item after it was sent. Since #684 (Codex HIGH h5) a void can name an approver, who must prove who they are with their own PIN or badge (checked on the server, with lockout) and hold `coauth:approve` at the branch; a sole owner may self-approve only with a fresh PIN. The actor comes from the session, not the request. [src/server/routers/restaurant-orders.ts voidItem; src/lib/restaurant/back-office-approval.ts] |
| Cancel an order | LIVE | Cancel the whole order. Same approver rule as voids since #684. [src/server/routers/restaurant-orders.ts cancel; src/lib/restaurant/back-office-approval.ts] |
| Close an order | LIVE | Finish the order. [src/server/routers/restaurant-orders.ts close] |
| Move a table | LIVE | Move the order to another table. [src/server/routers/restaurant-orders.ts moveTable] |
| Merge tables | LIVE | Combine orders from several tables. [src/server/routers/restaurant-orders.ts mergeTables] |
| Unlink a table | LIVE | Separate merged tables. [src/server/routers/restaurant-orders.ts unlinkTable] |
| Kitchen tickets list | LIVE | See the tickets sent to the kitchen. [src/server/routers/restaurant-orders.ts listKitchenTickets; src/lib/restaurant/kitchen-tickets.ts] |
| Order numbers | LIVE | Sequential order numbers. [src/lib/restaurant/order-numbers.ts] |
| Order state machine | LIVE | Rules for which order status changes are allowed. [src/lib/restaurant/order-state-machine.ts] |
| Orders screen | LIVE | Page for orders. [src/app/(app)/restaurant/orders/page.tsx; src/components/restaurant/orders/orders-console.tsx] |


### POS terminal


| Feature | Implementation status | Detail |
|---|---|---|
| POS screen | LIVE | The till screen staff use to take orders. [src/app/(terminal)/pos/page.tsx] |
| Establish a terminal | LIVE | Set up a device as a till. [src/app/api/restaurant/terminal/establish/route.ts; src/lib/restaurant/terminal-session.ts] |
| Operator sign-in / switch | LIVE | Staff sign in or switch user at the till. [src/app/api/restaurant/terminal/operators, src/app/api/restaurant/terminal/switch; src/components/restaurant/pos/operator-switch.tsx] |
| Lock / unlock the till | LIVE | Lock the screen when stepping away. [src/app/api/restaurant/terminal/lock, src/app/api/restaurant/terminal/unlock] |
| Manager co-authorisation | LIVE | A manager approves a sensitive action, such as a void or comp, on the till. [src/app/api/restaurant/terminal/co-authorize/route.ts; src/lib/restaurant/co-authorization.ts] |
| Terminal heartbeat | LIVE | Keeps the till's connection status up to date. [src/app/api/restaurant/terminal/heartbeat/route.ts] |
| Terminal layout | LIVE | Till screen layout. [src/app/api/restaurant/terminal/layout/route.ts] |
| Menu grid | LIVE | Tap dishes to add them. [src/components/restaurant/pos/menu-grid.tsx; src/app/api/restaurant/orders/effective-menu] |
| Order pad | LIVE | The current order on screen. [src/components/restaurant/pos/order-pad.tsx, order-ticket-panel.tsx] |
| Open / add item at POS | LIVE | Start an order and add dishes. [src/app/api/restaurant/orders/open, src/app/api/restaurant/orders/add-item] |
| Hold an order | LIVE | Park an order. [src/app/api/restaurant/orders/hold/route.ts] |
| Fire to kitchen | LIVE | Send the order to the kitchen. [src/app/api/restaurant/orders/fire/route.ts] |
| Reprint KOT | LIVE | Print the kitchen ticket again. [src/app/api/restaurant/orders/reprint-kot/route.ts] |
| Mark served | LIVE | Mark the food as served. [src/app/api/restaurant/orders/mark-served/route.ts] |
| Void / cancel / remake at POS | LIVE | Till actions for problems. [src/app/api/restaurant/orders/void, src/app/api/restaurant/orders/cancel, src/app/api/restaurant/orders/remake] |
| Move / merge tables at POS | LIVE | Table changes from the till. [src/app/api/restaurant/orders/move-table, src/app/api/restaurant/orders/merge-tables] |
| Open orders list | LIVE | See the open tickets. [src/app/api/restaurant/orders/open-orders/route.ts] |
| Customer search / attach | LIVE | Find a customer and attach them to the order. [src/app/api/restaurant/orders/customer/search, src/app/api/restaurant/orders/customer/attach; src/lib/restaurant/terminal-customers.ts] |
| Customer lookup by wallet pass | LIVE | Find a customer by their wallet pass. [src/app/api/restaurant/orders/customer/by-wallet/route.ts] |
| Delivery address & zone at POS | LIVE | Choose the delivery address and zone. [src/app/api/restaurant/orders/delivery/addresses, zones, attach] |
| Offline queue | LIVE | Keeps taking orders when the internet drops, then syncs. [src/lib/restaurant/pos-offline-runtime.ts, pos-command-queue.ts; src/components/restaurant/pos/offline-queue-status.tsx] |
| Order pricing | LIVE | Works out the totals, including modifiers. [src/lib/restaurant/order-pricing.ts, draft-check-total.ts] |
| Comp/void/settlement fixes | OPEN PR | Severity-1 and severity-2 fixes. PR #28. [PR #28] |
| POS UI refresh | OPEN PR | A WIP refresh of the counter and POS screens. PR #17. [PR #17] |


### Checkout, payments & refunds


| Feature | Implementation status | Detail |
|---|---|---|
| Bill | LIVE | Builds the bill for the table. [src/app/api/restaurant/checkout/bill/route.ts; src/lib/restaurant/bills.ts] |
| Split bill: by item | LIVE | Each person pays for their own items. [src/components/restaurant/pos/split-bill-dialog.tsx:114] |
| Split bill: by seat | LIVE | Split by seat. [src/components/restaurant/pos/split-bill-dialog.tsx:115] |
| Split bill: fractional | LIVE | Split evenly or into fractions. [src/components/restaurant/pos/split-bill-dialog.tsx:116] |
| Checkout summary | LIVE | Totals before payment. [src/app/api/restaurant/checkout/summary/route.ts] |
| Cash tender | LIVE | Take cash. [src/app/api/restaurant/checkout/tender/route.ts; src/lib/restaurant/tenders.ts; src/components/restaurant/pos/tender-pad.tsx] |
| Card tender | LIVE | Mock only: the payment adapter has a single MOCK provider and no real card processor (D23 not built). [src/lib/restaurant/payment-adapter.ts:11-17,48] |
| Comp (free item) | LIVE | Give an item free, with authorisation. [src/app/api/restaurant/checkout/comp/route.ts] |
| Loyalty at checkout | LIVE | Earn or redeem points while paying. [src/app/api/restaurant/checkout/loyalty/route.ts; src/lib/restaurant/terminal-loyalty.ts] |
| Refund | LIVE | Give money back. A card refund is mock only. [src/app/api/restaurant/checkout/refund/route.ts; src/lib/restaurant/refunds.ts; src/components/restaurant/pos/refund-panel.tsx] |
| Receipt | LIVE | Shows the receipt. [src/app/api/restaurant/checkout/receipt/route.ts; src/components/restaurant/pos/receipt-view.tsx] |
| Receipt numbers | LIVE | Sequential receipt numbers. These carry no fiscal meaning. [src/lib/restaurant/receipt-numbers.ts:26] |
| Receipt layout | LIVE | Choose what the receipt shows. [src/app/api/restaurant/receipt-layout/route.ts] |
| Browser receipt printing | LIVE | Print the receipt from the browser. [src/components/restaurant/pos/receipt-browser-print.ts, receipt-print-controls.tsx] |
| Terminal payment config | LIVE | Payment settings for each till. [src/server/routers/restaurant-payments.ts getTerminalConfig/saveTerminalConfig] |
| Payment records | LIVE | See tenders, refunds and payments. [src/server/routers/restaurant-payments.ts listTenders/listRefunds/getPayment] |
| Tender type totals | LIVE | Totals by payment method. [src/server/routers/restaurant-payments.ts getTenderTypeTotals] |
| Terminal reconciliation | LIVE | Match the till's payments. [src/server/routers/restaurant-payments.ts listTerminalReconciliations] |
| Bills list / settlement | LIVE | Back-office view of bills. [src/server/routers/restaurant-bills.ts listBills/getBill/getOrderSettlement] |
| FBR POS integration | OPEN PR | Connect sales to FBR. PR #20. Main only has FBR tax-rate profiles. [src/lib/restaurant/pakistan-tax-profiles.ts:115; PR #20] |


### Cash drawer & day close


| Feature | Implementation status | Detail |
|---|---|---|
| Open drawer session | LIVE | Start a shift with a float. This is a cash session, not a hardware drawer kick. [src/app/api/restaurant/cash/drawer/open/route.ts; src/lib/restaurant/drawer-sessions.ts] |
| Drawer movement | LIVE | Cash in or out. [src/app/api/restaurant/cash/drawer/movement/route.ts] |
| Current drawer | LIVE | The drawer's current status. [src/app/api/restaurant/cash/drawer/current/route.ts] |
| Close drawer | LIVE | Count the cash and close. [src/app/api/restaurant/cash/drawer/close/route.ts; src/components/restaurant/pos/drawer-panel.tsx] |
| Day close preview | LIVE | See the day's totals before closing. [src/app/api/restaurant/cash/day/preview/route.ts] |
| Close the day | LIVE | End-of-day close. [src/app/api/restaurant/cash/day/close/route.ts; src/lib/restaurant/daily-close.ts; src/components/restaurant/pos/day-close-panel.tsx] |
| Correct a day close | LIVE | Fix a closed day. [src/app/api/restaurant/cash/day/correct/route.ts] |
| Close readiness | LIVE | Checklist of what's blocking the close. [src/lib/restaurant/close-readiness.ts; src/components/restaurant/insights/close-readiness-panel.tsx] |
| Drawer / close history | LIVE | Past sessions and closes. [src/server/routers/restaurant-cash.ts listDrawerSessions/getDrawerSession/listDailyCloses/getDailyClose] |
| Money screen | LIVE | Page for money. [src/app/(app)/restaurant/money/page.tsx; src/components/restaurant/money/money-console.tsx] |


### Kitchen display (KDS)


| Feature | Implementation status | Detail |
|---|---|---|
| KDS screen | LIVE | Kitchen screen showing tickets. Updates by polling (no live push channel). [src/app/(terminal)/kds; src/components/restaurant/kds/kds-board.tsx; src/lib/restaurant/kds.ts:28-32] |
| KDS queue | LIVE | The tickets waiting. [src/app/api/restaurant/kds/queue/route.ts] |
| Acknowledge a ticket | LIVE | The kitchen accepts a ticket. [src/app/api/restaurant/kds/ack/route.ts] |
| Bump | LIVE | Mark a ticket as done. [src/app/api/restaurant/kds/bump/route.ts] |
| Recall | LIVE | Bring a bumped ticket back. [src/app/api/restaurant/kds/recall/route.ts] |
| KDS operators | LIVE | Who is working the kitchen screen. [src/app/api/restaurant/kds/operators/route.ts] |
| Delivery board | LIVE | Board for delivery orders. [src/components/restaurant/kds/delivery-board.tsx; src/app/api/restaurant/kds/delivery/queue, transition] |


### Printing & devices


| Feature | Implementation status | Detail |
|---|---|---|
| Device list | LIVE | Registered tills and devices. [src/server/routers/restaurant-devices.ts list] |
| Enrol a device | LIVE | Add a device. Needs an approver. [src/server/routers/restaurant-devices.ts initiateEnrollment/listApprovers; src/app/api/restaurant/devices/browser-enroll/route.ts] |
| Revoke / rotate a device | LIVE | Block a device or refresh its keys. [src/server/routers/restaurant-devices.ts revoke/rotate] |
| Enrol a print bridge | LIVE | Connect the shop's local print bridge. [src/server/routers/restaurant-devices.ts initiatePrintBridgeEnrollment; src/components/restaurant/print-bridge-enrollment.tsx; src/app/api/restaurant/print-bridge/enroll] |
| Local print bridge (ESC/POS) | LIVE | A program run on the shop PC (Windows script included) that sends ESC/POS jobs to a network, USB or serial, or installed-queue printer. Not tested on real hardware, and no cash-drawer kick. [scripts/print-bridge.ts, print-bridge-windows.ps1; src/lib/restaurant/printing/target.ts:4-6, printing/esc-pos.ts] |
| Server-side print simulation | LIVE | Without a bridge, the server only simulates printing (jobs are stored in the DB). [src/lib/restaurant/printing/runtime.ts:10; src/lib/restaurant/printing/stub.ts] |
| Register printers | LIVE | Add printers. [src/server/routers/restaurant-devices.ts registerPrinters/listPrinters; src/components/restaurant/printer-inventory-panel.tsx] |
| Rename / retire a printer | LIVE | Manage printers. [src/server/routers/restaurant-devices.ts renamePrinter/retirePrinter] |
| Print routing | LIVE | Choose which printer prints what. [src/lib/restaurant/printing/registered-routing.ts; src/components/restaurant/print-routing-section.tsx] |
| Print job reconciliation | LIVE | Unclear jobs need an operator to check them. No automatic reprint. [src/lib/restaurant/printing/service.ts:316-318] |
| Devices screen | LIVE | Page for devices. [src/app/(app)/restaurant/devices/page.tsx; src/components/restaurant/restaurant-devices-console.tsx] |


### Tax & service charge


| Feature | Implementation status | Detail |
|---|---|---|
| Tax configuration | LIVE | See the current tax setup. [src/server/routers/restaurant-tax.ts configuration] |
| Publish a custom tax | LIVE | Set your own tax rule. [src/server/routers/restaurant-tax.ts previewCustom/publishCustom] |
| Schedule a tax end / activate | LIVE | Start or stop a tax on a date. [src/server/routers/restaurant-tax.ts scheduleEnd/activate] |
| Publish a service charge | LIVE | Add a service charge. [src/server/routers/restaurant-tax.ts publishServiceCharge; src/lib/restaurant/service-charge-policy.ts] |
| End a service charge | LIVE | Stop the service charge. [src/server/routers/restaurant-tax.ts endServiceCharge] |
| Pakistan tax profiles | LIVE | Built-in FBR and provincial tax-rate presets (rates only, no FBR reporting). [src/lib/restaurant/pakistan-tax-profiles.ts] |
| Tax screen | LIVE | Page for tax. [src/app/(app)/restaurant/tax/page.tsx; src/components/restaurant/restaurant-tax-console.tsx] |


### Customers & delivery


| Feature | Implementation status | Detail |
|---|---|---|
| Customer list / detail | LIVE | See your customers. [src/server/routers/restaurant-customers.ts list/detail] |
| Create / correct a customer | LIVE | Add or fix a record. [src/server/routers/restaurant-customers.ts create/correct] |
| Attach to an order | LIVE | Link a customer to an order. [src/server/routers/restaurant-customers.ts attachToOrder] |
| Interaction log | LIVE | Notes and contact history. [src/server/routers/restaurant-customers.ts appendInteraction] |
| Consent | LIVE | Record marketing permission. [src/server/routers/restaurant-customers.ts appendConsent] |
| Tags | LIVE | Label customers, such as VIP. [src/server/routers/restaurant-customers.ts createTag/listTags/assignTag/unassignTag] |
| Export a customer | LIVE | Download their data on request. [src/server/routers/restaurant-customers.ts export] |
| Anonymise a customer | LIVE | Erase personal data on request. [src/server/routers/restaurant-customers.ts anonymize; src/lib/restaurant/customer-privacy.ts] |
| Delivery zones | LIVE | Define delivery areas. [src/server/routers/restaurant-delivery.ts listZones/createZone/updateZone/deactivateZone] |
| Delivery addresses | LIVE | Customer addresses. [src/server/routers/restaurant-delivery.ts listAddresses/createAddress/updateAddress/deleteAddress] |
| Default address | LIVE | Choose the main address. [src/server/routers/restaurant-delivery.ts setDefaultAddress] |
| Delivery customers | LIVE | Customers who get deliveries. [src/server/routers/restaurant-delivery.ts listCustomers] |
| Delivery dispatch | LIVE | Send out delivery orders. [src/lib/restaurant/terminal-delivery-dispatch.ts] |
| Delivery screen | LIVE | Page for delivery. [src/app/(app)/restaurant/delivery/page.tsx; src/components/restaurant/delivery/delivery-console.tsx] |
| Aggregator integration (Foodpanda etc.) | PLANNED | No code found. There is a generic webhook inbox only. [src/app/api/restaurant/webhooks/[source]; none found for aggregators] |


### Catering & events


| Feature | Implementation status | Detail |
|---|---|---|
| Booking locations | LIVE | Venues for events. [src/server/routers/restaurant-catering.ts bookingLocations] |
| Create / edit a booking | LIVE | Make a catering order. [src/server/routers/restaurant-catering.ts create/update/get/list] |
| Booking lines | LIVE | Items on the booking. [src/server/routers/restaurant-catering.ts addLine/updateLine/removeLine] |
| Extra costs | LIVE | For example, transport or staff. [src/server/routers/restaurant-catering.ts addExtraCost/removeExtraCost] |
| Delivery details | LIVE | Where and when to deliver. [src/server/routers/restaurant-catering.ts setDelivery] |
| Production requirements | LIVE | What the kitchen must make. [src/server/routers/restaurant-catering.ts productionRequirements] |
| Cost summary | LIVE | What the event costs you. [src/server/routers/restaurant-catering.ts costSummary] |
| Booking slot | LIVE | Reserve a date and time. [src/server/routers/restaurant-catering.ts setBooking/bookingAvailability] |
| Branch capacity | LIVE | How many events a branch can take. [src/server/routers/restaurant-catering.ts setBranchCapacity] |
| Quotes | LIVE | Publish and approve quotes. [src/server/routers/restaurant-catering.ts publishQuote/approveQuote/quoteHistory] |
| Payment summary | LIVE | Deposits and balance. [src/server/routers/restaurant-catering.ts paymentSummary] |
| Approval / consumption history | LIVE | Audit trail. [src/server/routers/restaurant-catering.ts approvalHistory/consumptionHistory] |
| Disposition | LIVE | Record leftovers and waste. [src/server/routers/restaurant-catering.ts recordDisposition] |
| Status changes | LIVE | Move a booking through its steps. [src/server/routers/restaurant-catering.ts transition] |
| Catering money (deposits) | LIVE | Take deposits and payments for events. [src/app/api/restaurant/catering/money/route.ts; src/lib/restaurant/catering-money.ts] |
| Catering screen | LIVE | Page for catering. [src/app/(app)/restaurant/catering/page.tsx; src/components/restaurant/catering/catering-console.tsx] |


### Inventory


| Feature | Implementation status | Detail |
|---|---|---|
| Stock items | LIVE | Items you track. [src/server/routers/restaurant-inventory.ts createStockItem] |
| Stock locations | LIVE | Stores, freezers and so on. [src/server/routers/restaurant-inventory.ts createStockLocation/setStockLocationActive] |
| Stock on hand | LIVE | What you have. [src/server/routers/restaurant-inventory.ts listStockOnHand] |
| Batches | LIVE | Stock batches. [src/server/routers/restaurant-inventory.ts listStockBatches] |
| Stock movements | LIVE | History of movements. [src/server/routers/restaurant-inventory.ts listStockMovements; src/lib/restaurant/inventory-ledger.ts] |
| Stock count | LIVE | Count stock and post the result. [src/server/routers/restaurant-inventory.ts createStockCount/addStockCountLine/submitStockCount/postStockCount/listStockCounts] |
| Transfers | LIVE | Move stock between locations. [src/server/routers/restaurant-inventory.ts createStockTransfer/addStockTransferLine/completeStockTransfer/listStockTransfers] |
| Wastage | LIVE | Record waste. [src/server/routers/restaurant-inventory.ts postWastage] |
| Sale reversal | LIVE | Put stock back when a sale is reversed. [src/server/routers/restaurant-inventory.ts postSaleReversal] |
| Low-stock rules | LIVE | Alert when stock falls below a level. [src/server/routers/restaurant-inventory.ts createLowStockRule/updateLowStockRule/deleteLowStockRule/evaluateLowStockRules] |
| Weighted average cost | LIVE | Stock cost price. [src/server/routers/restaurant-inventory.ts weightedAverageCost] |
| Recipe-based deduction | LIVE | Sales use up ingredients according to the recipe (to confirm automatic posting). [src/lib/restaurant/inventory.ts; src/lib/restaurant/recipes.ts] |
| Inventory screen | LIVE | Page for inventory. [src/app/(app)/restaurant/inventory/page.tsx] |


### Purchasing


| Feature | Implementation status | Detail |
|---|---|---|
| Suppliers | LIVE | Add and manage suppliers. [src/server/routers/restaurant-purchasing.ts listSuppliers/getSupplier/createSupplier/updateSupplier/setSupplierActive] |
| Purchase orders | LIVE | Create purchase orders. [src/server/routers/restaurant-purchasing.ts listPurchaseOrders/getPurchaseOrder/createPurchaseOrder] |
| PO lines | LIVE | Items on the PO. [src/server/routers/restaurant-purchasing.ts addPurchaseOrderLine/updatePurchaseOrderLine/removePurchaseOrderLine] |
| Submit / approve a PO | LIVE | Approval flow. [src/server/routers/restaurant-purchasing.ts submitPurchaseOrder/approvePurchaseOrder] |
| Cancel / close a PO | LIVE | Finish or cancel a PO. [src/server/routers/restaurant-purchasing.ts cancelPurchaseOrder/closePurchaseOrder] |
| Receive a PO | LIVE | Goods in. [src/server/routers/restaurant-purchasing.ts receivePurchaseOrder/getReceipt] |
| Supplier return | LIVE | Send goods back. [src/server/routers/restaurant-purchasing.ts createSupplierReturn] |
| Purchasing screen | LIVE | Page for purchasing. [src/app/(app)/restaurant/purchasing/page.tsx] |


### Staff, roles & access


| Feature | Implementation status | Detail |
|---|---|---|
| My staff profile | LIVE | See or create your own profile. [src/server/routers/restaurant-staff.ts mySelfProfile/provisionMyProfile] |
| Staff directory | LIVE | List of staff. [src/server/routers/restaurant-staff.ts list/listDirectory/listEligibleUsers/listBranches] |
| Add / edit staff | LIVE | Manage staff. [src/server/routers/restaurant-staff.ts create/update/setStatus] |
| POS credentials (PIN) | LIVE | Issue, rotate or revoke till PINs. [src/server/routers/restaurant-staff.ts listCredentials/issueCredential/rotateCredential/revokeCredential; src/lib/restaurant/operator-credentials.ts] |
| Job roles | LIVE | Waiter, cashier, chef and so on. [src/server/routers/restaurant-staff.ts listJobRoles/seedDefaultJobRoles/createJobRole/updateJobRole] |
| Job role capabilities | LIVE | What each job role can do. [src/server/routers/restaurant-staff.ts setJobRoleCapabilities] |
| Assign job roles | LIVE | Give staff their roles. [src/server/routers/restaurant-staff.ts listStaffJobRoles/setStaffJobRoles] |
| Branch access | LIVE | Which branches a person can use. [src/server/routers/restaurant-staff.ts setStaffAccess; src/lib/restaurant/staff-branch-authorization.ts] |
| Personal overrides | LIVE | Give or remove one permission for one person. [src/server/routers/restaurant-staff.ts setStaffCapabilityOverride/clearStaffCapabilityOverride/listStaffCapabilityOverrides] |
| Effective permissions | LIVE | What someone can actually do. [src/server/routers/restaurant-staff.ts resolveStaffCapabilities/listRoleHolders] |
| Access audit | LIVE | History of permission changes. [src/server/routers/restaurant-staff.ts listStaffJobRoleAudit/listStaffCapabilityAudit] |
| Staff screen | LIVE | Page for staff. [src/app/(app)/restaurant/staff/page.tsx; src/components/restaurant/restaurant-staff-console.tsx] |


### Shifts & attendance


| Feature | Implementation status | Detail |
|---|---|---|
| Shifts | LIVE | Plan shifts. [src/server/routers/restaurant-shifts.ts list/create/update/cancel] |
| My roster | LIVE | A staff member's own shifts. [src/server/routers/restaurant-shifts.ts myRoster] |
| Manager roster | LIVE | The full roster. [src/server/routers/restaurant-shifts.ts managerRoster] |
| Clock in / out | LIVE | Record attendance. [src/server/routers/restaurant-shifts.ts clockIn/clockOut] |
| Breaks | LIVE | Start and end breaks. [src/server/routers/restaurant-shifts.ts startBreak/endBreak] |
| Shift swaps | LIVE | Ask for and approve swaps. [src/server/routers/restaurant-shifts.ts swapCandidates/requestSwap/reviewSwap] |
| Time correction | LIVE | Fix a wrong clock entry. [src/server/routers/restaurant-shifts.ts correctTime] |
| Attendance export | LIVE | Download attendance as CSV. [src/server/routers/restaurant-shifts.ts exportAttendanceCsv] |
| Roster screen | LIVE | Page for the roster. [src/app/(app)/restaurant/staff/roster/page.tsx; src/components/restaurant/restaurant-roster-console.tsx] |


### SOPs & checklists


| Feature | Implementation status | Detail |
|---|---|---|
| SOP templates | LIVE | Create checklists, such as an opening checklist. [src/server/routers/restaurant-sop.ts createTemplate/updateTemplate/setTemplateActive/listTemplates/getTemplate] |
| Versions | LIVE | Draft, publish and retire versions. [src/server/routers/restaurant-sop.ts createDraftVersion/publishVersion/retireVersion/listVersions/getVersion] |
| Steps | LIVE | Steps in a checklist. [src/server/routers/restaurant-sop.ts addStep/updateStep/removeStep/reorderSteps] |
| Assignments | LIVE | Who does it and when. [src/server/routers/restaurant-sop.ts createAssignment/updateAssignment/setAssignmentActive/listAssignments/getAssignment/listAssignableJobRoles] |
| Schedule preview | LIVE | See upcoming due dates. [src/server/routers/restaurant-sop.ts previewSchedule/previewAssignmentSchedule; src/lib/restaurant/sop-recurrence.ts] |
| Template packs | LIVE | Install ready-made checklists. [src/server/routers/restaurant-sop.ts listPacks/installPack/installAllPacks] |
| Claim a task | LIVE | Pick up an open task. [src/server/routers/restaurant-sop.ts listClaimablePool/listMySopOccurrences/claimOccurrence] |
| Escalation policies | LIVE | Who gets alerted when a task is late. [src/server/routers/restaurant-sop.ts listEscalationPolicies/getEscalationPolicy/createEscalationPolicy/updateEscalationPolicy/setEscalationPolicyActive/upsertEscalationStep/removeEscalationStep] |
| SOP score | LIVE | Compliance score. [src/server/routers/restaurant-sop.ts scoreReport; src/lib/restaurant/sop-score.ts] |
| Audit trail | LIVE | History of a task. [src/server/routers/restaurant-sop.ts listRecentOccurrences/occurrenceAuditTrail] |
| Do a task | LIVE | Start a task and complete its steps. [src/server/routers/restaurant-sop-execution.ts listOccurrences/getOccurrence/start/completeStep] |
| Attach evidence | LIVE | Add a photo as proof. [src/server/routers/restaurant-sop-execution.ts attachEvidence; src/app/api/restaurant/sop/evidence/route.ts] |
| Submit | LIVE | Finish the task. [src/server/routers/restaurant-sop-execution.ts submit] |
| Verify / reject | LIVE | A manager checks the work. Since #684 the acting staff member comes from the session (no actor spoofing in commands or proof uploads), and approvers need server-verified PIN or badge credentials. [src/server/routers/restaurant-sop-execution.ts verify/reject; src/lib/restaurant/sop-actor.ts, session-staff.ts] |
| Waive / acknowledge | LIVE | Skip a task, or acknowledge a missed one. [src/server/routers/restaurant-sop-execution.ts waive/acknowledge] |
| SOP report | LIVE | Compliance report by branch. [src/server/routers/restaurant-sop-execution.ts reportBranches/report] |
| Escalation messaging | LIVE | Only IN_APP notifications are delivered. Email, SMS, push and WhatsApp are stubs. [src/lib/restaurant/sop-escalation.ts:21] |
| SOP screens | LIVE | The SOP, admin, oversight and reports pages. [src/app/(app)/restaurant/sop, sop/admin, sop/oversight, sop/reports] |


### Notifications & integrations


| Feature | Implementation status | Detail |
|---|---|---|
| Notification inbox | LIVE | In-app notifications. [src/server/routers/restaurant-notifications.ts list/unreadCount/markRead/markAllRead] |
| Notification matrix | LIVE | Choose who gets which alerts. [src/server/routers/restaurant-notifications.ts getMatrix/updateMatrix] |
| Outbound webhook | LIVE | Send events to your own system. [src/server/routers/restaurant-notifications.ts webhookStatus/configureWebhook/testWebhook/retryWebhook; src/lib/restaurant/notification-webhook.ts] |
| Background jobs view | LIVE | See scheduled jobs and runs. [src/server/routers/restaurant-jobs.ts listJobs/listExecutions] |
| Dead-letter queue | LIVE | Failed jobs, with requeue. [src/server/routers/restaurant-jobs.ts listDeadLetters/requeueDeadJob] |
| Outbox / webhook inbox | LIVE | Messages going out and webhooks coming in. [src/server/routers/restaurant-jobs.ts listOutbox/listWebhookInbox; src/app/api/restaurant/webhooks/[source]] |
| Notifications screen | LIVE | Page for notifications. [src/app/(app)/restaurant/notifications/page.tsx] |


### Cameras


| Feature | Implementation status | Detail |
|---|---|---|
| Availability & presets | LIVE | Supported camera brands and presets. [src/server/routers/restaurant-cameras.ts availability/presets; src/lib/restaurant/camera-presets.ts] |
| Cameras list / register | LIVE | Add cameras. [src/server/routers/restaurant-cameras.ts list/register] |
| Gateways | LIVE | Enrol, rotate or revoke the shop's camera box. [src/server/routers/restaurant-cameras.ts listGateways/enrollGateway/rotateGatewaySecret/revokeGateway] |
| Retention | LIVE | How long footage is kept. [src/server/routers/restaurant-cameras.ts getRetentionState/setRetention] |
| Recordings | LIVE | See recordings. [src/server/routers/restaurant-cameras.ts listRecordings] |
| Live stream access | LIVE | Grant time-limited viewing. [src/server/routers/restaurant-cameras.ts issueStreamGrant; src/app/api/restaurant/cameras/[cameraId]/stream] |
| Connection test / diagnostics | LIVE | Check a camera works. [src/server/routers/restaurant-cameras.ts testConnection/configuredConnectionDiagnostics] |
| Simulated gateway | LIVE | A simulated gateway exists for demos. Real hardware use is to confirm. [src/lib/restaurant/camera-gateway.simulated.ts] |
| Camera screens | LIVE | Camera integration and privacy pages. [src/app/(app)/restaurant/integrations/cameras, settings/cameras/privacy; src/components/restaurant/restaurant-camera-wizard.tsx] |


### Loyalty & wallet


| Feature | Implementation status | Detail |
|---|---|---|
| Loyalty programmes | LIVE | See and configure programmes. [src/server/routers/restaurant-loyalty.ts listPrograms/getProgram/configure] |
| Loyalty accounts | LIVE | Member accounts. [src/server/routers/restaurant-loyalty.ts listAccounts/getAccount/enrollAccount] |
| Points ledger | LIVE | Point history. [src/server/routers/restaurant-loyalty.ts listLedger/getLedgerEntry] |
| Adjust points | LIVE | Correct points by hand. [src/server/routers/restaurant-loyalty.ts adjust] |
| Redeem points | LIVE | Use points. [src/server/routers/restaurant-loyalty.ts redeem] |
| Points expiry | LIVE | Points expire after a set time. [src/lib/restaurant/loyalty-expiry.ts] |
| Loyalty screen | LIVE | Page for loyalty. [src/app/(app)/restaurant/loyalty/page.tsx; src/components/restaurant/loyalty/loyalty-console.tsx] |
| Apple Wallet pass | LIVE | A loyalty card in Apple Wallet. Needs Apple certificates configured; live use is to confirm. [src/lib/restaurant/wallet/apple-pass.ts, apple-config.ts; src/app/api/wallet/apple/v1] |
| Google Wallet pass | LIVE | A loyalty card in Google Wallet. Needs issuer settings configured; live use is to confirm. [src/lib/restaurant/wallet/google.ts:12-20, google-config.ts] |
| Wallet enrolment page | LIVE | The customer joins by scanning a link. [src/lib/restaurant/wallet/enrollment.ts; src/app/(public)/wallet/join/[token]] |
| Wallet balance updates | LIVE | The pass updates when points change. [src/lib/restaurant/wallet/balance-updates.ts, apple-apns.ts] |
| Customer wallet balance (stored value) | PLANNED | No stored-value wallet code found for restaurant; PR #64 is pharmacy-only. [none found] |


### Promotions


| Feature | Implementation status | Detail |
|---|---|---|
| Promotions list | LIVE | See offers. [src/server/routers/restaurant-promotions.ts list/pickerOptions] |
| Create an offer | LIVE | Make a new deal. [src/server/routers/restaurant-promotions.ts createOffer] |
| Edit / disable an offer | LIVE | Change or stop a deal. [src/server/routers/restaurant-promotions.ts editOffer/disableOffer] |
| Percent / amount off | LIVE | Standard discounts. [src/lib/restaurant/promotion-contracts.ts:34-37] |
| Fixed price & bundle price | LIVE | For example, Rs 999 for a deal. [src/lib/restaurant/promotion-contracts.ts:37,41] |
| Buy X get Y | LIVE | Buy X and get Y free, or at a percentage or amount off. [src/lib/restaurant/promotion-contracts.ts:38-40] |
| Item / category / order targets | LIVE | What the offer applies to. [src/lib/restaurant/promotion-contracts.ts:32] |
| Stacking rules | LIVE | Whether offers can combine. [src/lib/restaurant/promotion-contracts.ts:45] |
| Day and time schedules (happy hour) | LIVE | Offers by day of the week and time window, including overnight windows. [src/lib/restaurant/promotion-schedule.ts:1-15] |
| Caps & budgets | LIVE | Limit uses overall, per customer, or by budget. [src/lib/restaurant/promotion-caps.ts; promotion-contracts.ts:49] |
| Offline policy | LIVE | Whether an offer works when the till is offline. [src/lib/restaurant/promotion-contracts.ts:47] |
| Promotions screen | LIVE | Page for promotions. [src/app/(app)/restaurant/promotions/page.tsx; src/components/restaurant/promotions/promotions-console.tsx] |


### Reports & insights


| Feature | Implementation status | Detail |
|---|---|---|
| Close packet | LIVE | End-of-day pack for the owner. [src/server/routers/restaurant-insights.ts prepareClosePacket] |
| Operational reports | LIVE | View and export operational reports. [src/server/routers/restaurant-insights.ts listOperationalReports/readOperationalReport/exportOperationalReports] |
| Financial reports | LIVE | View and export financial reports. [src/server/routers/restaurant-insights.ts listFinancialReports/readFinancialReport/exportFinancialReports; src/lib/restaurant/financial-comparison.ts] |
| Labour cost | LIVE | Import and view labour costs. [src/server/routers/restaurant-insights.ts importLabourCost/listLabourCosts/readLabourCost/exportLabourCosts] |
| Backfill | LIVE | Rebuild the report data. [src/server/routers/restaurant-insights.ts backfill; src/lib/restaurant/insight-rollups.ts] |
| Report branches | LIVE | Choose a branch. [src/server/routers/restaurant-reports.ts branches] |
| CSV export | LIVE | Download a report. [src/server/routers/restaurant-reports.ts exportCsv; src/app/api/restaurant/reports/export/route.ts] |
| Contribution scenarios | LIVE | What-if profit scenarios. [src/lib/restaurant/contribution-scenario.ts; src/components/restaurant/insights/contribution-scenarios.tsx] |
| Insights & reports screens | LIVE | Pages for insights and reports. [src/app/(app)/restaurant/insights/page.tsx, reports/page.tsx] |


### AI growth features


| Feature | Implementation status | Detail |
|---|---|---|
| AI growth recommendations: loyalty review | LIVE | AI suggests loyalty actions, backed by the count of eligible members. [src/server/routers/restaurant-growth.ts generate/review; src/lib/restaurant/growth-binding.ts:25-28] |
| AI growth recommendations: catering review | LIVE | AI suggests catering actions. [src/lib/restaurant/growth-binding.ts:27; growth-review.ts:154] |
| AI growth recommendations: inventory cost review | LIVE | AI suggests recipe and cost actions. [src/lib/restaurant/growth-binding.ts:28] |
| AI growth recommendations: retail review | PLANNED | Rejected for restaurant: this action is pharmacy-only. [src/lib/restaurant/growth-binding.ts:21,33] |
| Growth list / read / review | LIVE | See and approve or reject AI suggestions. [src/server/routers/restaurant-growth.ts list/read/review; src/components/restaurant/growth/growth-review-panel.tsx] |
| Growth sandbox | LIVE | A test run with customer consent checks before anything goes live. [src/lib/restaurant/growth-sandbox.ts] |
| Growth screen | LIVE | Page for growth. [src/app/(app)/restaurant/growth/page.tsx] |
| AI provider switch | LIVE | Shared with pharmacy: `AI_PROVIDER` unset or `disabled` switches AI off; `auto` routes Anthropic → OpenAI → Bedrock (#1238); `azure`, `groq`, `google` and `vertex` remain as legacy, explicit-only selectors. Saad ordered Azure removed from all code on 10 Nov 2026; planned for the next Codex batch (DEV-755 / #1437). [src/lib/ai/provider.ts (see the pharmacy list)] |
| WhatsApp messaging for restaurant | PLANNED | No restaurant WhatsApp sender. The SOP escalation WhatsApp path is a stub. [src/lib/restaurant/sop-escalation.ts:21] |
| Campaign engine & POS codes (G5) | OPEN PR | PR #7. [PR #7] |
| Weekly AI campaign planner / voucher targeting (G6) | OPEN PR | PR #8. [PR #8] |
| Churn win-back (G7) | OPEN PR | PR #9. [PR #9] |
| Review requests & referrals (G10) | OPEN PR | PR #11. [PR #11] |
| Growth data models (G1) | OPEN PR | PR #963. Duplicates the existing growth stack in concept. [PR #963] |
| Churn scoring | PLANNED | No code yet. [none found] |
| Upsell suggestions | PLANNED | No restaurant upsell code (the hotel extras are separate). [none found] |
| AI cash-close checks | PLANNED | Close readiness exists, but there's no AI check. [none found] |


## 5. Agency

Agency modules: agency-core (mandatory; its shared parts are in section 2), projects, clients and finance. Agency has no limit keys, so plans are seat-based only.

### Packages, modules & roles


| Feature | Implementation status | Detail |
|---|---|---|
| Agency Core module | LIVE | Always on: dashboard, team, chat, notes, meetings, email and HR basics. [src/lib/vertical-catalog.ts AGENCY_MODULES agency-core] |
| Projects module (switchable) | LIVE | Projects, boards, tasks and time tracking. It can be switched on or off per plan. [src/lib/vertical-catalog.ts projects] |
| Clients module (switchable) | LIVE | Client records, contacts and contracts. [src/lib/vertical-catalog.ts clients] |
| Finance module (switchable) | LIVE | Invoices, transactions, expenses, budgets and P&L. [src/lib/vertical-catalog.ts finance] |
| Seat-based plans | LIVE | Agency plans count users only. There are no other agency limits. [src/lib/vertical-catalog.ts AGENCY_LIMIT_KEYS = []] |
| Ready-made roles: Administrator and Member | LIVE | Administrator has every permission; Member has none extra. Marked provisional. There are no agency job roles like designer or account manager. [src/lib/vertical-catalog.ts AGENCY_ROLE_TEMPLATES] |
| Agency departments | LIVE | Leadership, Engineering, Product, Quality, Marketing, Design. [src/lib/vertical-catalog.ts AGENCY_DEPARTMENTS] |
| Shared platform (login, 2FA, SSO, roles, tenancy, billing, audit) | LIVE | Same as pharmacy. See the Platform rows in devfathom-pharmacy-features-detailed.md. [devfathom-pharmacy-features-detailed.md] |
| Agency growth / marketing / AI tools | PLANNED | There are none for agencies. Growth, loyalty and AI actions are wired only for pharmacy and restaurant. [/workspace/docs-drafts/pr4/docs/product/agency-guide.md §7; no agency growth router on develop] |
| Agency-specific job roles | PLANNED | Roles such as account manager or designer don't exist yet. [src/lib/vertical-catalog.ts AGENCY_ROLE_TEMPLATES] |


### Clients


| Feature | Implementation status | Detail |
|---|---|---|
| Clients list page | LIVE | All clients in one list. [src/app/(app)/clients] |
| Client detail page | LIVE | One client's details, contacts, contracts and activity. [src/app/(app)/clients/[id]/client-detail-content.tsx] |
| List clients | LIVE | See all clients. [src/server/routers/clients.ts getAll] |
| View client | LIVE | Open one client. [src/server/routers/clients.ts getById] |
| Client activity timeline | LIVE | History of what happened with this client. [src/server/routers/clients.ts getActivity] |
| Create client | LIVE | Add a new client. [src/server/routers/clients.ts create] |
| Edit client | LIVE | Update client details. [src/server/routers/clients.ts update] |
| Delete client | LIVE | Remove a client. [src/server/routers/clients.ts delete] |
| Add contact | LIVE | Add a person at the client, with email and phone. [src/server/routers/clients.ts addContact] |
| Edit contact | LIVE | Change a contact. [src/server/routers/clients.ts updateContact] |
| Delete contact | LIVE | Remove a contact. [src/server/routers/clients.ts deleteContact] |
| Add contract | LIVE | Record a contract with value and dates. [src/server/routers/clients.ts addContract] |
| Edit contract | LIVE | Change a contract. [src/server/routers/clients.ts updateContract] |
| Change contract status | LIVE | Mark a contract active, ended and so on. [src/server/routers/clients.ts setContractStatus] |
| Delete contract | LIVE | Remove a contract. [src/server/routers/clients.ts deleteContract] |
| Contracted value | LIVE | Total value of a client's contracts. [src/server/routers/clients.ts contractedValue] |
| Expiring contracts alert | LIVE | Lists contracts ending soon. [src/server/routers/clients.ts getExpiringContracts] |
| Auto-expire contracts | LIVE | Marks contracts past their end date as expired. [src/server/routers/clients.ts sweepExpiredContracts] |
| Invoice from contract | LIVE | Creates a draft invoice straight from a contract. [src/server/routers/clients.ts generateInvoiceFromContract] |
| Clients REST API | LIVE | Outside systems can read and write clients through the public API with an API token. [src/app/api/v1/clients/route.ts, [id]] |


### Projects & members


| Feature | Implementation status | Detail |
|---|---|---|
| Projects list page | LIVE | All projects. [src/app/(app)/projects] |
| Project detail page | LIVE | One project's overview, members, milestones and files. [src/app/(app)/projects/[id]/project-detail-content.tsx] |
| List projects | LIVE | See projects you can access. [src/server/routers/projects.ts getAll] |
| View project | LIVE | Open one project. [src/server/routers/projects.ts getById] |
| Create project | LIVE | Start a new project, optionally linked to a client. [src/server/routers/projects.ts create] |
| Edit project | LIVE | Change name, dates, status. [src/server/routers/projects.ts update] |
| Delete project | LIVE | Remove a project. [src/server/routers/projects.ts delete] |
| Add project member | LIVE | Give a teammate access to the project. [src/server/routers/projects.ts addMember] |
| Remove project member | LIVE | Take access away. [src/server/routers/projects.ts removeMember] |
| Set member role on project | LIVE | Make someone a project lead or regular member. [src/server/routers/projects.ts setMemberRole] |
| Create milestone | LIVE | Add a key date or deliverable. [src/server/routers/projects.ts createMilestone] |
| Edit milestone | LIVE | Change a milestone. [src/server/routers/projects.ts updateMilestone] |
| Delete milestone | LIVE | Remove a milestone. [src/server/routers/projects.ts deleteMilestone] |
| Upload project file | LIVE | Attach a file to the project. [src/server/routers/projects.ts addFile] |
| Delete project file | LIVE | Remove a file. [src/server/routers/projects.ts deleteFile] |
| Projects REST API | LIVE | Public API for projects. [src/app/api/v1/projects/route.ts, [id]] |
| Import from Trello | LIVE | Import a Trello board (lists, cards) into a project. [src/server/routers/trello-import.ts importBoard; src/app/(app)/projects/import] |


### Boards & columns


| Feature | Implementation status | Detail |
|---|---|---|
| Kanban board page | LIVE | Drag-and-drop task board for a project. [src/app/(app)/projects/[id]/board] |
| Load board with tasks | LIVE | Opens the board with all its columns and cards. [src/server/routers/projects.ts getBoardWithTasks] |
| Create board | LIVE | Add another board to a project. [src/server/routers/projects.ts createBoard] |
| Edit board | LIVE | Rename or change a board. [src/server/routers/projects.ts updateBoard] |
| Delete board | LIVE | Remove a board. [src/server/routers/projects.ts deleteBoard] |
| Create column | LIVE | Add a column (for example Review). [src/server/routers/projects.ts createColumn] |
| Edit column | LIVE | Rename a column or change its limits. [src/server/routers/projects.ts updateColumn] |
| Delete column | LIVE | Remove a column. [src/server/routers/projects.ts deleteColumn] |
| Reorder columns | LIVE | Drag columns into a new order. [src/server/routers/projects.ts reorderColumns] |
| Column default assignees | LIVE | Tasks moved into a column are automatically given to set people. [src/server/routers/projects.ts setColumnDefaultAssignees] |
| Board labels list | LIVE | See the board's coloured labels. [src/server/routers/projects.ts getBoardLabels] |
| Create label | LIVE | Add a label. [src/server/routers/projects.ts createLabel] |
| Edit label | LIVE | Rename or recolour a label. [src/server/routers/projects.ts updateLabel] |
| Delete label | LIVE | Remove a label. [src/server/routers/projects.ts deleteLabel] |
| Boards REST API | LIVE | Public API for boards. [src/app/api/v1/boards/[id]] |


### Tasks


| Feature | Implementation status | Detail |
|---|---|---|
| Create task | LIVE | Add a card with title, description, due date and priority. [src/server/routers/projects.ts createTask] |
| Edit task | LIVE | Change any task field. [src/server/routers/projects.ts updateTask] |
| Delete task | LIVE | Remove a task. [src/server/routers/projects.ts deleteTask] |
| Move task | LIVE | Drag a task to another column or position. [src/server/routers/projects.ts moveTask] |
| Bulk move tasks | LIVE | Move many tasks at once. [src/server/routers/projects.ts bulkMoveTasks] |
| Bulk delete tasks | LIVE | Delete many tasks at once. [src/server/routers/projects.ts bulkDeleteTasks] |
| Task detail view | LIVE | Opens the full task with comments, checklists, files and time. [src/server/routers/projects.ts getTaskDetail] |
| Assign people to task | LIVE | Set or change who's working on it. [src/server/routers/projects.ts updateTaskAssignees] |
| Subtasks (parent task) | LIVE | Nest a task under another. [src/server/routers/projects.ts setTaskParent] |
| Add blocker | LIVE | Mark that a task is waiting on another. [src/server/routers/projects.ts addBlocker] |
| Remove blocker | LIVE | Clear that dependency. [src/server/routers/projects.ts removeBlocker] |
| Add label to task | LIVE | Tag a task. [src/server/routers/projects.ts addLabelToTask] |
| Remove label from task | LIVE | Untag a task. [src/server/routers/projects.ts removeLabelFromTask] |
| Add comment | LIVE | Discuss on the task. [src/server/routers/projects.ts addComment] |
| Edit comment | LIVE | Change your comment. [src/server/routers/projects.ts updateComment] |
| Delete comment | LIVE | Remove a comment. [src/server/routers/projects.ts deleteComment] |
| Attach file to task | LIVE | Upload a file to the task. [src/server/routers/projects.ts addTaskAttachment] |
| Delete task attachment | LIVE | Remove the file. [src/server/routers/projects.ts deleteTaskAttachment] |
| Create checklist | LIVE | Add a to-do list inside a task. [src/server/routers/projects.ts createChecklist] |
| Rename checklist | LIVE | Change its title. [src/server/routers/projects.ts renameChecklist] |
| Delete checklist | LIVE | Remove it. [src/server/routers/projects.ts deleteChecklist] |
| Add checklist item | LIVE | Add a step. [src/server/routers/projects.ts addChecklistItem] |
| Rename checklist item | LIVE | Change a step. [src/server/routers/projects.ts renameChecklistItem] |
| Tick / untick checklist item | LIVE | Mark a step done. [src/server/routers/projects.ts toggleChecklistItem] |
| Delete checklist item | LIVE | Remove a step. [src/server/routers/projects.ts deleteChecklistItem] |
| Task activity history | LIVE | Who changed what on the task. [src/server/routers/projects.ts getTaskActivity] |
| Tasks REST API | LIVE | Public API to create and update tasks. Known issue: QA found REST lets you assign people who aren't project members (tRPC checks this, REST doesn't). [src/app/api/v1/tasks/[id]/route.ts; /workspace/plan/agency-1005/b.md] |


### Time tracking


| Feature | Implementation status | Detail |
|---|---|---|
| Log time on task | LIVE | Type hours spent by hand. There's no start/stop timer. [src/server/routers/projects.ts logTime] |
| Edit time entry | LIVE | Correct hours or notes. [src/server/routers/projects.ts updateTimeEntry] |
| Delete time entry | LIVE | Remove an entry. [src/server/routers/projects.ts deleteTimeEntry] |
| Time on a task | LIVE | See all entries for a task. [src/server/routers/projects.ts listTaskTime] |
| Time rollup | LIVE | Totals by project and person. [src/server/routers/projects.ts getTimeRollup] |
| Start/stop timer | PLANNED | A live timer isn't built. [/workspace/docs-drafts/pr4/docs/product/agency-guide.md; no timer procedure in src/server/routers/projects.ts] |
| Billable time to invoice | PLANNED | Time entries don't turn into invoice lines automatically. [src/server/routers/finance.ts (no time-entry link)] |


### Finance: invoices


| Feature | Implementation status | Detail |
|---|---|---|
| Finance page | LIVE | Tabs for invoices, transactions, expenses, budgets and P&L. [src/app/(app)/finance/finance-content.tsx] |
| List invoices | LIVE | See all invoices with status. [src/server/routers/finance.ts getInvoices] |
| View invoice | LIVE | Open one invoice. [src/server/routers/finance.ts getInvoiceById] |
| Create invoice | LIVE | Make an invoice for a client with line items, in USD or PKR. Since #1226 (DEV-258) invoice numbers (`INV-<year>-NNN`) are unique **per organization** and allocated under a tenant advisory lock, so two agencies can both have INV-2026-001 and concurrent creates can't collide. [src/server/routers/finance.ts createInvoice; src/lib/finance/invoice-number.ts; migration 20261106130000_invoice_number_per_organization] |
| Edit invoice | LIVE | Change an invoice. [src/server/routers/finance.ts updateInvoice] |
| Change invoice status | LIVE | Mark as draft, sent, paid, cancelled. [src/server/routers/finance.ts updateInvoiceStatus] |
| Record payment | LIVE | Add a payment received against an invoice; partial payments allowed. [src/server/routers/finance.ts addPayment] |
| Delete payment | LIVE | Remove a recorded payment. [src/server/routers/finance.ts deletePayment] |
| Mark overdue invoices | LIVE | Flags unpaid invoices past their due date. [src/server/routers/finance.ts markOverdueInvoices] |
| Email invoice to client | LIVE | Sends the invoice to the client's primary contact (or any contact with an email) using the platform mailer. [src/server/routers/finance.ts sendInvoiceEmail] |
| Printable invoice | LIVE | Print-friendly invoice page / save as PDF via the browser. [src/app/(app)/finance/invoices/[id]/print/print-invoice.tsx] |
| Invoices REST API | LIVE | Public API for invoices. [src/app/api/v1/invoices/route.ts, [id]] |
| Online invoice payment (card / link) | PLANNED | Clients can't pay an invoice online. Payments are recorded by hand. [src/server/routers/finance.ts addPayment only] |
| Tax / FBR e-invoicing for agency | PLANNED | No agency tax or FBR integration. [src/server/routers/finance.ts] |


### Finance: money in & out


| Feature | Implementation status | Detail |
|---|---|---|
| List transactions | LIVE | Income and expense ledger. [src/server/routers/finance.ts getTransactions] |
| Add transaction | LIVE | Record income or an expense. [src/server/routers/finance.ts createTransaction] |
| Edit transaction | LIVE | Change one. [src/server/routers/finance.ts updateTransaction] |
| Delete transaction | LIVE | Remove one. [src/server/routers/finance.ts deleteTransaction] |
| List recurring expenses | LIVE | Rent, software subscriptions and so on. [src/server/routers/finance.ts getRecurringExpenses] |
| Add recurring expense | LIVE | Set up a repeating cost. [src/server/routers/finance.ts createRecurringExpense] |
| Delete recurring expense | LIVE | Stop it. [src/server/routers/finance.ts deleteRecurringExpense] |
| Post due recurring expenses | LIVE | Turns due recurring costs into transactions. [src/server/routers/finance.ts postDueRecurringExpenses] |
| Budget vs actuals | LIVE | Compare planned spending with actual. [src/server/routers/finance.ts getBudgetVsActuals] |
| Financial summary | LIVE | Income, expenses and outstanding at a glance. [src/server/routers/finance.ts getFinancialSummary] |
| Profit & loss report | LIVE | P&L for a period. [src/server/routers/finance.ts getPnlReport] |
| Transactions REST API | LIVE | Public API for transactions. [src/app/api/v1/transactions/route.ts, [id]] |
| Finance summary REST API | LIVE | Public API for the summary. [src/app/api/v1/finance/summary] |
| Export reports to spreadsheet | PLANNED | No export button found for finance reports (TODO(confirm) in the agency guide). [src/app/(app)/finance (no export)] |


## 6. Hotel (HOSPITALITY)

Only the foundation is on develop: packages, property modes and settings, access, rooms, beds and blocks, meal plans, extras, function spaces and journey templates (settings pages under `/hotel/settings/*`). Routers mounted: `hotelProperty` (with nested `inventory`, `functionSpaces` and `journeyTemplates`) and `hotelRates`. Operations (reservations, front desk, folio, housekeeping, rate plans) are in **OPEN PR #964 (salvage)**. Hotel building is paused (Saad, 22 Oct). Hotel `rooms.setStatus` and `beds.setStatus` use a bare `protectedProcedure`; the capability fix is OPEN PR #1006 (Sev3).

### Packages, modes & feature switches


| Feature | Implementation status | Detail |
|---|---|---|
| Hotel Essentials package | LIVE | Package for one property, up to 50 rooms and 15 users, with core, reservations, front desk, folio, payments, night audit and reports modules. Only the core settings work today; the other modules are switches with no screens yet. [src/lib/vertical-catalog.ts HOSPITALITY_PACKAGES hotel-essentials] |
| Hotel Pro package | LIVE | Up to 3 properties, 250 rooms and 75 users, adding channels, upsell, marketing, travel agents, maintenance and partner API modules (all still Planned). [src/lib/vertical-catalog.ts hotel-pro] |
| Hotel Chain package | LIVE | Up to 100 properties, 10,000 rooms and 2,500 users, adding central reservations (Planned). [src/lib/vertical-catalog.ts hotel-chain] |
| Venue package | LIVE | For event venues with no rooms: function spaces and banquets, room limit deliberately 0. [src/lib/vertical-catalog.ts hotel-venue] |
| Hotel limits (properties, rooms, users) | LIVE | The plan's limits are read safely: a missing or invalid limit counts as zero, never as unlimited. [src/lib/hotel/features.ts resolveHotelLimits, hotelRoomLimit; src/lib/entitlement-limits.ts] |
| Property mode: Hotel | LIVE | Rooms sold by the night, with a front desk and nightly audit. It is the default mode. [src/lib/hotel/property.ts HOTEL_PROPERTY_MODES] |
| Property mode: Hostel | LIVE | Beds sold one by one in shared rooms; room occupancy comes from the beds. [src/lib/hotel/property.ts] |
| Property mode: Serviced apartments | LIVE | Units let by the week or month, with recurring charges and tenancy documents. [src/lib/hotel/property.ts] |
| Property mode: Resort | LIVE | Rooms by the night plus day-use slots on the same rooms. [src/lib/hotel/property.ts] |
| Property mode: Venue | LIVE | Function spaces and events only, with no rooms. [src/lib/hotel/property.ts] |
| Mode defaults | LIVE | Choosing a mode fills in sensible defaults (what is sold, billing cycles, booking layout) that the owner can change. [src/lib/hotel/modes.ts applyHotelModeDefaults] |
| Mode overrides | LIVE | Change what a property sells (rooms, beds, units), its billing cycles (nightly, weekly, monthly, slot), dorm rules, recurring extras, tenancy documents and booking-engine layout. Saved per property. [src/server/routers/hotel-property.ts modes.get / modes.set; src/lib/hotel/mode-overrides.ts] |
| Feature switches follow settings, not mode names | LIVE | Which screens a property gets depends on its settings and its plan, not on the mode's name. For example, day use needs the slot billing cycle and the reservations module. [src/lib/hotel/features.ts evaluateHotelFeatures] |
| Day-use slot calculation | LIVE | Works out a day-use slot's time window on a room, and refuses rooms that are out of order. This is a calculation only, because there's no booking screen yet. [src/lib/hotel/day-use.ts calculateDayUseSlot] |


### Property setup & settings


| Feature | Implementation status | Detail |
|---|---|---|
| Hotel landing page | LIVE | The /hotel home shows the properties you manage, their mode and how many are ready to go live, or tells you that no property is assigned to you. [src/lib/hotel/landing.ts loadHotelLanding; src/app/(app)/hotel] |
| Property settings page | LIVE | Screen for the property's facts and policies. [src/app/(app)/hotel/settings/property/page.tsx; src/components/hotel/property-settings-form.tsx] |
| View property | LIVE | Loads a property's saved settings. [src/server/routers/hotel-property.ts get] |
| Edit property facts | LIVE | Update name, timezone, check-in and check-out times, business date, audit time and policies. [src/server/routers/hotel-property.ts update; src/lib/hotel/property.ts hotelPropertyUpdateInput] |
| Timezone check | LIVE | Refuses a timezone that doesn't exist. [src/lib/hotel/property.ts isValidHotelTimezone] |
| Booking-engine web address (slug) | LIVE | Each property gets a short web name for a future booking page, generated from the organization and property names. The booking page itself doesn't exist yet. [src/lib/hotel/property.ts bookingEngineSlug, defaultBookingEngineSlug] |
| Policy documents | LIVE | Space to store cancellation, deposit and similar policies as free-form settings. Later modules will use them. [src/lib/hotel/property.ts] |
| Tax profile | LIVE | Set the province (Punjab, Sindh, KP, Balochistan, ICT, GB, AJK), room tax rate, whether prices include or exclude tax, fixed levies, and the NTN and STRN numbers. It checks the setup only and doesn't certify legal readiness. [src/lib/hotel/tax.ts hotelTaxProfileSchema] |
| Room-night tax calculation | LIVE | Calculates the tax on one room-night in whole paisa, using integer maths. Nothing calls it for billing yet, because there's no folio on develop. [src/lib/hotel/tax.ts computeRoomNightTax] |
| Hotel e-invoicing (FBR) | LIVE | The tax profile has an e-invoice switch and integration field, but submission defaults to SIMULATED. There's no live FBR integrator. [src/lib/hotel/tax.ts submissionMode] |
| Go-live checklist | LIVE | Six steps a property must finish before activation: mode, property facts, tax profile, business date and audit time, roles assigned, and at least one room type (or function space for a venue). [src/lib/hotel/onboarding-checklist.ts HOTEL_ONBOARDING_STEPS] |
| Deactivate / reactivate a property | LIVE | Platform staff can switch a property off and back on. Reactivation re-checks the checklist. [src/lib/platform/hotel-property-maintenance.ts deactivateHotelProperty, reactivateHotelProperty] |
| Recover property manager | LIVE | Platform staff can restore a manager to a property that has lost every admin. [src/lib/platform/hotel-property-maintenance.ts recoverHotelPropertyManager] |
| Change history (audit) | LIVE | Every hotel settings change is written to the audit log with before and after values. [src/lib/hotel/audit.ts recordHotelAudit] |


### Property access & roles


| Feature | Implementation status | Detail |
|---|---|---|
| Choose active property | LIVE | Staff with more than one property pick which one they're working in. [src/server/routers/hotel-property.ts access.select] |
| My properties list | LIVE | Lists the properties you're assigned to. [src/server/routers/hotel-property.ts access.properties] |
| Properties by permission | LIVE | Lists the properties where you hold a given permission. [src/server/routers/hotel-property.ts access.propertiesByCapability] |
| Assign staff to property | LIVE | An admin gives a staff member access to a property. [src/server/routers/hotel-property.ts access.assign] |
| Remove staff from property | LIVE | An admin takes that access away. [src/server/routers/hotel-property.ts access.revoke] |
| Property-scoped data | LIVE | Every hotel read and write is limited to the organization and the chosen property, with database row security underneath. [src/server/hotel-property-scope.ts; src/server/hotel-property-context.ts] |
| 19 hotel permissions | LIVE | Separate permissions for reservations, front desk, folio, folio adjustments, payments, refunds, rates, availability override, housekeeping, night audit, guest ID, financial reports, channels, property admin, marketing, agents, banquets, maintenance and API admin. Most protect screens that aren't built yet. [src/lib/vertical-catalog.ts HOSPITALITY_CAPABILITIES] |
| Ready-made hotel roles | LIVE | Owner, General Manager, Front Office Manager, Front Desk Agent, Reservations Agent, Night Auditor, Housekeeping Supervisor, Housekeeper, Maintenance Technician and Manager, Accounts and more. [src/lib/vertical-catalog.ts HOSPITALITY_ROLE_TEMPLATES] |
| Hotel departments | LIVE | Front Office, Housekeeping, Maintenance, Food and Beverage, Sales and Events, Finance. [src/lib/vertical-catalog.ts HOSPITALITY_DEPARTMENTS] |
| Shared platform (login, roles, tenancy, billing) | LIVE | Same as pharmacy. See the Platform rows in devfathom-pharmacy-features-detailed.md. [devfathom-pharmacy-features-detailed.md] |


### Rooms, beds & units (inventory)


| Feature | Implementation status | Detail |
|---|---|---|
| Rooms settings page | LIVE | Screen to manage room types, rooms, beds and blocks. [src/app/(app)/hotel/settings/rooms/page.tsx; src/components/hotel/inventory-panel.tsx] |
| List room types | LIVE | See the property's room types. [src/server/routers/hotel-inventory.ts roomTypes.list] |
| Create room type | LIVE | Add a room type (for example Deluxe Double) with its kind: room, bed or unit. [src/server/routers/hotel-inventory.ts roomTypes.create] |
| List rooms | LIVE | See the rooms, with filters. [src/server/routers/hotel-inventory.ts rooms.list] |
| Create room | LIVE | Add a room under a room type. The plan's room limit is enforced. [src/server/routers/hotel-inventory.ts rooms.create; src/lib/hotel/inventory.ts] |
| Set room status | LIVE | Mark a room clean, dirty, inspected, out of order and so on. Occupied is set only by a stay, so it isn't on this board. [src/server/routers/hotel-inventory.ts rooms.setStatus; src/lib/hotel/inventory.ts HOTEL_INVENTORY_STATUSES] |
| Room status history | LIVE | See every status change on a room. [src/server/routers/hotel-inventory.ts rooms.history; prisma HotelRoomStatusEvent] |
| Beds in a room (hostel) | LIVE | List the beds inside a shared room. [src/server/routers/hotel-inventory.ts beds.list; prisma HotelBed] |
| Set bed status | LIVE | Change a single bed's status. [src/server/routers/hotel-inventory.ts beds.setStatus] |
| Dorm gender policy | LIVE | A dorm can be any, male-only or female-only. [src/lib/hotel/inventory.ts HOTEL_GENDER_POLICIES] |
| List room blocks | LIVE | See rooms taken out of sale. [src/server/routers/hotel-inventory.ts blocks.list] |
| Block a room | LIVE | Take a room out of sale as out of order or out of service for a date range. [src/server/routers/hotel-inventory.ts blocks.create; prisma HotelRoomBlock] |
| Release a room block | LIVE | Put the room back on sale. [src/server/routers/hotel-inventory.ts blocks.release] |
| Housekeeping status board with tasks | OPEN PR #964 (salvage; hotel build paused) | A full housekeeping board with cleaning tasks. Work exists only on a local, unreviewed branch and hotel building is paused (Saad, 22 Oct 15:28 PKT). Nothing is on develop or in an open PR. [/workspace/plan/hotel-build-plan.md M2 fix/hotel-housekeeping] |


### Meal plans & extras


| Feature | Implementation status | Detail |
|---|---|---|
| Meal plans page | LIVE | Screen to manage meal plans. [src/app/(app)/hotel/settings/meal-plans/page.tsx; src/components/hotel/meal-plans-panel.tsx] |
| Default meal plans | LIVE | New properties start with the standard plans: EP (room only), CP (breakfast), MAP (two meals), AP (all meals). [src/lib/hotel/meal-plans.ts STANDARD_MEAL_PLAN_CODES] |
| List meal plans | LIVE | See the property's plans. [src/server/routers/hotel-rates.ts mealPlans.list] |
| Create meal plan | LIVE | Add a plan, choosing which of breakfast, lunch and dinner it covers, service cut-off times, and whether meals belong to the room or each guest. An Urdu name is optional. [src/server/routers/hotel-rates.ts mealPlans.create; src/lib/hotel/meal-plans.ts] |
| Edit meal plan | LIVE | Change a plan. Its code can't change, because it identifies the plan on vouchers. [src/server/routers/hotel-rates.ts mealPlans.update] |
| Switch meal plan on or off | LIVE | Retire a plan without deleting it. [src/server/routers/hotel-rates.ts mealPlans.setActive] |
| Extras page | LIVE | Screen to manage chargeable extras. [src/app/(app)/hotel/settings/extras/page.tsx; src/components/hotel/extras-catalog.tsx] |
| List extras | LIVE | See the extras catalogue. [src/server/routers/hotel-property.ts extras.list] |
| Create extra | LIVE | Add an extra (for example airport pickup) with a price in PKR, tax class, department and how often it charges: one off, every night, once per stay or per person. [src/server/routers/hotel-property.ts extras.create; src/lib/hotel/extras.ts] |
| Edit extra | LIVE | Change an extra. [src/server/routers/hotel-property.ts extras.update] |
| Switch extra on or off | LIVE | Retire an extra. [src/server/routers/hotel-property.ts extras.setActive] |
| Extra/billing-cycle check | LIVE | Refuses pairings that make no sense (for example a nightly extra on a monthly let), with a reason the owner can act on. [src/lib/hotel/extras.ts assertHotelExtraRecurrenceForBillingCycle] |
| Posting departments | LIVE | Extras are filed under 14 departments (Rooms, Day use, F&B, Minibar, Laundry, Spa, Transport and others) for future reports. [src/lib/hotel/extras.ts HOTEL_DEPARTMENT_LABELS] |
| Rate plans (nightly prices + tax rules) | OPEN PR #964 (salvage; hotel build paused) | Nightly room prices and rate rules worked out on the server. Work exists only on a local, unreviewed branch and hotel building is paused (Saad, 22 Oct 15:28 PKT). Nothing is on develop or in an open PR. [/workspace/plan/hotel-build-plan.md M4 fix/hotel-rates] |


### Function spaces & events


| Feature | Implementation status | Detail |
|---|---|---|
| Spaces page | LIVE | Screen to manage halls and meeting rooms. [src/app/(app)/hotel/settings/spaces/page.tsx; src/components/hotel/function-spaces-panel.tsx] |
| List function spaces | LIVE | See halls and meeting rooms. [src/server/routers/hotel-function-spaces.ts list] |
| Create function space | LIVE | Add a space with capacity per layout (theatre, banquet and so on), pricing, setup and clear-down buffers, and an optional Urdu name. [src/server/routers/hotel-function-spaces.ts create; src/lib/hotel/function-spaces.ts] |
| Edit function space | LIVE | Change a space. [src/server/routers/hotel-function-spaces.ts update] |
| Switch space on or off | LIVE | Retire a space. [src/server/routers/hotel-function-spaces.ts setActive] |
| Space availability | LIVE | See when a space is free in a time window, counting buffers. [src/server/routers/hotel-function-spaces.ts availability] |
| List space bookings | LIVE | See holds on a space. [src/server/routers/hotel-function-spaces.ts bookings.list] |
| Hold a space | LIVE | Reserve a space for a time slot, up to a week. Double-booking is refused by the database. [src/server/routers/hotel-function-spaces.ts bookings.hold; prisma HotelSpaceBooking] |
| Release a space hold | LIVE | Cancel a hold. [src/server/routers/hotel-function-spaces.ts bookings.release] |
| Banquet event orders, catering and menus | PLANNED | Full banquets module: event orders, catering and billing. [src/lib/vertical-catalog.ts hotel-banquets (module switch only)] |


### Guest journey messages


| Feature | Implementation status | Detail |
|---|---|---|
| Journey settings page | LIVE | Screen to write guest message templates. [src/app/(app)/hotel/settings/journey/page.tsx; src/components/hotel/journey-templates-editor.tsx] |
| Eight journey moments | LIVE | Templates for booking confirmed, pre-arrival offer, self check-in, welcome, during the stay, express checkout, invoice and review request. [src/lib/hotel/journey-templates.ts HOTEL_JOURNEY_MOMENT_LABELS] |
| Channels and languages | LIVE | Each template is for WhatsApp, e-mail or SMS, in English or Urdu. [src/lib/hotel/journey-templates.ts] |
| List templates | LIVE | See templates and their status. [src/server/routers/hotel-journey-templates.ts list] |
| Save draft template | LIVE | Write or edit a template using placeholders like the guest name. Broken placeholders are refused. [src/server/routers/hotel-journey-templates.ts save] |
| Approve template | LIVE | A manager approves a draft before it can be used. [src/server/routers/hotel-journey-templates.ts approve] |
| Retire template | LIVE | Take a template out of use. [src/server/routers/hotel-journey-templates.ts retire] |
| Preview template | LIVE | See the message with sample guest details filled in. [src/server/routers/hotel-journey-templates.ts preview] |
| Marketing vs service consent | LIVE | Pre-arrival offers and review requests count as marketing and need marketing consent. The rest are service messages. [src/lib/hotel/journey-templates.ts journeyConsentPurpose] |
| Actually sending journey messages | PLANNED | Nothing sends these templates yet. There's no WhatsApp, SMS or e-mail sending for hotel, and no stays to trigger them. [src/lib/hotel/journey-templates.ts (templates only); src/lib/vertical-catalog.ts hotel-upsell] |


### Operations modules not yet on main


| Feature | Implementation status | Detail |
|---|---|---|
| Reservations and availability | OPEN PR #964 (salvage; hotel build paused) | Create bookings, check availability, holds and an overbooking guard. Work exists only on a local, unreviewed branch and hotel building is paused (Saad, 22 Oct 15:28 PKT). Nothing is on develop or in an open PR. [/workspace/plan/hotel-build-plan.md M3 fix/hotel-reservations] |
| Folio and charges | OPEN PR #964 (salvage; hotel build paused) | Guest bill (folio) with charges, corrections only by reversal, and server-side tax. Work exists only on a local, unreviewed branch and hotel building is paused (Saad, 22 Oct 15:28 PKT). Nothing is on develop or in an open PR. [/workspace/plan/hotel-build-plan.md M1 fix/hotel-folio] |
| Front desk check-in and check-out | OPEN PR #964 (salvage; hotel build paused) | Check guests in and out against the business date, charging only nights stayed. Work exists only on a local, unreviewed branch and hotel building is paused (Saad, 22 Oct 15:28 PKT). Nothing is on develop or in an open PR. [/workspace/plan/hotel-build-plan.md M5 fix/hotel-frontdesk] |
| Night audit | OPEN PR #964 (salvage; hotel build paused) | Roll the business date and post room-nights to folios. Work exists only on a local, unreviewed branch and hotel building is paused (Saad, 22 Oct 15:28 PKT). Nothing is on develop or in an open PR. [/workspace/plan/hotel-build-plan.md M6 fix/hotel-night-audit] |
| Hotel reports | OPEN PR #964 (salvage; hotel build paused) | Occupancy, average daily rate (ADR), RevPAR and folio balances. Work exists only on a local, unreviewed branch and hotel building is paused (Saad, 22 Oct 15:28 PKT). Nothing is on develop or in an open PR. [/workspace/plan/hotel-build-plan.md M7 fix/hotel-reports] |
| Hotel payments | PLANNED | Taking deposits and settling guest bills. Module switch only. [src/lib/vertical-catalog.ts module list; no router or page on develop] |
| Guest identity records | PLANNED | Storing guest ID details (permission hotel:guest-identity exists). [src/lib/vertical-catalog.ts module list; no router or page on develop] |
| Channel manager and booking engine | PLANNED | Selling rooms on OTAs and the property's own booking page. [src/lib/vertical-catalog.ts module list; no router or page on develop] |
| Guest upsell | PLANNED | Pre-arrival offers and upgrades. [src/lib/vertical-catalog.ts module list; no router or page on develop] |
| Hotel marketing | PLANNED | Campaigns to past guests. [src/lib/vertical-catalog.ts module list; no router or page on develop] |
| Travel agents | PLANNED | Agent accounts and commissions. [src/lib/vertical-catalog.ts module list; no router or page on develop] |
| Maintenance | PLANNED | Work orders for rooms and equipment. [src/lib/vertical-catalog.ts module list; no router or page on develop] |
| Partner API and GL export | PLANNED | API for partners and general-ledger export. [src/lib/vertical-catalog.ts module list; no router or page on develop] |
| Central reservations (chain) | PLANNED | One booking desk across many properties. [src/lib/vertical-catalog.ts module list; no router or page on develop] |
| Long-stay tenancy documents | PLANNED | Lease paperwork for serviced apartments (only a settings flag exists today). [src/lib/vertical-catalog.ts module list; no router or page on develop] |


## 7. Other verticals and cross-cutting surfaces

**Only four verticals exist in the code:** AGENCY, RESTAURANT, PHARMACY and HOSPITALITY (enum and `vertical-catalog.ts`). There are no others and no PRs for others. Surfaces that don't belong to one vertical:

| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Restaurant demo tenants and demo page | LIVE | | `/demo/restaurants`; `api/cron/demo-restaurants` (not in `vercel.json`) |
| Supplier PO portal (tokenised link) | LIVE | A supplier opens a PO from a secure link without logging in. | `/supplier/po/[token]` |
| Brand preview | LIVE | | `/brand/preview` |
| Health probes | LIVE | | `/api/health`, `/api/ready`, `/api/live` |
| Vertical leakage (agency and HR pages visible to pharmacy) | KNOWN BUG, fix in PR #986 and #1005 | | |
| Prisma errors leak on stale tenant writes | KNOWN BUG, fix in PR #1067 | | |
| Migrations silently no-op under forced RLS | KNOWN BUG, fix in PR #23 | | |

## Appendix A. Every tRPC router and procedure on develop (1094 procedures, 80 router files)

Extracted from `src/server/routers/*.ts` (tests excluded) with a TypeScript syntax-tree walk at `1906b530`. This count is higher than the 968 in the 2 Nov edition because the old regex missed procedures built from shared variables; the same walk on `47518cbf` finds 1,043, so the real change since then is **+51 procedures, none removed**. Nested sub-router names are shown as `parent.child`. New routers since `47518cbf` are marked ★.

- **ai-settings** ★: get setMode setProviderOrder setFallbackEnabled setMonthlyCap setTierModel reset listModelPrices upsertModelPrice
- **api-tokens**: list usage create revoke
- **audit**: list filters stats
- **chat**: getChannels getMessages getThread getMessageEditHistory searchMessages getPins getSaved getMembers getMentionTargets browseChannels sendMessage editMessage deleteMessage toggleReaction markRead createChannel updateChannel archiveChannel deleteChannel joinChannel leaveChannel addMembers removeMember createOrGetDM togglePin toggleSave setMuted
- **clients**: getAll getById getActivity contractedValue sweepExpiredContracts getExpiringContracts create update addContact deleteContact updateContact addContract updateContract setContractStatus deleteContract generateInvoiceFromContract delete
- **dashboard**: getPreferences updatePreferences updateAppearance getStats getRecentActivity getUpcomingDeadlines getProjectCards getMyTasks getRevenueChart
- **email**: providers connectStart connectCallback listMailboxes listMessages getMessage sendMessage markRead refresh disconnect
- **finance**: getTransactions createTransaction updateTransaction deleteTransaction getInvoices getInvoiceById createInvoice updateInvoice sendInvoiceEmail updateInvoiceStatus addPayment deletePayment markOverdueInvoices getRecurringExpenses createRecurringExpense deleteRecurringExpense postDueRecurringExpenses getBudgetVsActuals getFinancialSummary getPnlReport
- **hotel-function-spaces**: list create update setActive availability bookings.list bookings.hold bookings.release
- **hotel-inventory**: roomTypes.list roomTypes.create rooms.list rooms.create rooms.setStatus rooms.history beds.list beds.setStatus blocks.list blocks.create blocks.release
- **hotel-journey-templates**: list save approve retire preview
- **hotel-property**: access.select access.properties access.propertiesByCapability access.assign access.revoke get update modes.get modes.set extras.properties extras.list extras.create extras.update extras.setActive
- **hotel-rates**: mealPlans.list mealPlans.create mealPlans.update mealPlans.setActive
- **invitations**: get accept
- **meetings**: getUpcoming getAll getPast create update delete getById markJoined logJoin logLeave getOccurrences rescheduleOccurrence cancelOccurrence createGuestInvitation revokeGuestInvitation getAttendanceReport
- **notes**: list notesMentioningMe getById search create update getNoteRevisions getRevision restoreRevision delete setShares
- **organization-admin**: askFathomSettings setAskFathomEnabled deepStrategySettings setDeepStrategyEnabled departments roles upsertDepartment removeDepartment overview updateProfile updateBrand updateEmail upsertRole removeRole updateMember createMember resetMemberPassword addDomain retryDomain createScimToken revokeScimToken
- **password-reset**: request validate reset
- **pharmacy-access** ★: navigation
- **pharmacy-branch-assignments**: list assign unassign
- **pharmacy-cameras**: workspace enrollGateway testConnection register configure setRetention issueViewerGrant configuredConnectionDiagnostics issueLiveViewGrant revokeViewerGrant evidence capturePending
- **pharmacy-dispensing**: returnVerificationQueue reviewQueue substitutionWorkspace enqueueReview decideReview recordSubstitution
- **pharmacy-finance**: cashFlowForecast financialStatements perpetualValuation grossMargin leakageReport marginComparison workspace post reverse closePeriod reopenPeriod importBankLine reconcile createSettlementBatch publishTaxProfile
- **pharmacy-inventory**: ingestDrapManual ingestDrapFile confirmDrapPrice drapRecallActions reverseDrapRecall createLocation recordTemperature importTemperatureCsv temperatureZoneStatuses configureTemperatureMonitoring registerBatch setBatchState receiveLot allocateForSale breakPack transfer createCount approveCount writeOff quarantinePart releaseQuarantinedPart allocateTransfer approveTransfer dispatchTransfer receiveTransferLine createRecall recallTrace acknowledgeRecall closeRecall reserveSupplierClaim nearExpiryBoard onHand approveSafetyStock refreshStockSignals markStaleSignals acknowledgeSignal snoozeSignal dismissSignal createDraftAction stockSignalDashboard stockSignalDigest expiryBoardLots draftExpiryMarkdown draftExpiryReturn quarantineExpiring transferBoard receiveTransferWithVariance
- **pharmacy-marketing**: basketHistory generateBaskets reviewBasket growthHistory generateGrowth reviewGrowth branches history approveTemplate createDraft review approve preview capture deliveryHistory sandboxDue sandbox attributeReceipts assist
- **pharmacy-medicine**: priceNotices confirmPrices ingestPriceNotices setPackPrice priceOverrides configureReferenceConnector referenceConnectorState runReferenceConnectorNow referenceConnectorProposals decideReferenceConnectorProposal referenceCandidates createIngredient createMedicine get createPackLevel revisePackLevel recordPrintedMrp deriveLooseUnitPrice addBarcode addAlias resolveScan search duplicateGroups recordReviewDecision publishAssertions supersedePublication
- **pharmacy-offline**: enroll rotate revoke
- **pharmacy-onboarding**: overview recordGate fbrTier1Status recordFbrTier1Check regulatory saveRegulatoryProfile
- **pharmacy-ordering**: deliveryCommand branches catalog mine place cancelMine staffQueue runners customers transition startCheckout complete
- **pharmacy-owner-import**: options upload preview commit
- **pharmacy-pack-label** ★: read
- **pharmacy-prescriptions**: workspace createPatient recordConsent uploadSource readSource extractSource capture readPatient exportPatient fill captureRefillReminder counterPatients counterPatientPanel
- **pharmacy-purchasing**: provisionMyPurchasePin createSupplier recordSupplierLicence verifySupplierLicence setSupplierAuthorization createRequisition submitRequisition recordQuote compareQuotes createPurchaseOrder submitPurchaseOrder approvePurchaseOrder sendPurchaseOrder landedCost createGoodsReceipt postGoodsReceipt controlledWitnesses reverseGoodsReceipt receivingExceptions resolveReceivingException createPurchaseReturn submitPurchaseReturn dispatchPurchaseReturn issueDebitNote recordSupplierCredit allocateSupplierCredit debitNotePositions workspace suppliers requisitions purchaseOrders receivedAgainstOrder goodsReceipts receivingExceptionQueue lotsFromReceipt purchaseReturns returnableLots resolveScan authenticatePack supplierCredits centralDemand createCentralPurchaseOrder allocateCentralReceipt
- **pharmacy-reports**: categoryGrowth marketing createPharmacovigilanceReport transitionPharmacovigilanceReport recordPharmacovigilanceSubmission exportPharmacovigilanceDrap branches replenishment dailyWorkPack catalog branchComparison repeatPurchasing commandCentre anomalySignals expiryAdvice proposeExpiryReturn packAuthenticationFlags acknowledgePackAuthenticationFlag refreshAnomalies acknowledgeAnomaly snoozeAnomaly digestOverview updateDigestSetting getPreferences updatePreferences
- **pharmacy-safety**: access controlledPharmacists branches controlledRegister recordCorrection createInspectionPack installSopLibrary setRetentionClass recordLegalHold legalHoldStatus approveRegisterIncident
- **pharmacy-sales**: manualPaymentSettings saveManualPaymentSettings sandboxPayment customerDirectory counterEvidence dailyCloseEvidence khataAccounts khataStatement closePreview closeDay customerSnapshot linkCustomer redeemPoints drawerStatus openDrawer drawerMovement closeDrawer dailyClose tenderOutcome tender refundTender create addLine transition lookupReceiptByNumber returnHistory returnLine captureDemand substituteProposals upsellSuggestions declineSubstitute acknowledgeDuplicateSalt recoverDemand demandAggregate addRestockInterest captureSafeRestockArrival optOutRestockInterest recoverRestockInterest restockRecoveryReport counterBranches counterSearch authenticatePack counterLotOptions counterCart counterReceipt counterReceiptPrintJob counterReceiptFormat counterSaveReceiptFormat counterKeymap counterSaveKeymap
- **pharmacy-sop** ★: access branches enableSite installLibrary templates assignments createAssignment setAssignmentActive roleHoldings setRoleHolding joinSite generate siteSettings setAutoSchedule startOnDemand board occurrence onDemandTemplates claim start completeStep linkRecord evidenceTarget linkableRecords addReworkNote submit verify reject report
- **pharmacy-staged-review**: pharmacyMedicine.stagedBranches pharmacyMedicine.stagedBatches pharmacyMedicine.stagedRows pharmacyMedicine.stagedDetail
- **pharmacy-supplier-compliance** ★: policy history skips setPolicy
- **pharmacy-supplier-links**: get submit uploadDocument createRelationship issue revoke recordManual approveProposal
- **platformAIUsage** (`platform-ai-usage.ts`) ★: currentMonth
- **platform-health**: overview
- **projects**: getAll create update delete addMember removeMember setMemberRole getById getBoardWithTasks setColumnDefaultAssignees createTask updateTask deleteTask moveTask bulkMoveTasks bulkDeleteTasks setTaskParent addBlocker removeBlocker createBoard deleteBoard reorderColumns createColumn updateColumn deleteColumn getTaskDetail addComment addTaskAttachment deleteTaskAttachment toggleChecklistItem createChecklist renameChecklist deleteChecklist addChecklistItem renameChecklistItem deleteChecklistItem updateTaskAssignees createMilestone updateMilestone deleteMilestone addFile getBoardLabels createLabel addLabelToTask removeLabelFromTask updateBoard updateLabel deleteLabel deleteFile updateComment deleteComment getTaskActivity logTime updateTimeEntry deleteTimeEntry listTaskTime getTimeRollup
- **resignations**: mine submit withdraw listAll review
- **restaurant-bills**: listBills getBill getOrderSettlement
- **restaurant-branches**: list create update setActive
- **restaurant-cameras**: availability presets list listGateways enrollGateway rotateGatewaySecret revokeGateway getRetentionState setRetention listRecordings issueStreamGrant testConnection configuredConnectionDiagnostics register
- **restaurant-cash**: listDrawerSessions getDrawerSession listDailyCloses getDailyClose
- **restaurant-catalog**: ensureDefaultBrand createBrand updateBrand setDefaultBrand setBrandStatus listBrands getBrand listCategories listProducts getProduct createCategory updateCategory deleteCategory createProduct updateProduct setProductStatus createVariant updateVariant deleteVariant createModifierGroup updateModifierGroup deleteModifierGroup createModifierOption updateModifierOption deleteModifierOption attachModifierGroup detachModifierGroup createComboGroup updateComboGroup deleteComboGroup createComboOption updateComboOption deleteComboOption attachProductAllergen detachProductAllergen createUnit updateUnit deleteUnit upsertConversion deleteConversion createAllergen updateAllergen deleteAllergen createIngredient updateIngredient attachIngredientAllergen detachIngredientAllergen createRecipe createRecipeVersion updateRecipeVersion activateRecipeVersion getActiveRecipeVersion getRecipeVersion listRecipeVersions getRecipeCost listRecipeCosts listRecipes createRecipeLine updateRecipeLine deleteRecipeLine addRecipeLineSubstitute removeRecipeLineSubstitute
- **restaurant-catering**: bookingLocations create update get list addLine updateLine removeLine addExtraCost removeExtraCost setDelivery productionRequirements costSummary setBooking setBranchCapacity bookingAvailability publishQuote approveQuote paymentSummary approvalHistory consumptionHistory quoteHistory recordDisposition transition
- **restaurant-customers**: list detail create correct attachToOrder appendInteraction appendConsent createTag listTags assignTag unassignTag export anonymize
- **restaurant-dashboard**: getPreferences updatePreferences
- **restaurant-delivery**: listCustomers listZones createZone updateZone deactivateZone reactivateZone listAddresses createAddress updateAddress setDefaultAddress deleteAddress
- **restaurant-devices**: initiatePrintBridgeEnrollment listPrinters registerPrinters renamePrinter retirePrinter list listApprovers initiateEnrollment revoke rotate
- **restaurant-floor**: access listFloors createFloor updateFloor deleteFloor createTable updateTable deleteTable listSections createSection updateSection deleteSection setSectionTables assignServer unassignServer listStations createStation updateStation setDefaultStation deleteStation createRoutingRule updateRoutingRule deleteRoutingRule
- **restaurant-growth**: list generate read review
- **restaurant-insights**: prepareClosePacket listOperationalReports readOperationalReport exportOperationalReports listFinancialReports readFinancialReport exportFinancialReports backfill importLabourCost listLabourCosts readLabourCost exportLabourCosts
- **restaurant-inventory**: createStockItem createStockLocation setStockLocationActive listStockOnHand listStockMovements createStockCount addStockCountLine submitStockCount postStockCount listStockCounts createStockTransfer addStockTransferLine completeStockTransfer listStockTransfers postWastage postSaleReversal createLowStockRule updateLowStockRule deleteLowStockRule evaluateLowStockRules listStockBatches
- **restaurant-jobs**: listJobs listExecutions listDeadLetters requeueDeadJob listOutbox listWebhookInbox
- **restaurant-loyalty**: listPrograms getProgram listAccounts getAccount enrollAccount listLedger getLedgerEntry configure adjust redeem
- **restaurant-menu-import**: uploadLimits list get summary upload reviewLine commit discard
- **restaurant-menus**: listMenus getMenu listPriceLists getPriceList listPublications getPublication listAvailabilityWindows listAvailabilityExceptions listItemOverrides createMenu updateMenu deleteMenu createSection updateSection deleteSection createItem updateItem deleteItem createPriceList createPriceListVersion activatePriceListVersion supersedePriceListVersion addPriceEntry updatePriceEntry removePriceEntry createPublication publishPublication retirePublication setPublicationChannels addAvailabilityWindow removeAvailabilityWindow setAvailabilityException removeAvailabilityException setItemOverride clearItemOverride effectiveMenu
- **restaurant-notifications**: list unreadCount markRead markAllRead getMatrix updateMatrix webhookStatus configureWebhook deleteWebhook testWebhook retryWebhook
- **restaurant-orders**: listOrders getOrder listKitchenTickets open addItem adjustItem removeItem send fireCourse holdCourse advanceItem requestRemake voidItem cancel close moveTable mergeTables unlinkTable
- **restaurant-payments**: getTerminalConfig saveTerminalConfig listTerminalReconciliations listTenders listRefunds getPayment getTenderTypeTotals
- **restaurant-promotions**: list pickerOptions assertBranchAccess createOffer editOffer disableOffer
- **restaurant-purchasing**: listSuppliers getSupplier createSupplier updateSupplier setSupplierActive listPurchaseOrders getPurchaseOrder getReceipt createPurchaseOrder addPurchaseOrderLine updatePurchaseOrderLine removePurchaseOrderLine submitPurchaseOrder approvePurchaseOrder cancelPurchaseOrder closePurchaseOrder receivePurchaseOrder createSupplierReturn
- **restaurant-reports**: branches overview payments financialComparison foodCost dishProfitability catering inventory stockLocations wastage stockMovements purchasing workforce workforceFinancial sop exportCsv
- **restaurant-shifts**: list create update cancel myRoster managerRoster swapCandidates clockIn startBreak endBreak clockOut requestSwap reviewSwap correctTime exportAttendanceCsv
- **restaurant-sop**: createTemplate updateTemplate setTemplateActive listTemplates getTemplate createDraftVersion publishVersion retireVersion listVersions getVersion addStep updateStep removeStep reorderSteps createAssignment updateAssignment setAssignmentActive listAssignments getAssignment previewSchedule previewAssignmentSchedule listAssignableJobRoles listPacks installPack installAllPacks listClaimablePool listMySopOccurrences claimOccurrence listEscalationPolicies getEscalationPolicy createEscalationPolicy updateEscalationPolicy setEscalationPolicyActive upsertEscalationStep removeEscalationStep scoreReport listRecentOccurrences occurrenceAuditTrail
- **restaurant-sop-execution**: reportBranches report listOccurrences getOccurrence claim start completeStep attachEvidence submit verify reject waive acknowledge
- **restaurant-staff**: mySelfProfile provisionMyProfile listBranches listDirectory listEligibleUsers list create update setStatus listCredentials issueCredential rotateCredential revokeCredential listJobRoles seedDefaultJobRoles createJobRole updateJobRole setJobRoleCapabilities listStaffJobRoles setStaffJobRoles setStaffAccess listStaffJobRoleAudit setStaffCapabilityOverride clearStaffCapabilityOverride listStaffCapabilityOverrides listStaffCapabilityAudit resolveStaffCapabilities listRoleHolders
- **restaurant-tax**: publishServiceCharge endServiceCharge previewCustom configuration publishCustom scheduleEnd activate
- **reviews**: createCycle listCycles closeCycle reopenCycle addReview submitReview listReviews myReviews
- **search**: global
- **team**: getAll getRoster inviteMember getById getLeaveRequests createLeaveRequest cancelLeaveRequest updateLeaveRequest updateLeaveStatus setLeaveBalance getLeaveBalances getTeamLeaveCalendar getNotifications markNotificationRead markAllNotificationsRead updateProfile changePassword signOutEverywhere mySignIns getNotificationPrefs updateNotificationPrefs adminUpdateMember adminResetPassword layOffMember listPerformanceNotes addPerformanceNote deletePerformanceNote getHrOverview
- **team-stats**: getAll getForUser
- **trello-import**: importBoard
- **two-factor**: getStatus beginEnrollment confirmEnrollment disable recoveryStatus
- **webhooks**: list recentDeliveries create update delete

## Appendix B. Pages (`src/app`, 140)

- (app)/api-docs
- (app)/audit-logs
- (app)/chat
- (app)/clients
- (app)/clients/[id]
- (app)/dashboard
- (app)/email
- (app)/email/oauth/callback
- (app)/finance
- (app)/finance/invoices/[id]/print
- (app)/hotel/settings/extras
- (app)/hotel/settings/journey
- (app)/hotel/settings/meal-plans
- (app)/hotel/settings/property
- (app)/hotel/settings/rooms
- (app)/hotel/settings/spaces
- (app)/hr
- (app)/meetings
- (app)/meetings/[id]
- (app)/meetings/[id]/call
- (app)/notes
- (app)/notes/[id]
- (app)/organization
- (app)/pharmacy
- (app)/pharmacy/accounts/account-activity-bridge
- (app)/pharmacy/accounts/account-code-reference
- (app)/pharmacy/accounts/balance-sheet
- (app)/pharmacy/accounts/cash-flow
- (app)/pharmacy/accounts/cheque-maturity
- (app)/pharmacy/accounts/fiscal-exceptions
- (app)/pharmacy/accounts/journal-entry-lookup
- (app)/pharmacy/accounts/journal-evidence-export
- (app)/pharmacy/accounts/profit-loss
- (app)/pharmacy/accounts/tax-profile-review
- (app)/pharmacy/accounts/trial-balance-control
- (app)/pharmacy/cameras
- (app)/pharmacy/controlled-register
- (app)/pharmacy/counter
- (app)/pharmacy/counter/close
- (app)/pharmacy/finance
- (app)/pharmacy/inventory
- (app)/pharmacy/inventory/expiry
- (app)/pharmacy/inventory/import
- (app)/pharmacy/inventory/imports
- (app)/pharmacy/inventory/transfers
- (app)/pharmacy/loyalty
- (app)/pharmacy/marketing
- (app)/pharmacy/medicines
- (app)/pharmacy/medicines/prices
- (app)/pharmacy/medicines/staged
- (app)/pharmacy/orders
- (app)/pharmacy/pharmacist-queue
- (app)/pharmacy/prescriptions
- (app)/pharmacy/purchasing
- (app)/pharmacy/purchasing/orders
- (app)/pharmacy/purchasing/receiving
- (app)/pharmacy/purchasing/returns
- (app)/pharmacy/purchasing/suppliers
- (app)/pharmacy/regulatory
- (app)/pharmacy/regulatory/fbr-tier-1
- (app)/pharmacy/reports
- (app)/pharmacy/reports/branch-comparison
- (app)/pharmacy/reports/repeat-purchasing
- (app)/pharmacy/reports/replenishment
- (app)/pharmacy/reports/supplier-credit-follow-up
- (app)/pharmacy/settings/branches
- (app)/pharmacy/settings/cameras/privacy
- (app)/pharmacy/sop ★ new
- (app)/pharmacy/substitution
- (app)/projects
- (app)/projects/[id]
- (app)/projects/[id]/board/[boardId]
- (app)/projects/import
- (app)/restaurant
- (app)/restaurant/catalog
- (app)/restaurant/catering
- (app)/restaurant/delivery
- (app)/restaurant/devices
- (app)/restaurant/floor
- (app)/restaurant/growth
- (app)/restaurant/insights
- (app)/restaurant/integrations/cameras
- (app)/restaurant/inventory
- (app)/restaurant/loyalty
- (app)/restaurant/menu-import
- (app)/restaurant/menus
- (app)/restaurant/money
- (app)/restaurant/notifications
- (app)/restaurant/orders
- (app)/restaurant/promotions
- (app)/restaurant/purchasing
- (app)/restaurant/reports
- (app)/restaurant/settings/branches
- (app)/restaurant/settings/cameras/privacy
- (app)/restaurant/sop
- (app)/restaurant/sop/admin
- (app)/restaurant/sop/oversight
- (app)/restaurant/sop/reports
- (app)/restaurant/staff
- (app)/restaurant/staff/roster
- (app)/restaurant/tax
- (app)/reviews
- (app)/settings
- (app)/settings/receipts
- (app)/team
- (app)/team/[id]
- (app)/team/stats
- (public)/wallet/join/[token]
- (terminal)/kds
- (terminal)/pos
- .
- brand
- brand/preview
- change-password
- demo/restaurants
- forgot-password
- invite/[token]
- login
- login/register
- login/till
- meet/[publicId]
- platform/(auth)/login
- platform/(console)
- platform/(console)/audit
- platform/(console)/catalog
- platform/(console)/commercial
- platform/(console)/crm
- platform/(console)/deployments
- platform/(console)/health
- platform/(console)/jobs
- platform/(console)/operators
- platform/(console)/organizations
- platform/(console)/organizations/[id]
- platform/(console)/organizations/new
- platform/(console)/settings
- platform/(console)/support
- reset-password/[token]
- sso/complete
- supplier/po/[token]
- terminal

## Appendix C. API routes (139)

- (app)/pharmacy/accounts/fiscal-exceptions/csv
- (app)/pharmacy/accounts/tax-profile-review/export
- api/ably-token
- api/assistant
- api/auth/[...nextauth]
- api/cron/demo-restaurants
- api/cron/outbound-effects
- api/files/[name]
- api/health
- api/live
- api/login
- api/meetings/webhooks/livekit
- api/password-reset
- api/pharmacy/cameras/[cameraId]/stream ★ new
- api/pharmacy/counter/establish
- api/pharmacy/counter/lease
- api/pharmacy/counter/quota
- api/pharmacy/counter/replay
- api/pharmacy/counter/snapshot
- api/pharmacy/prescription-files
- api/pharmacy/print
- api/pharmacy/sop/evidence ★ new
- api/pharmacy/whatsapp/khata-reminders
- api/pharmacy/whatsapp/reminders
- api/pharmacy/whatsapp/webhook
- api/platform/control
- api/platform/jobs/process
- api/platform/mfa
- api/platform/session
- api/platform/support
- api/platform/workspace-requests/[id]
- api/ready
- api/restaurant/cameras/[cameraId]/stream
- api/restaurant/cash/day/close
- api/restaurant/cash/day/correct
- api/restaurant/cash/day/current
- api/restaurant/cash/day/preview
- api/restaurant/cash/drawer/close
- api/restaurant/cash/drawer/current
- api/restaurant/cash/drawer/movement
- api/restaurant/cash/drawer/open
- api/restaurant/catering/money
- api/restaurant/checkout/bill
- api/restaurant/checkout/comp
- api/restaurant/checkout/loyalty
- api/restaurant/checkout/receipt
- api/restaurant/checkout/refund
- api/restaurant/checkout/summary
- api/restaurant/checkout/tender
- api/restaurant/devices/browser-enroll
- api/restaurant/kds/ack
- api/restaurant/kds/bump
- api/restaurant/kds/delivery/queue
- api/restaurant/kds/delivery/transition
- api/restaurant/kds/operators
- api/restaurant/kds/queue
- api/restaurant/kds/recall
- api/restaurant/orders/add-item
- api/restaurant/orders/cancel
- api/restaurant/orders/close
- api/restaurant/orders/commercial-terms
- api/restaurant/orders/customer/attach
- api/restaurant/orders/customer/by-wallet
- api/restaurant/orders/customer/search
- api/restaurant/orders/delivery/addresses
- api/restaurant/orders/delivery/attach
- api/restaurant/orders/delivery/zones
- api/restaurant/orders/detail
- api/restaurant/orders/effective-menu
- api/restaurant/orders/fire
- api/restaurant/orders/hold
- api/restaurant/orders/mark-served
- api/restaurant/orders/merge-tables
- api/restaurant/orders/move-table
- api/restaurant/orders/open
- api/restaurant/orders/open-orders
- api/restaurant/orders/remake
- api/restaurant/orders/reprint-kot
- api/restaurant/orders/void
- api/restaurant/print-bridge
- api/restaurant/print-bridge/enroll
- api/restaurant/receipt-layout
- api/restaurant/reports/export
- api/restaurant/sop/evidence
- api/restaurant/terminal/co-authorize
- api/restaurant/terminal/establish
- api/restaurant/terminal/heartbeat
- api/restaurant/terminal/layout
- api/restaurant/terminal/lock
- api/restaurant/terminal/operators
- api/restaurant/terminal/renew-composer-proof
- api/restaurant/terminal/switch
- api/restaurant/terminal/unlock
- api/restaurant/webhooks/[source]
- api/scim/v2/Groups
- api/scim/v2/Groups/[id]
- api/scim/v2/ResourceTypes
- api/scim/v2/Schemas
- api/scim/v2/ServiceProviderConfig
- api/scim/v2/Users
- api/scim/v2/Users/[id]
- api/sso/oidc/[connectionId]/callback
- api/sso/oidc/[connectionId]/start
- api/sso/saml/[connectionId]/callback
- api/sso/saml/[connectionId]/metadata
- api/sso/saml/[connectionId]/start
- api/support-session
- api/support-session/launch
- api/trpc/[trpc]
- api/upload
- api/v1/boards/[id]
- api/v1/clients
- api/v1/clients/[id]
- api/v1/finance/summary
- api/v1/invoices
- api/v1/invoices/[id]
- api/v1/meetings
- api/v1/projects
- api/v1/projects/[id]
- api/v1/spec
- api/v1/tasks
- api/v1/tasks/[id]
- api/v1/tasks/[id]/comments
- api/v1/team
- api/v1/transactions
- api/v1/transactions/[id]
- api/wallet/apple/v1/devices/[deviceLibraryIdentifier]/registrations/[passTypeIdentifier]
- api/wallet/apple/v1/devices/[deviceLibraryIdentifier]/registrations/[passTypeIdentifier]/[serialNumber]
- api/wallet/apple/v1/log
- api/wallet/apple/v1/passes/[passTypeIdentifier]/[serialNumber]
- api/wallet/enroll/start
- api/wallet/enroll/verify
- api/workspace-requests
- demo/restaurants/access
- demo/restaurants/device-session
- demo/restaurants/reset
- demo/restaurants/seats
- login/submit
- meet/[publicId]/admit

## Appendix D. Prisma models by area (491 models, 271 enums)

New since `47518cbf` (+11 models, +4 enums, none removed): `AIAssistantAction`, `AIBudgetAlertMonth`, `AIModelPrice`, `AIProviderUsage`, `AISetting`, `PlatformNotification`, `PharmacySopSite`, `PharmacySopSiteSetting`, `PharmacySopEvidenceCapture`, `PharmacySopRecordLink`, `PharmacySopReworkNote`; enums `AIAssistantActionStatus`, `AISettingsMode`, `PharmacySopCaptureSource`, `PharmacySopRecordType`.

- **Platform\* (24)**: PlatformCameraBrandPreset PlatformUser PlatformNotification PlatformRecoveryCode PlatformSession PlatformSetting PlatformModule PlatformPackage PlatformPackageModule PlatformAccount PlatformLead PlatformContact PlatformOpportunity PlatformOpportunityStageEvent PlatformProposal PlatformFollowUp PlatformContract PlatformContractModule PlatformInvoice PlatformPayment PlatformRenewal PlatformJob PlatformSupportSession PlatformAuditLog
- **Organization\* (16)**: Organization OrganizationModule OrganizationLimit OrganizationUsageCounter OrganizationRole OrganizationDepartment OrganizationRolePermission OrganizationBrand OrganizationEmailSettings OrganizationDomain OrganizationIdentityConnection OrganizationSsoState OrganizationScimToken OrganizationScimEvent OrganizationDeployment OrganizationLifecycleEvent
- **Pharmacy\* (152)**: PharmacyBranch PharmacyBranchAssignment PharmacySopSite PharmacySopRecordLink PharmacySopEvidenceCapture PharmacySopSiteSetting PharmacySopReworkNote PharmacyCentralPurchasingAccess PharmacyCentralPurchaseAllocation PharmacyOnboardingState PharmacyOnboardingGateState PharmacyOnboardingEvent PharmacyReferenceConnector PharmacyReferenceConnectorRun PharmacyReferenceConnectorProposal PharmacyFiscalConfiguration PharmacyFiscalDocument PharmacyFiscalDocumentEvent PharmacySale PharmacyCustomer PharmacyFamilyAccount PharmacyFamilyMember PharmacyKhataEvent PharmacyKhataLimitDecision PharmacyLoyaltyPointsEntry PharmacyMoneyIdempotencyKey PharmacyTender PharmacyRefund PharmacyDrawerSession PharmacyDrawerMovement PharmacyDailyClose PharmacyReceiptNumberSequence PharmacyCounterKeymapPreference PharmacySaleLine PharmacySaleLineAllocation PharmacySaleEvent PharmacySaleReturn PharmacySaleReturnLine PharmacyUnidentifiedReturnHold PharmacyReturnVerificationTask PharmacyRestockInterest PharmacyRestockReservation PharmacyRestockNotification PharmacyCustomerOrder PharmacyCustomerOrderLine PharmacyCustomerOrderEvent PharmacyStockLocation PharmacyTemperatureLog PharmacyManufacturingBatch PharmacyInventoryLot PharmacyInventoryCount PharmacyInventoryCountLine PharmacyInterbranchTransfer PharmacyInterbranchTransferLine PharmacyRecallNotice PharmacyDrapIngest PharmacyPriceChangeProposal PharmacyRecallQuarantineAction PharmacyRecallAcknowledgement PharmacyCustodyRecord PharmacySupplierClaim PharmacyAllocationOverride PharmacyStockMovement PharmacyStockBalance PharmacyStockDiscrepancy PharmacyBookkeepingTransaction PharmacyBookkeepingAllocation PharmacyAccountingPeriod PharmacySettlementBatch PharmacySettlementTender PharmacyBankStatementLine PharmacyBankReconciliation PharmacyTaxProfileVersion PharmacyTaxRuleVersion PharmacyMigrationSource PharmacyMigrationBatch PharmacyMigrationRow PharmacyMigrationException PharmacySupplier PharmacySupplierLicence PharmacyRequisition PharmacyRequisitionLine PharmacyQuote PharmacyQuoteLine PharmacyPurchaseOrder PharmacyPurchaseOrderLine PharmacyPurchaseOrderApproval PharmacySupplierRelationship PharmacySupplierActionLink PharmacySupplierSubmission PharmacySupplierDocument PharmacySupplierSubmissionApproval PharmacyPatient PharmacyPrescriber PharmacyPharmacovigilanceReport PharmacyRefillReminderCapture PharmacyPharmacistReviewItem PharmacyPharmacistReviewDecision PharmacySubstitutionRecord PharmacyControlledRegisterEntry PharmacyRegisterIncident PharmacyRegisterIncidentApproval PharmacyEmergencyRxFollowUp PharmacyGoodsReceipt PharmacyGoodsReceiptLine PharmacyReceivingException PharmacyPurchaseReturn PharmacyPurchaseReturnLine PharmacyDebitNote PharmacySupplierCredit PharmacySupplierCreditAllocation PharmacySafetyStock PharmacyStockSignal PharmacyStockSignalEvent PharmacyStockSignalAction PharmacyMaterialityThreshold PharmacyOpeningSession PharmacyOpeningStockLine PharmacyOpeningException PharmacyOpeningTotal PharmacyOpeningLedgerEntry PharmacyParallelRunWindow PharmacyParallelRunDailyEntry PharmacyParallelRunComparison PharmacyLegacyArchive PharmacyCutoverEvent PharmacyRetentionClass PharmacyLegalHoldEvent PharmacyRegisteredDevice PharmacyOfflineSnapshot PharmacyOfflineCommand PharmacyReceiptNumberLease PharmacyDeviceLotQuota PharmacyOwnerDigestSetting PharmacyOwnerDigestCapture PharmacyMarketingSegment PharmacyMarketingTemplate PharmacyCampaign PharmacyCampaignCapture PharmacyCampaignExclusion PharmacyCampaignAttribution PharmacyAnomalySignal PharmacyAnomalySignalEvent PharmacyPackAuthenticationScan PharmacyPackAuthenticationEvent PharmacyGrowthReview PharmacyCampaignDeliveryEvent PharmacyCampaignDispatchAttempt PharmacyMessageLog PharmacyWhatsAppConsentArchive PharmacyOrderDeliveryEvidence PharmacyPackPrice
- **Restaurant\* (164)**: RestaurantCameraGateway RestaurantCameraCredential RestaurantCamera RestaurantCameraStreamGrant RestaurantActivationAcknowledgement RestaurantBranch RestaurantTaxOfficialSource RestaurantTaxProfileVersion RestaurantTaxRuleVersion RestaurantTaxTransactionSnapshot RestaurantTaxRateBucketSnapshot RestaurantTaxTenderAllocationSnapshot RestaurantTaxRefundAllocation RestaurantTerminalProviderConfig RestaurantTerminalReconciliation RestaurantBranchAssignment RestaurantStaffProfile RestaurantOperatorCredential RestaurantRegisteredDevice RestaurantTerminalSession RestaurantCoAuthorization RestaurantBrand RestaurantCategory RestaurantProduct RestaurantProductVariant RestaurantModifierGroup RestaurantModifierOption RestaurantProductModifierGroup RestaurantComboComponentGroup RestaurantComboComponentOption RestaurantUnit RestaurantUnitConversion RestaurantAllergen RestaurantProductAllergen RestaurantIngredientAllergen RestaurantIngredient RestaurantRecipe RestaurantRecipeVersion RestaurantRecipeLine RestaurantRecipeLineSubstitute RestaurantPriceList RestaurantPriceListVersion RestaurantPriceListEntry RestaurantMenu RestaurantMenuSection RestaurantMenuItem RestaurantBranchMenuPublication RestaurantMenuAvailabilityWindow RestaurantMenuAvailabilityException RestaurantBranchMenuItemOverride RestaurantFloor RestaurantTable RestaurantServerSection RestaurantServerSectionTable RestaurantServerSectionAssignment RestaurantKitchenStation RestaurantPrintRoute RestaurantPrintJob RestaurantStationRoutingRule RestaurantOrder RestaurantOrderItem RestaurantOrderItemModifier RestaurantOrderTable RestaurantOrderEvent RestaurantEventOutbox RestaurantOrderIdempotencyKey RestaurantKitchenTicket RestaurantKitchenTicketItem RestaurantOrderNumberSequence RestaurantBill RestaurantBillLine RestaurantPayment RestaurantPaymentEvent RestaurantTender RestaurantRefund RestaurantServiceChargePolicyVersion RestaurantDrawerSession RestaurantDrawerMovement RestaurantDailyClose RestaurantDailyCloseTenderTotal RestaurantReceiptNumberSequence RestaurantMoneyIdempotencyKey RestaurantStockLocation RestaurantStockItem RestaurantStockMovement RestaurantStockBatch RestaurantStockCount RestaurantStockCountLine RestaurantStockTransfer RestaurantStockTransferLine RestaurantLowStockRule RestaurantSupplier RestaurantPurchaseOrder RestaurantPurchaseOrderLine RestaurantPurchaseReceipt RestaurantPurchaseReceiptLine RestaurantReceivingDiscrepancy RestaurantInventoryIdempotencyKey RestaurantJob RestaurantJobExecution RestaurantWebhookInbox RestaurantSopTemplate RestaurantSopTemplateVersion RestaurantSopTemplateStep RestaurantSopAssignment RestaurantSopOccurrence RestaurantSopOccurrenceStep RestaurantSopEvidence RestaurantSopVerification RestaurantSopEscalationPolicy RestaurantSopEscalationStep RestaurantSopEscalationEvent RestaurantJobRole RestaurantJobRoleCapability RestaurantStaffJobRole RestaurantStaffCapabilityGrant RestaurantStaffCapabilityAudit RestaurantStaffJobRoleAudit RestaurantNotification RestaurantNotificationChannelSetting RestaurantNotificationWebhook RestaurantNotificationDelivery RestaurantCustomer RestaurantDeliveryZone RestaurantCustomerAddress RestaurantCateringOrder RestaurantCateringOrderLine RestaurantCateringExtraCost RestaurantCateringDelivery RestaurantCateringEvent RestaurantDeliveryFulfillment RestaurantMenuImport RestaurantMenuImportPage RestaurantMenuImportLine RestaurantPromotion RestaurantPromotionVersion RestaurantPromotionRuleComponent RestaurantPromotionEvaluationSnapshot RestaurantPromotionCandidateSnapshot RestaurantPromotionApplicationSnapshot RestaurantPromotionUnitAllocation RestaurantPromotionBillApplicationSnapshot RestaurantPromotionCapCounter RestaurantPromotionCapReservation RestaurantPromotionAuditEvent RestaurantShift RestaurantShiftBreak RestaurantShiftSwapRequest RestaurantShiftSwapDecision RestaurantShiftEvent RestaurantTimeAdjustment RestaurantWorkforceCommand RestaurantCateringBranchCapacity RestaurantCateringQuoteRevision RestaurantCateringQuoteApproval RestaurantCateringDisposition RestaurantCateringCommand RestaurantGrowthReview RestaurantGrowthDraft RestaurantGrowthFixture RestaurantGrowthAttempt RestaurantGrowthReceiptEvent RestaurantPrintBridgeEnrollmentCode RestaurantPrinter
- **Hotel\* (12)**: HotelProperty HotelPropertyAssignment HotelExtra HotelRoomType HotelRoom HotelBed HotelRoomStatusEvent HotelRoomBlock HotelMealPlan HotelFunctionSpace HotelSpaceBooking HotelJourneyTemplate
- **AI\* (6)**: AIBudgetAlertMonth AISetting AIModelPrice AIProviderUsage AIUsage AIAssistantAction
- **Shared / agency / other (117)**: JurisdictionRuleSet BranchRegulatoryProfile Ingredient Medicine MedicineStrengthComponent Presentation PackLevel MedicinePackMrp MedicineProvenance MedicineBarcode MedicineAlias MedicineReviewDecision MedicinePublicationBatch MedicinePublicationEntry UnfulfilledDemandEvent User Resignation Invitation PasswordResetToken ReviewCycle Review Client ClientContact Contract Project ProjectMember Board Column ColumnDefaultAssignee Label Task TaskBlocker TaskAssignee TaskLabel TaskChecklist TaskChecklistItem TaskComment TaskAttachment TimeEntry Invoice Payment Transaction RecurringExpense FinanceJournalEntry FinanceJournalLine Channel ChannelMember Message MessageEdit MessageAttachment MessageReaction MessageMention PinnedMessage SavedMessage LeaveRequest PerformanceNote Document ProjectFile Milestone Activity Notification AuditLog Meeting MeetingAttendee MeetingAttendanceLog MeetingOccurrence MeetingParticipant MeetingOccurrenceParticipant MeetingParticipantSession MeetingProviderEvent MeetingEntityLink ApiToken Note NoteRevision LeaveBalance Webhook WebhookDelivery TwoFactorRecoveryCode NoteMention NoteShare NoteLink Mailbox EmailMessage CustomerIdentifier CustomerInteraction CustomerTag CustomerTagAssignment CustomerConsent LoyaltyProgramVersion LoyaltyAccount LoyaltyPointsEntry InsightDailyRollup InsightLoyaltyLiability InsightItemMixRollup LabourCostFact PendingLoginIntent UserPermissionOverride TenantSsoTicket PatientConsent Prescription PrescriptionLine PrescriptionFill CateringMoneyEvidence GrowthInsight Camera CameraCredential CameraEvidence CameraGateway CameraStreamGrant WalletPass WalletPassRegistration WalletPassUpdate WalletTenantConfig WalletEnrollmentLink WalletEnrollmentAttempt RateLimitBucket OutboundEffect

## Appendix E. All 378 open PRs, grouped by section (keyword-classified from the title and branch, so check borderline ones; fetched 10 Nov 2026)


### 1-platform (14)
- #22 `fix/sec-164-followups` → `integration/consolidation-20261019`: fix(security): #164 follow-ups — changePassword rate limit/audit, seat lock on all user paths, central PASSWORD_CHANGE_REQUIRED
- #37 `fix/qa-362` (draft): Inventory write-off witnessId isn't validated as a real active tenant user (#362)
- #133 `codex/fix-11`: fix(#11): [P2][Admin] Audit ledger shows raw actor IDs, cannot be searched by actor, and silently tr
- #149 `codex/fix-169`: fix(#169): [Platform][sev4] JWT session cookie is reissued on every session read
- #167 `codex/fix-511`: fix(#511): [sev3] organization.create can overwrite any CRM opportunity/account conversion without CR
- #171 `codex/fix-592`: fix(#592): [sev3] Platform: tenant audit_logs is not append-only (UPDATE/DELETE allowed within tenant
- #254 `codex/fix-335`: fix(#335): Comp button shown to operators without orders:complimentary
- #864 `cloud/issue-314`: fix(#314): [QA][P2][Admin] Audit ledger shows raw actor IDs, cannot be searched by actor, and silently truncates at 500 rows
- #1066 `codex/DEV-343-command-validation` (draft): DEV-343: Sanitize platform command validation errors
- #1067 `codex/DEV-342-sanitize-prisma-errors` (draft): DEV-342: Sanitize Prisma errors on stale tenant writes
- #1101 `codex/DEV-198-day-close-currency` (draft): DEV-198: Use tenant currency in day-close tender totals
- #1174 `codex/dev-284-local-recovery-20261102` (draft): DEV-284: share dedicated provisioning validation
- #1175 `codex/dev-327-local-recovery-20261102` (draft): DEV-327: Name the platform home logo link
- #1223 `saad/nice-thompson-99m17p`: Fix the claude-labelled Linear QA batch (audit ledger, meetings, seed/env, auth contrast, operator reset, custody witness, docs)

### 2-core (73)
- #8 `improve/ai-growth-g6` → `improve/ai-growth-g1`: Growth G6: Weekly AI campaign planner
- #9 `improve/ai-growth-g7` → `improve/ai-growth-g1`: Growth G7: Churn win-back automation
- #11 `improve/ai-growth-g10` → `improve/ai-growth-g1`: Growth G10: Review requests and referrals
- #23 `fix/migration-rls-218` → `integration/consolidation-20261019`: fix(db): repair migrations silently no-op under forced RLS (#218)
- #26 `fix/qa-302` → `integration/consolidation-20261019`: Fix #302 (codex cloud)
- #31 `fix/qa-340` → `integration/consolidation-20261019`: Fix #340 (codex cloud)
- #32 `fix/qa-342` → `integration/consolidation-20261019`: Fix #342 (codex cloud)
- #34 `fix/qa-345` → `integration/consolidation-20261019`: Fix #345 (codex cloud)
- #36 `fix/qa-360` → `integration/consolidation-20261019`: team.invite seat check has no lock or recount, so concurrent invites can exceed the seat limit (#360)
- #38 `fix/qa-363` → `integration/consolidation-20261019`: Stock count approval has no lock; different idempotency prefixes can apply the variance twice (#363)
- #41 `fix/qa-361` → `integration/consolidation-20261019`: Resending an invite while an old-token accept is mid-hash lets the old request claim the new row (#361)
- #49 `fix/qa-355` → `integration/consolidation-20261019`: Fix #355 (HOLD - do not merge)
- #53 `r5/r5-245-caps` → `bots/post-hire-work`: r5: #245 canonical capability repair
- #63 `port/consolidation-20261019`: port: consolidation-20261019 (from Mac archive)
- #65 `feat/ai-wa-selfhosted-stub` → `integration/consolidation-20261019`: feat: DevFathom AI 6/22 wa-selfhosted-stub
- #104 `codex/fix-257`: fix(#257): Show password toggle has tabindex -1
- #105 `codex/fix-258`: fix(#258): Reminder quiet-hour skips counted as skippedNoConsent; weekly dedupe key uses UTC epoch we
- #140 `codex/fix-639`: fix(#639): [sev2] AI routing: no seeded model prices and a provider-wide $3/$15 fallback make the Ant
- #144 `codex/fix-4`: fix(#4): [P3][UI] Studio token migration is incomplete — duplicate :root scales, live legacy abys
- #146 `codex/fix-7`: fix(#7): [P2][Admin] Documented local setup cannot work — seed and prisma.config read .env only, 
- #154 `codex/fix-336`: fix(#336): [sev3] AI assistant inviteMember tool skips the seat-limit check, so the assistant can inv
- #197 `codex/fix-529`: fix(#529): Refunds: Refunded partial tenders still count toward final settlement
- #212 `codex/fix-567`: fix(#567): SOP verification: A verifier can invent the second identity for an SOP waiver
- #253 `codex/fix-222`: fix(#222): Dark-theme info status pill nearly invisible on branch settings
- #259 `codex/fix-539`: fix(#539): Tax quotation: Multi-quantity previews round tax differently from settlement
- #261 `codex/fix-554`: fix(#554): SOP escalation: Configured escalation policies never receive production jobs
- #274 `codex/fix-507`: fix(#507): `team.getRoster` bypasses an explicit `team:view` denial
- #286 `recover/followup-rgap-jobs` (draft): recover: dead-letter exhausted stale jobs; idempotent dead-job requeue
- #683 `sec/codex-h1`: fix(security): Codex scan HIGH h1
- #685 `sec/codex-h4`: fix(security): Codex scan h4
- #812 `cloud/issue-381`: fix(#381): Licence invalid 00:00–04:59 PKT on its start day; profile effective today shows as scheduled until 05:00
- #853 `cloud/issue-568`: fix(#568): [QA][sev2] Daily close: Future dates can be closed before trading begins
- #862 `cloud/issue-308`: fix(#308): [QA][P3][UI] Studio token migration is incomplete — duplicate :root scales, live legacy abyss/brass utilities, and controls that bypass the radius scale
- #875 `cloud/issue-371`: fix(#371): No way to reverse a mistaken comp; recut locked after any tender
- #882 `cloud/issue-383`: fix(#383): #282 pg_trgm grant migration grants nothing when the migrator doesn't own the extension
- #886 `cloud/issue-429`: fix(#429): [QA][sev3] Resending an invite while an old-token accept is mid-hash lets the old request claim the new row
- #902 `cloud/issue-551`: fix(#551): [QA][sev3] Persisted role grants bypass mandatory resignation-review resource constraints
- #903 `cloud/issue-572`: fix(#572): [QA][sev3] Tax profiles: Preset effective dates start at UTC midnight instead of branch midnight
- #963 `salvage/growth-g1-followup` (draft): chore: Growth G1 models follow-up (salvage; likely superseded)
- #988 `inky/code-scanning-fixes`: security: fix code-scanning alerts #9, #6 and #7
- #997 `fix/returns-lookup-scope`: fix(returns): scope receipt lookup to the cashier's branches
- #999 `fix/owner-copy-sweep`: fix(ui): owner copy sweep, remove internal codes and jargon
- #1000 `fix/team-members-zero`: fix(team): Team shows 0 members when users exist
- #1002 `feat/reports-csv-export`: feat(reports): CSV export for reports, gated by reports:financial
- #1004 `fix/dark-mode-tokens`: fix(ui): dark-mode theme tokens for borders, primary button edge, toggles, links and active tab
- #1007 `fix/af-tool-choice-auto`: feat(ask-fathom): remove forced requestLeave tool_choice
- #1052 `codex/linear-mention-dev-168-qa]-sev2]-printing-read-only-user` (draft): fix(printing): prevent read-only users from fabricating print jobs
- #1060 `codex/linear-mention-dev-170-qa]-sev2]-shifts-cancelling-an-in` (draft): test: prevent cancelling shifts with active attendance
- #1062 `codex/linear-mention-dev-169-qa]-sev2]-workforce-shift-swaps-c` (draft): fix(workforce): prevent shift swaps from transferring attendance
- #1064 `codex/linear-mention-dev-177-qa]-sev2]-devices-device-revocati` (draft): fix(devices): enforce dedicated revoke capability
- #1114 `codex/DEV-145-review-assertion-limit` (draft): DEV-145: Cover the review assertion limit
- #1117 `codex/DEV-118-profit-loss-coverage` (draft): DEV-118: Expose profit and loss classification coverage
- #1118 `codex/DEV-117-balance-sheet-coverage` (draft): DEV-117: Qualify balance sheet reconciliation coverage
- #1157 `codex/dev-62-recover-20261102` (draft): DEV-62: Add report date controls and accurate import reference labels
- #1158 `codex/dev-34-recover-20261102` (draft): DEV-34: Reserve space for two-line login errors
- #1160 `codex/dev-98-recover-20261102` (draft): DEV-98: Configure emergency-supply caps by jurisdiction
- #1166 `codex/dev-52-recover-20261102` (draft): DEV-52: Scope command search to licensed categories
- #1176 `codex/dev-167-local-recovery-20261102` (draft): DEV-167: Guard activity transaction completion without outbox draining
- #1177 `codex/dev-150-local-recovery-20261102` (draft): DEV-150: Verify bilingual order confirmation facts
- #1179 `codex/dev-154-local-recovery-20261102` (draft): DEV-154: Isolate webhook test key (partial recovery)
- #1183 `codex/dev-214-local-recovery-20261102` (draft): DEV-214: Record WHA-66 archive recovery decision
- #1184 `codex/dev-213-local-recovery-20261102` (draft): DEV-213: Resolve archived white UI recovery
- #1187 `codex/dev-178-local-recovery-20261102` (draft): DEV-178: Centralize administrator session cookie cleanup for enrollment
- #1188 `codex/dev-230-local-recovery-20261102` (draft): DEV-230: record obsolete security archive disposition
- #1189 `codex/dev-320-local-recovery-20261102` (draft): DEV-320: restore readable mobile settled receipts
- #1190 `codex/dev-193-local-recovery-20261102` (draft): DEV-193: share admitted meeting provider identity contract
- #1194 `codex/dev-272-local-recovery-20261102` (draft): DEV-272: restore constant API error logging format
- #1363 `codex/dev-713-manual-tenders` (draft): DEV-713: Manual wallet tenders and adapter-only card payments
- #1370 `codex/dev-6-inventory-banner` (draft): DEV-6: [Sev4] Inventory success banner is unreadable (dark text on dark green)
- #1383 `codex/dev-628-writeoff-witness` (draft): DEV-628: [QA][Sev2] Inventory: write-off "co-authorising witness" is picked from a list and never confirms
- #1413 `saad/clever-faraday-krx771`: DEV-739: Repair shared develop test failures (5 product fixes, stale tests aligned)
- #1424 `codex/dev-732-explicit-return-choices` (draft): DEV-732: Require explicit return choices
- #1425 `codex/dev-727-inventory-balance` (draft): Show inventory lot balances in recorded pack units

### 3-pharmacy (198)
- #4 `improve/ai-growth-whatsapp` → `improve/ai-growth` (draft): WP-G3/G4: WhatsApp channel
- #10 `improve/ai-growth-g9` → `improve/ai-growth-g1` (draft): feat(pharmacy): consent-gated G9 refill review flow (mock only; blocked G1 schema)
- #12 `fix/qa-129-sindh-regulatory-profile` → `integration/consolidation-20261019`: fix(pharmacy): operable Sindh regulatory profile (QA-129)
- #14 `fix/qa-132-saleable-medicine` → `integration/consolidation-20261019`: fix(pharmacy): make published medicine pack conversions saleable (#132)
- #15 `fix/substitutes-branch-gate` → `integration/consolidation-20261019` (draft): fix(pharmacy): gate substitute proposals with counter receipt access
- #16 `fix/procurement-toggle` → `integration/consolidation-20261019`: feat(pharmacy): per-staff Goods in (pharmacy:procurement) toggle
- #17 `fix/pos-tax-no-profile-ui` → `integration/consolidation-20261019` (draft): WIP(pos): POS/counter UI refresh (split from #172)
- #18 `fix/substitutes-branch-gate-misc` → `improve/ai-growth` (draft): fix(pharmacy): separate expiry bucketing and stock alerts
- #19 `fix/sec-rx-gate` → `integration/consolidation-20261019`: fix(sec): server-side prescription gate for Rx/restricted medicines
- #24 `fix/qa-udhar-postmerge` → `integration/consolidation-20261019` (draft): fix(khata): udhar post-merge sev2 fixes
- #25 `improve/narcotics-provinces` → `integration/consolidation-20261019`: Controlled-drug register: provincial rules and retention
- #29 `fix/qa-324` → `integration/consolidation-20261019`: fix(pharmacy): honor DENY on sale transition before admin short-cut (#324)
- #30 `fix/sec-rx-selfoverride-cap` → `fix/sec-rx-gate`: sec(PR #195): cap pharmacist self-authorized Rx overrides, require co-signer beyond it
- #33 `fix/qa-319-fefo` → `integration/consolidation-20261019`: Fix fefo-override tests after #319; canonical pharmacy:counter in test data; commands.vertical tests
- #35 `fix/qa-346` → `integration/consolidation-20261019`: Pharmacy Goods-in: direct-purchase (skip-PO) approver is not validated (#346)
- #39 `fix/qa-351` → `integration/consolidation-20261019`: Pharmacy counter: browser reload drops the open bill from the screen, sale stays OPEN in the DB (#351)
- #40 `fix/qa-352` → `integration/consolidation-20261019`: Pharmacy counter: out-of-stock medicine shows 'pack hierarchy does not match the received lot' (#352)
- #42 `fix/qa-364` → `integration/consolidation-20261019`: Command-centre pharmacist coverage ignores qualifiedPersonValidTo (#364)
- #43 `fix/qa-358` → `integration/consolidation-20261019`: RTL: mobile drawer, counter search results and medication card don't adapt to Urdu/RTL (#358)
- #44 `fix/qa-359` → `integration/consolidation-20261019`: a11y: pharmacy scrolling tables are not keyboard-reachable (#359)
- #45 `fix/qa-pharmacy-admin-403` → `integration/consolidation-20261019`: Pharmacy Administrator: no 403 on pharmacy reports
- #46 `fix/qa-tests` → `integration/consolidation-20261019` (draft): Test fixes: controlled-actor branch scope; #304 cleanup tests use the owner connection
- #47 `fix/qa-357` (draft): Pharmacy stock transfer cannot be partly received and finished later (#357)
- #48 `fix/qa-365` → `integration/consolidation-20261019`: a11y: price-notices <th> cells have no scope; counter stepper is 32px (#365)
- #51 `r5/r5-345-licence` → `bots/post-hire-work`: r5: #345 pharmacy licence validity check
- #54 `r5/r5-162-sindh` → `bots/post-hire-work`: r5: #162 Sindh pharmacy rules
- #64 `feat/loyalty-7-wallet` → `integration/consolidation-20261019`: feat(pharmacy): loyalty wallet — earn, redeem, balances, settings
- #66 `fix/followup-299` (draft): fix: pharmacy follow-up for #299 (revalidation required)
- #68 `fix/607-sale-unit-mrp-20261024` (draft): fix(pharmacy): sale-unit MRP rounding on current main (#607, successor to #642)
- #69 `fix/635-placeholder-binding-20261024` → `improve/pharmacy-regulatory-review-20261024` (draft): fix(pharmacy): #635 branch-bound profiles with launch placeholder compatibility
- #71 `fix/pharmacy-313-main-20261024` → `improve/pharmacy-khata-review-20261024` (draft): fix(pharmacy): main-based #313 Khata approval successor to #645
- #72 `fix/pharmacy-341-main-20261024` → `improve/pharmacy-rx-review-20261024` (draft): fix(pharmacy): #341 line Rx approvals reconciled with current-main #620
- #73 `fix/624-exclusive-send-20261024` → `improve/pharmacy-624-send-review-20261024` (draft): fix(pharmacy): serialize WhatsApp send authority for #624
- #74 `fix/129-sindh-jurisdiction-20261024` (draft): fix(pharmacy): carry #129 jurisdiction migration with fail-closed legal review
- #75 `fix/305-controlled-reversal-20261024` → `improve/pharmacy-controlled-reversal-review-20261024` (draft): fix(pharmacy): reconcile controlled goods-in reversal (#305, not WHA-305)
- #76 `codex/pharm-348` (draft): fix(pharmacy): [sev1] Pharmacy day close: 'Close and lock day' always fails with 500 (pharmacy_daily_clos (Fixes #348)
- #77 `codex/pharm-522`: fix(pharmacy): [sev2] Pharmacy sale unit conversion (canonicalUnitsPerSaleUnit) is trusted from the clien (Fixes #522)
- #79 `codex/pharm-579` (draft): fix(pharmacy): [sev2] Pharmacy controlled-item return can't be completed: panel never sends the required  (Fixes #579)
- #81 `codex/pharm-581` (draft): fix(pharmacy): [sev2] Pharmacy receipt/lot unit cost drops PO freight, other charges and rebate (Fixes #581)
- #82 `codex/pharm-595` (draft): fix(pharmacy): [sev2] Pharmacy: sales can be created/settled in an ONBOARDING org or a branch without an  (Fixes #595)
- #83 `codex/pharm-596` (draft): fix(pharmacy): [sev2] Pharmacy regulatory form keeps the previous branch's premises address/city after a  (Fixes #596)
- #85 `codex/pharm-605` (draft): fix(pharmacy): [sev2] Pharmacy day close accepts a future business date and locks that day before trading (Fixes #605)
- #87 `codex/pharm-617` (draft): fix(pharmacy): [sev2] Pharmacy write-offs never post the finance journal (postWriteOffEntry has no caller (Fixes #617)
- #89 `codex/pharm-619` (draft): fix(pharmacy): [sev2] Pharmacy supplier credit allocation has no lock: concurrent allocations over-alloca (Fixes #619)
- #91 `codex/pharm-626` (draft): fix(pharmacy): [sev2] Pharmacy: manually quarantined stock can never be written off or released (quaranti (Fixes #626)
- #92 `codex/pharm-627` (draft): fix(pharmacy): [sev2] Pharmacy day close/reconcile needs the literal ADMIN account role; no capability le (Fixes #627)
- #93 `codex/pharm-629` (draft): fix(pharmacy): [sev2] Pharmacy recall workflow: one branch's acknowledgement lets closeRecall reactivate  (Fixes #629)
- #98 `fix/pharm-679-integration-20261025` → `improve/pharmacy-accounts-review-20261025` (draft): feat(pharmacy): scoped fiscal exception evidence (#679)
- #100 `fix/pharm-676-integration-20261025` → `improve/pharmacy-accounts-review-20261025` (draft): feat(pharmacy): bounded posted cash coverage KPI (#676)
- #101 `fix/pharm-678-integration-20261025` → `improve/pharmacy-accounts-review-20261025` (draft): feat(pharmacy): pure bounded tax rule evidence comparison (#678)
- #102 `fix/pharm-681-integration-20261025` → `improve/pharmacy-accounts-review-20261025` (draft): feat(pharmacy): bounded supplied bank-match diagnostics and evidence CSV (#681)
- #103 `codex/fix-256`: fix(#256): No skip link on login and counter shell; login lacks main
- #106 `codex/fix-266`: fix(#266): Growth opt-out confirmation English-only; pharmacy reply has Urdu line
- #107 `codex/fix-293`: fix(#293): Goods-in access checkbox stays ticked after a refused or removed grant
- #110 `codex/fix-347`: fix(#347): Sindh pending-legal-review state has no clear badge/banner in the controlled register or r
- #111 `codex/fix-397`: fix(#397): [sev3] Pharmacy Urdu receipts use ASCII digits and ignore the locale for numbers
- #113 `codex/fix-414`: fix(#414): [sev4] Pharmacy: consent error on linking a customer says 'before dispensing' when LOYALTY
- #116 `codex/fix-482`: fix(#482): [sev2] Pharmacy counter: discount and FEFO-override approval is caller-supplied text, not 
- #117 `codex/fix-484`: fix(#484): [sev2] Pharmacy Goods-in: receipt line can name a different medicine/pack than the PO line
- #119 `codex/fix-490`: fix(#490): [sev2] Pharmacy offline stock quotas do not reserve stock against online movements
- #120 `codex/fix-491`: fix(#491): [sev3] Pharmacy print API lets callers repeatedly generate unmarked receipt originals
- #121 `codex/fix-520`: fix(pharmacy): [sev3] stock transfer dispatch uses a synthetic whole-pack arrangement, not the balance's real sealed/loose composition (#557)
- #122 `codex/fix-523`: fix(#523): [sev3] Pharmacy counter: controlled-medicine return can't send a witness, and the UI shows
- #123 `codex/fix-588`: fix(#588): [sev3] Pharmacy supplier-link submit/uploadDocument write no audit row
- #124 `codex/fix-621`: fix(#621): [sev3] Pharmacy khata aging ignores DISHONOURED_CHEQUE, so bounced-cheque debt shows as 0 
- #132 `codex/fix-692`: fix(#692): [planned] Narrow nontrade accrual journal voucher and account catalog (CEO-JVCORE-20261025
- #152 `codex/fix-264`: fix(#264): Counter WhatsApp consent never shows state and save throws CustomerNotFound
- #231 `codex/fix-489`: fix(#489): Pharmacy offline replay accepts sequence gaps and late lower commands
- #237 `codex/fix-481`: fix(#481): Pharmacy offline replay is fail-open for recalls: snapshots carry no recall state and repl
- #238 `codex/fix-519`: fix(#519): Pharmacy counter: quoted price uses the MRP rounding increment but posting ignores it, so 
- #240 `codex/fix-238`: fix(#238): Counter offers Capture prescription, then upload is FORBIDDEN for cashier
- #241 `codex/fix-488`: fix(#488): Prescription calendar validity shifts by device timezone and expires at UTC midnight
- #242 `codex/fix-483`: fix(#483): Pharmacy sale line split across lots charges every unit at the highest lot's MRP
- #243 `codex/fix-283`: fix(#283): Goods-in witness list offers every branch pharmacist, but posting only accepts the receipt
- #246 `codex/fix-469`: fix(#469): Pharmacy procurement: createSupplier, setSupplierAuthorization, createPurchaseOrder and ap
- #249 `codex/fix-515`: fix(#515): Pharmacy offline counter queue replays to /api/pharmacy/offline/commands, which doesn't ex
- #250 `codex/fix-516`: fix(#516): Pharmacy offline counter: concurrent enqueues can reuse a receipt/sequence and the later w
- #251 `codex/fix-521`: fix(#521): Pharmacy refunds (refundTender) and returns (returnLine) need no counter/cash capability o
- #252 `codex/fix-614`: fix(#614): Pharmacy licence scans are readable by any signed-in tenant member via /api/files/<name>
- #280 `recover/followup-517` (draft): recover: let ready pharmacy orders check out, cancel or expire past deadline
- #696 `cloud/issue-669`: fix(#669): [Pharmacy Accounts][S3] Add posted cash-coverage KPI by recorded currency
- #734 `codex/demo-operating-mode`: feat(pharmacy): SOLO/STAFFED operating mode + demo seed (stacked on #683)
- #768 `cloud/issue-738`: fix(#738): [Pharmacy][Growth] Daily and weekly owner briefing (WhatsApp to owner + app) with lost-sales lines
- #769 `cloud/issue-740`: fix(#740): [Pharmacy][Growth] Khata collection reminders with Raast payment link
- #775 `cloud/issue-758`: fix(#758): [Pharmacy][Growth] Marketing frequency caps and quality auto-pause
- #776 `cloud/issue-759`: fix(#759): [Pharmacy][Growth] WhatsApp campaign cost preview from current rate card
- #779 `cloud/issue-766`: fix(#766): [Pharmacy][Growth] Staff scheduling suggestions by hourly footfall
- #780 `cloud/issue-735`: fix(#735): [Pharmacy][Growth] Lost-sales capture: visit grouping, counter outcome chips, extended UnfulfilledDemandEvent and PKR loss math
- #781 `cloud/issue-736`: fix(#736): [Pharmacy][Growth] Lost-demand procurement advice with draft PO or transfer (human approval)
- #782 `cloud/issue-737`: fix(#737): [Pharmacy][Growth] Back-in-stock WhatsApp notice (no drug name) and recovered-PKR tracking
- #783 `cloud/issue-739`: fix(#739): [Pharmacy][Growth] True profit per item with landed cost (bonus units, freight, tax)
- #784 `cloud/issue-742`: fix(#742): [Pharmacy][Growth] Seasonal calendar and outbreak spike detection feeding forecasting
- #785 `cloud/issue-743`: fix(#743): [Pharmacy][Growth] Chronic refill program and monthly pack subscription
- #787 `cloud/issue-745`: fix(#745): [Pharmacy][Growth] Same-salt brand margin optimiser
- #791 `cloud/issue-751`: fix(#751): [Pharmacy][Growth] Smart discounting below MRP with minimum-margin guard
- #793 `cloud/issue-754`: fix(#754): [Pharmacy][Growth] Rx photo to draft cart with salt match, and delivery-radius profitability
- #794 `cloud/issue-755`: fix(#755): [Pharmacy][Growth] WhatsApp compliance linter for templates and send-time variables
- #795 `cloud/issue-756`: fix(#756): [Pharmacy][Growth] Voucher scoping to non-drug categories
- #796 `cloud/issue-760`: fix(#760): [Pharmacy][Growth] WhatsApp strike and account-quality monitor
- #797 `cloud/issue-761`: fix(#761): [Pharmacy][Growth] Neutral WhatsApp receipt with tokenized hosted receipt link
- #798 `cloud/issue-762`: fix(#762): [Pharmacy][Growth] Customer PWA: receipts, refill request, order with Rx photo, khata pay, loyalty
- #800 `cloud/issue-767`: fix(#767): [Pharmacy][Growth] Google Business Profile health and review reply drafts
- #802 `cloud/issue-390`: fix(#390): [sev1] Pharmacy counter: Cashier template grants pharmacy:counter (colon) but receipt gate only accepts pharmacy.counter (dot)
- #805 `cloud/issue-395`: fix(#395): [sev2] Goods-in reversal doesn't correct the controlled register, leaving it overstated
- #811 `cloud/issue-380`: fix(#380): Khata cash collections never reach the cash drawer (+250 variance at close)
- #814 `cloud/issue-385`: fix(#385): Khata reminders: language can't be set, no Urdu template, Meta provider unconfigured
- #825 `cloud/issue-462`: fix(#462): [QA][sev3] Pharmacy sidebar isn't role-specific: Cashier sees Purchasing, Reports, Pharmacist queue, Day close
- #826 `cloud/issue-518`: fix(#518): [QA][sev3] Pharmacovigilance: lifecycle transition is check-then-write and submission status can be regressed/overwritten
- #827 `cloud/issue-527`: fix(#527): [QA][sev3] Pharmacy offline replay accepts sequence gaps and late lower commands
- #855 `cloud/issue-577`: fix(#577): [QA][sev2] Purchasing: Branch-limited staff can read and change other branches' purchase orders
- #913 `cloud/issue-444`: fix(#444): [QA][sev2] Pharmacy reports: supplier, ingredient and batch filters are accepted but ignored
- #915 `cloud/issue-526`: fix(#526): [QA][sev2] Prescription calendar validity shifts by device timezone and expires at UTC midnight
- #917 `cloud/issue-606`: fix(#606): [QA][sev2] Pharmacy return and refund writes skip counter capability and branch assignment (scopeFor only)
- #922 `cloud/issue-650`: fix(#650): [QA][sev2] Pharmacy finance: GRN, inter-branch transfer, count adjustment and opening-stock journal adapters have no production caller
- #929 `cloud/issue-660`: fix(#660): [QA][sev2] Pharmacy activation gate: regulatory profile isn't bound to an active branch or to the branch's province/premises
- #934 `inky/issue-673`: feat(#673): [Pharmacy Accounts][S3] Add read-only canonical account-code normal-side reference
- #940 `inky/issue-718`: feat(#718): [Pharmacy][P1] Non-drug retail items with promo eligibility
- #941 `inky/issue-719`: feat(#719): [Pharmacy][P1] Shelf and price sticker printing for unbarcoded or loose stock
- #942 `inky/issue-732`: feat(#732): [Pharmacy] Live cold-chain sensor push
- #945 `inky/issue-708`: feat(#708): [Pharmacy][P0] Sindh cash-memo receipt mode (Drug rules r.18)
- #946 `inky/issue-723`: feat(#723): [Pharmacy][P2] SMS fallback for utility messages
- #947 `inky/issue-720`: feat(#720): [Pharmacy][P1] Licence and registration renewal reminders
- #949 `inky/issue-716`: feat(#716): [Pharmacy][P0] Owner full data export ("no lock-in" button)
- #950 `inky/issue-661`: feat(#661): [sev3] quarantinePart gated by pharmacy:inventory instead of pharmacy:safety
- #951 `inky/issue-439`: feat(#439): [QA][sev3] Pharmacy Urdu receipts use ASCII digits and ignore the locale for numbers
- #953 `inky/issue-728`: feat(#728): [Pharmacy] AI cash-close anomaly check
- #954 `inky/issue-722`: feat(#722): [Pharmacy][P1] Split tender on one sale (cash + khata + wallet)
- #955 `inky/issue-729`: feat(#729): [Pharmacy] Churn scoring
- #956 `inky/issue-727`: feat(#727): [Pharmacy] Date-based pharmacy promotions
- #959 `salvage/khata-overlimit-399` (draft): fix: Khata over-limit override approvable by owner/manager, re-checked in txn (salvage)
- #960 `salvage/rx-gate-410` (draft): fix: Pharmacy counter Rx gate for prescription-only medicines (salvage)
- #970 `inky/pharmacy-default-medicine-catalogue`: feat(pharmacy): default medicine catalogue for every new pharmacy (zero stock)
- #982 `inky/issue-976`: feat(#976): Pharmacy inventory: Create location fails with generic "could not be completed"
- #983 `inky/issue-977`: feat(#977): Pharmacy regulatory: only Punjab (provisional) offered; Sindh branch can't get an in-force profile
- #984 `inky/issue-979`: feat(#979): Pharmacy: cashier over-exposure (suppliers, purchasing, nav)
- #985 `inky/issue-978`: feat(#978): Pharmacy catalogue review: accept/reject/defer disabled for owner despite pharmacy:catalogue-review
- #986 `inky/issue-980`: feat(#980): Pharmacy leakage: agency/HR features in pharmacy tenant
- #987 `inky/pv-followup-247`: fix(pharmacy): restore pharmacist PV review/export and backfill owner branch access (follow-up to #247)
- #992 `fix/qa-batch1-sehatcart`: fix(qa): cashier dashboard and permissions, login validation and accessibility (batches 1 and 2A)
- #993 `fix/publish-creates-pack`: fix(pharmacy): publishing a medicine creates its pack size and barcode so stock can be imported (Sev1)
- #995 `fix/catalogue-edit-review`: fix(pharmacy): catalogue edits go through review (Sev2)
- #996 `fix/manager-only-campaigns-close`: fix(pharmacy): campaign approval/generation and day close/drawer need manager or owner (Sev2)
- #998 `fix/counter-cashier-copy`: fix(counter): plain-language copy for cashiers and hide internal tools
- #1001 `fix/reports-ops-screens`: fix(reports,ops): Reports filters, opening stock, Day close, Settings
- #1003 `fix/counter-responsive`: fix(pharmacy): counter, prescriptions and inventory responsive layout (QA batch 5)
- #1005 `fix/vertical-leak-404`: fix(pharmacy): vertical gating in Settings and branded 404 for unknown tenant (QA batch 5)
- #1008 `codex/linear-mention-dev-139-qa]-sev3]-pharmacy-licence-scans-a` (draft): fix(files): restrict pharmacy licence evidence to admins
- #1050 `codex/linear-mention-dev-40-sev3]-medicine-reference-non-sale` (draft): fix(pharmacy): derive medicine reference saleability copy
- #1068 `codex/DEV-322-command-centre-khata` (draft): DEV-322: Preserve command-centre Khata branch context
- #1072 `codex/DEV-321-counter-patient-entitlements` (draft): DEV-321: Lock counter patient entitlement regression
- #1116 `codex/DEV-135-supplier-claim-journal` (draft): DEV-135: Preserve supplier-return claim journal posting
- #1119 `codex/DEV-116-cash-flow-evidence` (draft): DEV-116: Show classification journal evidence in cash flow
- #1148 `codex/dev-5-recover-20261102` (draft): DEV-5: Check goods-receipt branch before locking the purchase order
- #1149 `codex/dev-54-recover-20261102` (draft): DEV-54: Match effective flat packs in opening-stock imports
- #1150 `codex/dev-45-recover-20261102` (draft): DEV-45: Clarify expiry advice failures and exclude production sandbox
- #1151 `codex/dev-38-recover-20261102` (draft): DEV-38: Restore purchasing returns access for procurement roles
- #1152 `codex/dev-56-recover-20261102` (draft): DEV-56: Add medicine-name search to prescription capture
- #1153 `codex/dev-61-recover-20261102` (draft): DEV-61: Add pharmacy report print and PDF action
- #1156 `codex/dev-59-recover-20261102` (draft): DEV-59: Restore bounded owner expiry advice
- #1161 `codex/dev-94-recover-20261102` (draft): DEV-94: Add pharmacy PostgreSQL backup and restore drill tooling
- #1162 `codex/dev-41-recover-20261102` (draft): DEV-41: Restore direct Counter sign-out and remove payment sandbox
- #1163 `codex/dev-97-recover-20261102` (draft): DEV-97: Gate counter settlement controls by capability
- #1164 `codex/dev-108-recover-20261102` (draft): DEV-108: Clarify pharmacy access-denial guidance
- #1165 `codex/dev-96-recover-20261102` (draft): DEV-96: enforce pharmacy record retention periods
- #1172 `codex/dev-208-local-recovery-20261102` (draft): DEV-208: Harden counter patient denial coverage and refund fixtures
- #1180 `codex/dev-164-local-recovery-20261102` (draft): DEV-164: Allow grants-only seed without pharmacy admin email
- #1181 `codex/dev-222-local-recovery-20261102` (draft): DEV-222: Repair recovered pharmacy test fixtures
- #1192 `codex/dev-314-local-recovery-20261102` (draft): DEV-314: Recheck consent before claimed WhatsApp sends
- #1193 `codex/dev-200-local-recovery-20261102` (draft): DEV-200: share purchase-order eligibility validation when posting receipts
- #1247 `codex/linear-mention-dev-607-qa]-sev2]-counter-unassigned-cash` (draft): [Draft] DEV-607: Enforce consistent counter branch admission
- #1265 `codex/linear-mention-dev-612-qa]-sev3]-security-near-expiry-cs` (draft): [DEV-612] Harden near-expiry CSV against row and formula injection
- #1362 `codex/dev-731-khata-repayment`: DEV-731: [Sev1] Counter: no way to record a khata repayment
- #1365 `codex/dev-718-brand-first` (draft): DEV-718: Counter search: brand name not shown in results
- #1366 `codex/dev-77-landed-profit` (draft): DEV-77: [Pharmacy][Growth] True profit per item with landed cost (bonus units, freight, tax)
- #1367 `codex/dev-707-quantity-entry` (draft): DEV-707: [QA][Sev3] Counter: quantity box defaults to 1 and can't be cleared to type a new number
- #1369 `codex/dev-719-keymap-selector` (draft): DEV-719: Counter: Shortcuts keymap select disabled, stuck on Legacy Speed
- #1371 `codex/dev-720-retain-receipt` (draft): DEV-720: Counter: receipt auto-vanishes after payment
- #1372 `codex/dev-499-tender-speed` (draft): DEV-499: [Pharmacy][UX][Sev2] Tender speed: prefill cash received, quick-cash buttons, provider buttons, hide CREDIT legacy
- #1374 `codex/dev-518-label-contrast` (draft): DEV-518: [Pharmacy][UX][Sev4] Small orange section labels fail contrast (2.64:1, need 4.5:1)
- #1375 `codex/dev-498-counter-layout` (draft): DEV-498: Align pharmacy counter shell with v2 handoff
- #1376 `codex/dev-622-pharmacist-payments`: DEV-622: [QA][Sev1] Roles: default Pharmacist can't take payment and Cashier can't take payment for an Rx bill, so only the Owner can finish an Rx sale
- #1377 `codex/dev-629-server-prescription` (draft): DEV-629: [QA][Sev2] Compliance: the server sells prescription-only medicines without a prescription (the check is browser-only)
- #1378 `codex/dev-636-receipt-details` (draft): DEV-636: [QA][Sev3] Receipt: printed receipt shows developer text and lacks the pharmacy's address, licence number, time and cashier
- #1379 `codex/dev-504-urdu-foundation` (draft): DEV-504: [Pharmacy][i18n][Sev2] App-wide Urdu/RTL foundation (next-intl, dir, Nastaliq font) starting with the counter
- #1380 `codex/dev-511-settings-grid` (draft): DEV-511: [Pharmacy][UX][Sev4] Settings page is a narrow column with two thirds of the screen empty
- #1381 `codex/dev-517-progressive-lines` (draft): DEV-517: [Pharmacy][UX][Sev4] Goods-in / purchase order line slots show every field (14 mobile screens of scrolling)
- #1382 `codex/dev-575-counter-search`: DEV-575: Sev1 perf: counter scan and search very slow
- #1384 `codex/dev-635-settled-change` (draft): DEV-635: [QA][Sev3] Counter: change due disappears the moment payment is recorded
- #1385 `codex/dev-642-opening-cost-basis` (draft): DEV-642: [QA][Sev3] Opening stock import: template "Cost" is per tablet while MRP is per pack, with no plausibility check; dry-run valuation counts rejected rows
- #1386 `codex/dev-670-report-medicine-picker` (draft): DEV-670: Report 'Find medicine' doesn't search as you type
- #1388 `codex/dev-728-distributor-expiry` (draft): DEV-728: [Sev2] Expiry: near-expiry list grouped by distributor with "Draft return claim"
- #1389 `codex/dev-736-account-labels` (draft): DEV-736: [Sev2] Trial balance shows raw account codes (SALES_CLEARING etc.)
- #1409 `saad/laughing-mendel-vtudno` → `claude/pharmacy-thermal-printer-bridge-6y8j92` (draft): DEV-742: Pharmacy printer settings, thermal bridge integration and test print (stacked on #1412)
- #1410 `saad/friendly-brahmagupta-y64wba` (draft): DEV-743: Pharmacy card-terminal integration boundary (provider-agnostic seam, mocked tests only)
- #1412 `claude/pharmacy-thermal-printer-bridge-6y8j92` (draft): DEV-741: Pharmacy thermal receipt print queue and bridge delivery status
- #1422 `codex/dev-734-goods-in-live-search` (draft): DEV-734: Add live search to goods in
- #1423 `codex/dev-737-journal-read-projection` (draft): DEV-737: Enrich pharmacy journal read projection
- #1428 `saad/eloquent-mendel-jhv0et` → `codex/demo-operating-mode`: fix(pharmacy): stock-count variance threshold from owner config only (stacked on #734)

### 4-restaurant (35)
- #7 `improve/ai-growth-g5` → `improve/ai-growth-g1`: WP-G5: campaign engine and POS code redemption
- #13 `fix/pos-tax-no-profile` → `integration/consolidation-20261019` (draft): fix(pos): fail closed when no tax profile is in effect
- #20 `improve/fbr-integration` → `integration/consolidation-20261019`: FBR POS integration
- #21 `fix/qa-restaurant-invites` → `integration/consolidation-20261019`: fix(restaurant): invite roles, tenant invite host, endMinutes 1440, role labels
- #28 `fix/qa-271` → `integration/consolidation-20261019`: fix(restaurants): comp/void/settlement sev1-sev2 fixes (#271 #272 #273 #274 #275)
- #141 `codex/fix-407`: fix(#407): [sev2] Restaurant /restaurant/staff can only link existing users; it can't invite a new wa
- #194 `codex/fix-473`: fix(#473): Restaurant order idempotency replay ignores command type and payload; replay returns the n
- #198 `codex/fix-534`: fix(#534): Terminal payments: Terminal approvals are validated against the pre-tax bill total
- #213 `codex/fix-599`: fix(#599): Restaurant: menu publication created with default (empty) channels publishes but POS can't
- #215 `codex/fix-610`: fix(#610): Restaurant: no seeded role grants floor:manage, so General/Branch Manager can't use Floor 
- #223 `codex/fix-582`: fix(#582): Restaurant Reports/Insights net sales subtract refunded tax and service charge (regression
- #262 `codex/fix-556`: fix(#556): Menu import: Approving a line imports variant prices the reviewer cannot see
- #270 `codex/fix-622`: fix(#622): Restaurant: drawer can be opened on an already-closed business day (open skips the money-d
- #846 `cloud/issue-447`: fix(#447): [QA][sev2] Restaurant /restaurant/staff can only link existing users; it can't invite a new waiter or manager
- #854 `cloud/issue-570`: fix(#570): [QA][sev2] Daily close: Unbilled active orders can create unpayable bills after close
- #857 `cloud/issue-638`: fix(#638): [QA][sev2] Restaurant: back-office order cancel needs orders:manage, which no non-Owner template grants (orders:void ignored)
- #859 `cloud/issue-662`: fix(#662): [QA][sev2] AI routing: no seeded model prices and a provider-wide $3/$15 fallback make the Anthropic budget ledger wrong (feat/ai-restaurant-growth)
- #872 `cloud/issue-367`: fix(#367): Order ticket shows live gross service, not the bill's service
- #879 `cloud/issue-377`: fix(#377): [QA] Restaurant invites can't select general-manager, branch-manager, bar-barista or accountant roles
- #896 `cloud/issue-463`: fix(#463): [QA][sev3] Restaurant Staff can't invite a new waiter/manager; 'Add staff member' only links existing org users
- #961 `salvage/comp-permission-368` (draft): fix: Restaurant comp gated on orders:complimentary, add orders:comp (salvage)
- #966 `salvage/restaurant-day-close` (draft): fix: Restaurant day close net sales with refunds (salvage; likely superseded)
- #1051 `codex/linear-mention-dev-175-qa]-sev2]-menu-import-approving-a` (draft): fix(menu-import): require review of extracted variant prices
- #1053 `codex/linear-mention-dev-149-qa]-sev2]-restaurant-menu-publica` (draft): fix(restaurant): resolve all-channel menus at POS
- #1054 `codex/linear-mention-dev-179-qa]-sev2]-low-stock-rules-low-sto` (draft): fix(restaurant): enforce low-stock branch authorization
- #1055 `codex/linear-mention-dev-157-qa]-sev2]-restaurant-refund-aware` (draft): fix(restaurant): keep close and rollup refund math aligned
- #1056 `codex/linear-mention-dev-141-qa]-sev3]-restaurant-demo-seed-he` (draft): fix(restaurant): assign demo head chef to kitchen role
- #1057 `codex/linear-mention-dev-156-qa]-sev2]-restaurant-sop-evidence` (draft): fix(restaurant): prevent SOP evidence attribution spoofing
- #1058 `codex/linear-mention-dev-176-qa]-sev2]-offline-pos-modifier-re` (draft): fix(pos): gate offline replay on modifier price changes
- #1059 `codex/linear-mention-dev-160-qa]-sev2]-restaurant-reports/insig` (draft): fix(restaurant): preserve componentized refund net sales
- #1063 `codex/linear-mention-dev-174-qa]-sev2]-menu-import-reviewed-fo` (draft): fix(menu-import): reject foreign-currency relabelling at commit
- #1065 `codex/linear-mention-dev-171-qa]-sev3]-catering-accepted-decim` (draft): fix(catering): report durable decimal scale validation errors
- #1173 `codex/dev-186-local-recovery-20261102` (draft): DEV-186: Preserve frozen service charge across partial tender settlement
- #1186 `codex/dev-172-local-recovery-20261102` (draft): DEV-172: Centralize recipe measurement validation
- #1191 `codex/dev-194-local-recovery-20261102` (draft): DEV-194: recover terminal signature test secret follow-up

### 5-agency (35)
- #131 `codex/fix-691`: fix(#691): Native non-stock AP invoices, canonical settlements and bounded aging
- #135 `codex/fix-408`: fix(#408): [sev3] Agency invoices: create form has no tax input (always sends tax 0) and discounts ar
- #136 `codex/fix-409`: fix(#409): [sev3] Agency invoice list always shows $ even for PKR invoices
- #137 `codex/fix-419`: fix(#419): [sev2] Agency invoice print/PDF shows DevFathom as the seller instead of the agency
- #145 `codex/fix-6`: fix(#6): [P3][Auth] Show/hide password toggle is keyboard-unreachable (tabindex="-1") and below min
- #156 `codex/fix-411`: fix(#411): [sev3] Agency meetings accept an end time before or equal to the start time
- #157 `codex/fix-421`: fix(#421): [sev3] Agency projects: end date before start date is accepted (tRPC and REST)
- #158 `codex/fix-422`: fix(#422): [sev3] Agency REST tasks: assignees don't have to be members of the task's project (PATCH 
- #172 `codex/fix-594`: fix(#594): [sev3] Agency tasks: cross-project move silently unassigns ADMINs who aren't project membe
- #173 `codex/fix-602`: fix(#602): [sev3] Agency project create is non-atomic: board failure leaves a partial project and ret
- #180 `recover/followup-410-claude` (draft): recover: track task completedAt so team stats count moves into Done
- #185 `codex/fix-76`: fix(#76): QA-PERF-A11Y: Keyboard focus is not visibly indicated on 17 screens
- #225 `codex/fix-584`: fix(#584): Agency invoice 'Paid' status option always fails and silently rolls back (regression)
- #227 `codex/fix-587`: fix(#587): Agency Finance overview counts posted recurring expenses twice
- #272 `codex/fix-504`: fix(#504): Agency projects: addMember can demote the last lead
- #273 `codex/fix-506`: fix(#506): Agency task labels can cross project/board authorization boundaries
- #275 `codex/fix-508`: fix(#508): Future-dated approved resignations never execute scheduled offboarding
- #277 `codex/fix-601`: fix(#601): Agency invoice print/PDF hard-codes DevFathom as the seller for every tenant
- #838 `cloud/issue-435`: fix(#435): [QA][sev2] Agency team: team:setRole is never checked, so an ADMIN denied it can still grant or revoke roles
- #841 `cloud/issue-440`: fix(#440): [QA][sev2] Agency invoices: Mark paid sets PAID without recording a payment, so the balance is wrong and payment entry is hidden
- #842 `cloud/issue-441`: fix(#441): [QA][sev2] Agency invoices: invoice number comes from a non-atomic count+1 but is globally unique, so numbers collide
- #850 `cloud/issue-458`: fix(#458): [QA][sev2] Agency invoice print/PDF shows DevFathom as the seller instead of the agency
- #863 `cloud/issue-310`: fix(#310): [QA][P3][Auth] Show/hide password toggle is keyboard-unreachable (tabindex="-1") and below minimum target size on both login forms
- #887 `cloud/issue-438`: fix(#438): [QA][sev3] Agency invoice status dropdown offers transitions the server rejects
- #888 `cloud/issue-448`: fix(#448): [QA][sev3] Agency invoices: create form has no tax input (always sends tax 0) and discounts aren't supported anywhere
- #890 `cloud/issue-450`: fix(#450): [QA][sev3] Agency /team/stats counts tasks as completed by updatedAt, so editing an old Done task looks like a new completion
- #891 `cloud/issue-451`: fix(#451): [QA][sev3] Agency meetings accept an end time before or equal to the start time
- #897 `cloud/issue-465`: fix(#465): [QA][sev3] Agency team invite reports success even when the invite email fails to send
- #899 `cloud/issue-542`: fix(#542): [QA][sev3] Agency projects: addMember can demote the last lead
- #900 `cloud/issue-543`: fix(#543): [QA][sev3] Agency projects: concurrent lead removals or demotions can leave zero leads
- #906 `cloud/issue-640`: fix(#640): [QA][sev3] API docs advertise PATCH /api/v1/projects/{id} and /clients/{id}, but routes export only GET/DELETE
- #962 `salvage/agency-projects-idor-456` (draft): fix: Agency REST projects verify clientId/memberIds belong to org (salvage)
- #1155 `codex/dev-44-recover-20261102` (draft): DEV-44: Restore grouped owner navigation and dismissible onboarding
- #1178 `codex/dev-166-local-recovery-20261102` (draft): DEV-166: Count invoice payments in Agency monthly revenue
- #1182 `codex/dev-158-local-recovery-20261102` (draft): DEV-158: cover outstanding partial invoice balances

### 6-hotel (2)
- #964 `salvage/hotel-p1-p2` (draft): feat(hotel): reservations, front desk, folio ledger, housekeeping, rate plans (salvage)
- #1006 `fix/sev3-authz-group`: fix(authz): capability checks for patient/consent, hotel setStatus, restaurant growth (Sev3)

### 7-other/infra (21)
- #56 `docs/dev-onboarding-architecture`: docs: developer onboarding, architecture, auth and roles, testing, contributing
- #57 `docs/restaurant-guide`: docs: restaurant guide and glossary (PR 3)
- #58 `docs/agency-guide`: docs: agency guide and glossary
- #59 `docs/deploy-ops-security`: docs: AWS staging, runbook, environment variables and security overview
- #96 `fix/pharm-675-integration-20261025` → `improve/pharmacy-accounts-review-20261025` (draft): [HOLD: repair/QA/Security/CI] feat(pharmacy): bounded journal evidence export (#675)
- #97 `fix/pharm-677-integration-20261025` → `improve/pharmacy-accounts-review-20261025` (draft): [HOLD: repair/QA/Security/CI] feat(pharmacy): bounded cheque maturity evidence (#677)
- #99 `fix/pharm-674-integration-20261025` → `improve/pharmacy-accounts-review-20261025` (draft): [HOLD: repair/QA/Security/CI] feat(pharmacy): exact account activity bridge (#674)
- #304 `dependabot/bun/develop/typescript-7.0.2`: chore(deps-dev): bump typescript from 5.9.3 to 7.0.2
- #305 `dependabot/bun/develop/eslint-10.11.0`: chore(deps-dev): bump eslint from 9.39.5 to 10.11.0
- #1169 `dependabot/bun/develop/development-5a0671f224`: chore(deps-dev): bump shadcn from 4.22.0 to 4.22.2 in the development group across 1 directory
- #1225 `saad/beautiful-thompson-7lnuy9`: docs: PR review handoff log (tracking only)
- #1313 `dependabot/docker/develop/oven/bun-1.4.4-slim`: chore(deps): bump oven/bun from 1.4.3-slim to 1.4.4-slim
- #1314 `dependabot/docker_compose/docker/livekit/develop/livekit/livekit-server-v1.13.11`: chore(deps): bump livekit/livekit-server from v1.13.10 to v1.13.11 in /docker/livekit
- #1392 `saad/sweet-keller-o464f5` (draft): DEV-339: Lock Container Apps probe margins against the measured 35.92 s cold start
- #1393 `saad/gifted-cori-9y0gps` (draft): DEV-341: Fail closed on unreviewed staging deployments
- #1394 `dependabot/github_actions/develop/actions/setup-node-7`: ci(deps): bump actions/setup-node from 6 to 7
- #1395 `dependabot/github_actions/develop/actions/github-script-9.0.0`: ci(deps): bump actions/github-script from 8.0.0 to 9.0.0
- #1396 `dependabot/github_actions/develop/aws-actions/configure-aws-credentials-6.3.0`: ci(deps): bump aws-actions/configure-aws-credentials from 5.1.1 to 6.3.0
- #1427 `codex/agents-assigned-cloud-runtime` (draft): docs: permit assigned Codex Cloud runtime and conditional memory activation
- #1431 `dependabot/bun/develop/production-minor-182a2e35ce`: chore(deps): bump the production-minor group across 1 directory with 22 updates
- #1432 `dependabot/bun/develop/production-patch-7df797a78f`: chore(deps): bump the production-patch group across 1 directory with 21 updates

## Appendix F. Contradictions, gaps and what I couldn't verify
1. **AI provider (updated 10 Nov):** #1238 replaced the Azure-only path with a routed chain Anthropic → OpenAI → Bedrock. Azure is still in the code as a legacy, explicit-only selector (`AI_PROVIDER=azure`) and the `@ai-sdk/azure` and `@azure/identity` packages are still dependencies. It is never a default or a fallback. Saad ordered Azure removed from all code on 10 Nov 2026; planned for the next Codex batch (DEV-755 / #1437). I did no Azure work.
2. **#1150:** its title is about expiry advice and the sandbox, but Security's note describes it as payment test mode. Payment sandbox removal is #1162.
3. **Opening-stock import:** QA says "planned", but the code is live (`pharmacy-owner-import.ts`).
4. **Duplicate or superseded PRs:** #859 and #140 (model prices; #1238 now seeds prices and SuperAdmin can edit them, so both may be obsolete); #994 merged and folded in #246, so #246, PR J and #984 need checking; #802 is superseded by #1368 (DEV-295).
5. **Margins:** the code gates them by `reports:financial` only, but the plan includes Manager (own branch).
6. **Pharmacist template** has both dispense and catalogue-review, which raises a separation-of-duties question.
7. **"Except enterprises" for Ask Fathom** is ambiguous.
8. **No code or PR (rechecked 10 Nov):** refund approval by manager/owner PIN, the narcotic flag, per-pharmacy AI credits and WhatsApp limit keys. The per-provider monthly caps ($190/$190/$300) **are** now built (#1238).
9. **Security:** #864 and #1165 failed review.
10. **Support sessions (resolved by reading the code):** earlier notes said they aren't impersonation. The code shows they are: the operator acts as a tenant ADMIN user, with full admin read and write rights, audited and with the tenant's admins notified. See 1.8.
11. **Outbound-effects and demo-restaurant crons** aren't in `vercel.json`; only `/api/platform/jobs/process` (every 5 minutes) is scheduled. I couldn't verify the external scheduler.
12. **Old PR numbers:** the earlier restaurant, agency and hotel lists used a previous numbering. I remapped them from branch names (#214→#21, #320→#28, #186→#17, #200→#20, #117→#7, #118→#8, #119→#9, #125→#11, #603→#64). Old #115 (G1 growth models) has no exact current PR; the nearest is #963 ("likely superseded"). #1199 (Ask Fathom) doesn't resolve as a PR in this repo.
13. **Not verified:** whether live third-party services are configured (LiveKit, Ably, wallet, SSO, mail); the QA status of any feature; cross-tenant isolation; the Appendix E section grouping, which is keyword-based.
14. **Shared core:** rows in 2.x and the agency, restaurant and hotel tables come from earlier per-vertical drafts. I re-checked their paths and procedure names against develop, but I didn't re-read each row's behaviour line by line.
14b. **Day close (2 Nov note, partly superseded):** section 3 and earlier notes listed day close as a live Sev1 gap. On develop, `closePreview`, `closeDay` and `dailyClose` already enforce `requireCloseAccess` (ADMIN or `pharmacy:close`). The cash drawer (`openDrawer`, `drawerMovement`, `closeDrawer`, `drawerStatus`) still has no role check. Purchasing (41 procedures), marketing (19) and supplier-links (5 of 8) are still bare `protectedProcedure` or `auditedProtectedProcedure` with no role named, which confirms that Sev1 is still open.
15. **Pharmacist self-signing (corrected 10 Nov after the CTO's check):** the comment on the Owner/Operator role template says grants don't permit self-review or self-signing. A database trigger enforces it (the requester can't decide their own item), but `pharmacy-dispensing.decideReview` doesn't check it in server code, an item can be decided twice, and REFUSE accepts no reason. Sev3.
16. **Plain-language "who can use it" lines** in sections 3–6 of the plain file were generated from the gate on each cited procedure (`capabilityProcedure`, `adminProcedure`, `protectedProcedure`, plus `require*`/`assert*`/`can()` calls inside the body), mapped to the ready-made role templates in `vertical-catalog.ts`. A role check inside a shared helper (for example `khataScope` or `branchScopeOrForbidden`) isn't always detected, so a row that says "the action itself names no role" may still have a helper-level check.
17. **Updated 10 Nov: role gaps from item 14b.** The cash drawer (#1086) and purchasing and supplier links (#994) are now gated. Corrected after the CTO's check: catalogue edits are open to any signed-in user (Sev2, #995), and marketing is owner-only, not module-only (#996). `pharmacy-marketing.ts` and `pharmacy-medicine.ts` are unchanged since `47518cbf`.
18. **#1240 merged with "[Draft]" in its title**, and it was marked ready for review 52 seconds before it merged, with no review and no checks. The counter redesign is on develop even though its PR was titled as a draft; its body says repository typecheck ran out of memory. QA should confirm the counter still behaves as before.
19. **`platformAIUsage.currentMonth` is a `publicProcedure`.** `readMonthlyAIUsage()` checks the platform session itself and allows SUPER_ADMIN only. CTO-checked 10 Nov: signed-out callers get no data back, but they see an error page instead of a proper "not allowed" response. Sev3.
20. **Deep-strategy opt-in has no screen.** `organization-admin.setDeepStrategyEnabled` exists but no page calls it.
21. **Hardware:** live camera view, evidence stills and the acceptance matrix are code and docs only; no device has passed.
22. **GitHub Actions is off, by Saad's decision (10 Nov 2026)** (`actions/permissions` returns `enabled: false`; all six workflows disabled). Before every merge, lint, typecheck, unit tests, build, Prisma generate and the Docker check run on the AWS worker on the exact final commit. develop fails its own unit tests at `1906b530` (Codex to fix).
