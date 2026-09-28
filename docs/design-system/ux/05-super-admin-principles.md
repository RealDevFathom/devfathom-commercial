# Super-admin / platform console: UX principles (next lane)

Status: proposed (WHA-1574) · Surface: `src/app/platform/(console)/**`, `src/components/platform/*`
Evidence: code walk at `d9957a9a` (findings summarised inline; `file:line` under `src/`)

The platform console is used rarely, by a few expert operators, and its actions have a large
blast radius:

- one click can suspend a paying tenant
- one click can purge a tenant's data

Terminal screens optimise taps. This console should optimise **certainty**: the operator always
knows which tenant they're acting on, what will change, and how to reverse it.

## Principles

1. **Always show the tenant.**
   - Every org-scoped page pins an identity bar: display name, vertical, lifecycle status pill,
     deployment mode (human label, not enum) and a copyable short ID.
   - Full UUIDs go behind a copy button, not in body text
     (`organizations/[id]/page.tsx:1925`).
2. **Blast radius sets the friction.** Use the shared `ConfirmAction` recipe at three levels:

   | Level        | Examples                                                      | Pattern                                                                                                                     |
   | ------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
   | Reversible   | enable a module, edit limits                                  | One click + an **Undo** toast (10s) + an audit entry                                                                        |
   | Disruptive   | suspend, disable a module, revoke SCIM, end a support session | A review dialog that states the consequence ("312 users lose access now"), a reason (picker + text) and a confirm           |
   | Irreversible | terminate, purge, delete identity provider                    | **Type the org's slug to confirm**, a reason, a second approver where policy requires it, and a named retention consequence |

   Today:
   - Module enable/disable is one click with a hard-coded reason (`organizations/[id]/page.tsx:782-809`).
   - Lifecycle suspend/terminate is a select with a preselected first option and no confirm
     (`:522-551`; `platform-command-form.tsx:132`).
   - Purge uses `window.confirm` (`:1952-1961`; `platform-command-form.tsx:515`).

3. **Danger looks like danger.**
   - Destructive commands use the `destructive` variant and a verb label ("Suspend
     organisation"), in a separated _Danger zone_ section (DEVFATHOM-STUDIO §7
     "Organization/detail page").
   - Today every command button shows a Play icon at 40px (`organizations/[id]/page.tsx:543-556`).
   - Success toasts name the object and the new state ("Chai Chowk suspended · Undo"), not
     "`{label}` completed" (`:528`).
4. **Gates before forms.**
   - Activation shows a checklist of unmet gates, each with a fix link, and the activate button
     stays disabled until all pass. This already exists (`:478-518`); keep it.
   - Make "Use shared deployment" a confirmable decision, not a one-click side effect (`:497-506`).
5. **Progressive creation, not a 25-field form.**
   - `organizations/new` becomes a stepper: Type → Identity → Region & deployment → Modules →
     First admin (invite by email; **never** have the operator type the tenant's password,
     `organizations/new/page.tsx:362`) → Review.
   - Each step validates on its own, and Back preserves every value.
6. **Audit is readable by a human.**
   - Show actor **names** (with ID on hover or copy), the target name and a verb sentence, e.g.
     "J. Khan suspended Chai Chowk — reason: non-payment".
   - Add filters (actor, org, action, date), pagination instead of the 500-row cap
     (`audit/page.tsx:32`), and CSV export.
   - Show raw action codes only in a detail drawer.
7. **Support access is visible and time-boxed on both sides.**
   - Keep the reason (≥10 chars) and the 15/30/60-minute duration (`support-access-form.tsx:61-78`).
   - The tenant banner (`components/layout/app-shell.tsx:218-224`) shows a live countdown and
     **End now**.
   - The platform side lists active sessions with the remaining time and a revoke action.
8. **Density with legibility.**
   - Nothing under 11px. Today there are 9px labels (`platform-shell.tsx:75`,
     `organizations/[id]/page.tsx:290`, `:337`, `:465`, `:1700`).
   - Replace the 13 anchor tabs on org detail (`:335-362`) with 5 real tabs:
     Overview · Modules & limits · Identity & access · Deployment · Audit & lifecycle.
   - Tables scroll inside their own containers (contract §6). Filters apply as you type or
     select, without an "Apply filters" round-trip (`organizations/page.tsx:100`).
9. **Words, not enums.**
   - Lifecycle, deployment mode and operator role go through `statusLabel` maps.
   - Navigation drops the "01–10" number prefixes and the "Runbook /" group jargon
     (`platform-shell.tsx:72-110`) in favour of plain group names:
     Tenants · Operations · Governance.
10. **Same family as the tenant Studio.**
    - Same shell grammar, tokens and components (contract §1: "Do not design a second admin
      theme").
    - The platform is differentiated by an ink identity bar and a mode label, not by a
      different palette.

## Targets for the lane

| Task                                | Today                                                   | Target                                                                        |
| ----------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Suspend a tenant by mistake         | 2 clicks (select pre-filled, then submit with a reason) | Impossible without the consequence review + confirm                           |
| Purge                               | Browser confirm                                         | Typed slug + reason (+ second approver if policy)                             |
| Find who changed a module last week | Scan a 500-row table of raw IDs                         | Filter by org + action, and read a sentence                                   |
| Create an org                       | One ~25-field page                                      | A 6-step stepper with review, and an admin invite instead of a typed password |
