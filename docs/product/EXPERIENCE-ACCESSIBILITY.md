# Experience and accessibility

**Working standard: 2026-07-12**  
**Status:** Proposed design and acceptance standard for the active `Design-1` redesign.

## Experience objective

DevFathom Hub should feel like a calm operating room: clear hierarchy, visible ownership, fast action, and enough context to make a decision without reconstructing the company from multiple screens.

The product serves repeated work under time pressure. Visual distinction matters, but clarity, predictability, keyboard access, readable density, and recovery from mistakes are the quality bar.

Reference target: [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/). This is a proposed conformance target, **not a claim of current conformance**.

## Core experience principles

1. **Attention before decoration.** The strongest visual treatment belongs to the next meaningful action, not branding or passive metrics.
2. **Stable spatial memory.** Primary navigation, page identity, filters, and core actions remain in predictable positions.
3. **Progressive disclosure.** Show a concise state first; reveal history, metadata, and advanced controls on intent.
4. **Evidence with every insight.** Risk, status, and AI recommendations link to the records and rules that produced them.
5. **Role-aware, not role-fragmented.** The same concepts use the same language and interaction model even when scope differs by role.
6. **Safe action design.** Consequential actions show impact, target, reversibility, and confirmation requirements.
7. **Accessible by default.** Keyboard, focus, semantics, contrast, reduced motion, zoom, and screen-reader behavior are acceptance criteria.
8. **Honest system state.** Loading, stale data, offline state, partial failure, disabled integrations, and permission denial are explicit.
9. **Human pace.** Motion explains state change and never delays routine work.
10. **No employee surveillance patterns.** Do not rank people, infer productivity, or hide monitoring behavior behind “insights.”

## Information architecture

The primary navigation should group work by user intent rather than exposing the database schema.

| Intent      | Modules                                            | Primary question                                           |
| ----------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Focus       | Dashboard / attention queue, notifications, search | What needs me now?                                         |
| Deliver     | Projects, boards, tasks, meetings                  | What are we committing to and what blocks it?              |
| Relate      | Clients, contacts, contracts                       | Who are we serving and what did we agree?                  |
| Operate     | Finance, people/HR, reviews, resignations          | What must the business process or decide?                  |
| Collaborate | Chat, notes, meetings                              | What context and conversation support the work?            |
| Govern      | Audit, API tokens, webhooks, settings              | Who can act, what changed, and how is the system extended? |

Navigation visibility may reflect role, but authorization must remain server-side. Hidden navigation is a usability choice, never a security control.

## Dashboard standard

The dashboard should not be a uniform grid of unrelated cards. Recommended order:

1. **Command strip:** date context, page identity, universal create/search, concise briefing.
2. **Attention queue:** up to five ranked actions with evidence, owner, impact, due state, and direct action.
3. **Delivery pulse:** portfolio health, blockers, deadlines, and capacity conflicts.
4. **Money/operations:** currency-correct cash and operational deadlines for authorized roles.
5. **People/capacity:** availability, leave, handoff risk, and workload without individual scoring.
6. **Change signal:** material changes and automated actions since the last visit.

Success test:

- A leader identifies the three most consequential interventions within 30 seconds.
- A team member identifies the next commitment within 10 seconds.
- No critical meaning depends on color alone.
- Every alert can be explained or dismissed with a reason.

## Visual system direction

### Tone

- Warm authority rather than generic blue SaaS neutrality.
- Editorial hierarchy, restrained surfaces, and decisive action color.
- Generous whitespace at overview level; efficient density in tables/boards.
- Avoid gradients, glows, glass effects, excessive rounded cards, and decorative charts unless the design system explicitly justifies them.

### Recommended semantic palette

| Token role | Direction             | Usage rule                                                                                 |
| ---------- | --------------------- | ------------------------------------------------------------------------------------------ |
| Canvas     | Warm paper/off-white  | Primary background; must preserve text contrast                                            |
| Ink        | Near-black charcoal   | Primary text and strong controls                                                           |
| Signal     | Warm coral/red-orange | Primary action and high-salience state; not every accent                                   |
| Positive   | Muted moss/green      | Confirmed success/healthy state, with icon/text label                                      |
| Caution    | Amber/ochre           | Warnings and pending attention, never body text on light backgrounds without contrast test |
| Muted      | Warm gray             | Secondary metadata; must still meet contrast at its size                                   |

Existing CSS/brand tokens remain the implementation source. This table sets semantic intent, not literal replacement values.

### Typography

- Use the existing IBM Plex Sans/Mono and Oxanium configuration deliberately.
- Sans handles interface and long-form readability.
- Mono is metadata, identifiers, timestamps, and compact operational texture, not body copy.
- Display type is limited to page/product identity; it must not reduce scanning clarity.
- Minimum default body target: 16 CSS px on desktop and mobile, with comfortable line height.

## Interaction and motion

| Interaction        | Standard                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Navigation         | Immediate feedback; preserve page identity and selected state                                               |
| Dialog/sheet       | Initial focus inside; labelled title; Escape closes when safe; focus returns to trigger                     |
| Menu/popover       | Full keyboard navigation; correct ARIA state; no hover-only access                                          |
| Drag/drop          | Provide keyboard and non-drag alternative for board/task movement                                           |
| Async mutation     | Show pending state, prevent duplicate submission, announce success/failure, offer retry/undo where possible |
| Destructive action | Name the object and consequence; confirm; prefer reversible archive over delete                             |
| AI proposal        | Show source records, proposed change, permission context, approval boundary, execution result               |
| Animation          | Routine transitions roughly 120-300 ms; interruptible; no essential information only in motion              |
| Reduced motion     | Respect `prefers-reduced-motion`; replace spatial animation with opacity/instant state where needed         |

GSAP/Motion should be used for purposeful state transitions and sequencing, not persistent decoration. The product remains usable when animation is disabled.

## Accessibility acceptance criteria

### Per page

- One descriptive page-level heading and logical heading order.
- Landmark regions for navigation, main content, and complementary panels.
- Page title and breadcrumb/route identity match user language.
- Keyboard reaches every interactive element in a logical order.
- Visible focus is not clipped or hidden by sticky headers/panels.
- At 200% zoom, content reflows without loss of function; no required two-dimensional scroll except data tables/boards where justified.
- Text and non-text contrast meet the WCAG 2.2 AA target.
- Icons with actions have accessible names; decorative icons are hidden from assistive technology.
- Error messages identify the field, explain the issue, and remain associated with the control.
- Loading skeletons do not steal focus or create repeated screen-reader announcements.
- Toasts/status changes use appropriate live regions and remain available long enough to perceive.

### Critical WCAG 2.2 considerations

- Focus must not be obscured by sticky navigation or overlays.
- Dragging must have a single-pointer/keyboard alternative.
- Targets must be large enough and separated enough for reliable activation.
- Authentication cannot rely on a cognitive-function test without an alternative.
- Help and support placement should remain consistent.
- Previously entered information should not be requested again when the system already has it, unless security requires it.

## Responsive behavior

- Mobile prioritizes the attention queue and personal commitments, not miniature desktop dashboards.
- Side navigation becomes a labelled, focus-managed drawer or compact destination switcher.
- Tables expose priority columns first and support horizontal overflow with clear affordance.
- Board columns retain usable width; provide list/table alternative on narrow screens.
- Sheets/dialogs become full-height mobile surfaces with stable close/back behavior.
- Touch interactions never require hover.

## Content design

### Voice

Direct, specific, calm, and human.

- Prefer “Invoice INV-104 is overdue by 8 days” over “Action required.”
- Prefer “You do not have access to this project” over “Forbidden.”
- Prefer “Email connection is disabled until server configuration is complete” over an inactive button with no reason.
- Avoid “magic,” “effortless,” “revolutionary,” and generic AI claims.

### States every feature must define

1. First-use/empty.
2. Loading.
3. Loaded.
4. No matching results.
5. Permission denied.
6. Validation failure.
7. Vendor/network failure.
8. Offline/stale data.
9. Partial success.
10. Destructive/recovery outcome.

## High-risk journey checklist

| Journey                        | Required UX evidence                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Sign in / reset / invite / MFA | Clear requirements, accessible fields, safe callback, no account enumeration, recovery guidance                                |
| Project/task changes           | Visible target/context, membership constraints, optimistic rollback, activity/audit feedback                                   |
| Invoice/payment                | Currency always visible, server result shown, transition explained, no mixed-currency total                                    |
| Leave/resignation/termination  | Dates and policy conflicts explained; reviewer identity/authority clear; sensitive data minimized                              |
| File upload/download           | Allowed types/size, progress, failure recovery, parent/visibility shown, durable-storage limitations removed before production |
| Connected email                | Disabled reason visible; consent scope explained; provider/account identity confirmed; disconnect/revoke clear                 |
| AI action                      | Evidence, exact mutation preview, approval, execution result, audit reference, retry/cancel                                    |
| Webhook/API token              | Secret shown once, copy confirmation, scopes/events clear, revoke/rotate path, delivery/error history                          |

## Design QA gate

Before a redesigned page is approved:

1. Verify at desktop, narrow desktop, tablet, and mobile widths.
2. Complete keyboard-only flow and screen-reader smoke test.
3. Run automated accessibility checks, then manual focus/name/state verification.
4. Test light/dark themes if both are supported; no theme-specific invisible state.
5. Test reduced motion and 200% zoom.
6. Test empty, error, denied, loading, long text, long names, and large data states.
7. Test latency and mutation failure; confirm recovery/rollback.
8. Verify analytics/audit do not capture secret or sensitive field values.
9. Confirm UI hiding is matched by server authorization.
10. Record screenshots and results in the release evidence.

## Current known gaps

- No automated accessibility or browser E2E suite exists.
- Lint has React correctness warnings/errors that must be cleared.
- The current redesign is uncommitted and has not completed the gate above.
- Board drag/drop needs an explicitly verified keyboard alternative.
- AI, upload, email-disabled, and vendor-failure experiences need end-to-end validation.
- Current product analytics are insufficient to measure time-to-value or queue usefulness.

## Related documents

- [Product strategy](PRODUCT-STRATEGY.md) · [Quality and performance](../engineering/QUALITY-PERFORMANCE.md) · [Release checklist](../governance/RELEASE-CHECKLIST.md) · [Security architecture](../architecture/SECURITY-ARCHITECTURE.md) · historical design specifications under `docs/superpowers/`
