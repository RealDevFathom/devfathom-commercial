# Restaurant cameras gap follow-up — 2026-10-22

## Selection and verification

This follow-up addressed the three highest-ranked findings whose severities are **High** or
**Medium** in `docs/rgap-restaurant-cameras-20261022.md`: findings 2, 3, and 4. The Critical
transaction-boundary finding was not part of the requested High/Medium selection, and the remaining
Medium development-simulator finding ranked below these three.

Each selected finding was rechecked against the current branch before editing:

1. **High — gateway lifecycle UI: verified.** The router already exposed enrollment, secret
   rotation, and co-authorized revocation, but the camera console still instantiated none of those
   mutations and the camera wizard still dead-ended when no gateway existed.
2. **High — real-mode retention claim: verified.** Restaurant privacy data still treated the
   gateway registry's `retentionDays` as authoritative in MediaMTX mode, and the shared privacy panel
   still turned it into numeric signage and an editable form.
3. **Medium — branch source: verified.** The console still derived branch choices solely from staff
   members' primary branches rather than the branch-authorization directory.

No selected finding was already fixed. A live open-issue deduplication was attempted with
`gh issue list --state open --limit 200 --json number,title,body,url`, but this checkout has no
GitHub CLI authentication. Consequently, no selected finding could be confirmed as covered by a
live open GitHub issue, and none was skipped on that basis. The source report's local issue-artifact
review likewise found no matching tracked issue.

## Changes

### Gateway lifecycle

- `src/components/restaurant/restaurant-camera-gateways.tsx:17-275` adds a gateway lifecycle panel:
  branch-bound enrollment, base URL and 1–90 day registry validation, gateway health/status,
  one-time `rcg_` secret disclosure with copy and acknowledgement, rotation, and the existing
  two-person revocation inputs. It explicitly distinguishes the enrollment secret from HLS reader
  and DVR credentials.
- `src/components/restaurant/restaurant-cameras-console.tsx:160-165` mounts the lifecycle panel in
  the camera console.
- `src/server/routers/restaurant-cameras.ts:70-93` returns the base URL needed by the lifecycle
  status surface and explicitly filters gateway reads by organization.
- `src/server/routers/restaurant-cameras.ts:127-220` rechecks organization and active branch before
  secret rotation or revocation and supplies a tenant/branch-filtered named co-authorization
  directory. Existing `adminProcedure`/entitlement gates and the co-authorization implementation
  remain the enforcement path, preserving central `can()` DENY-over-ALLOW behavior.

### Runtime-aware privacy and retention

- `src/lib/cameras/privacy.ts:42-47,81-110` marks whether the selected runtime actually manages
  retention; restaurant MediaMTX mode is owner-managed while pharmacy and simulated mode remain
  app-managed.
- `src/lib/cameras/privacy.ts:179-200` rejects direct restaurant retention writes in MediaMTX mode,
  rather than silently updating a non-authoritative registry value.
- `src/components/camera/camera-privacy-panel.tsx:20-46,69-107` suppresses numeric retention promises
  and edit forms for owner-managed gateways and presents an explicit owner-verification state in
  English and Urdu signage.

### Authoritative branch choices

- `src/components/restaurant/restaurant-cameras-console.tsx:68-81` now consumes the existing
  authorization-filtered `restaurantStaff.listBranches` query and retains active branches, instead
  of inferring branches from staff primary assignments.
- `src/components/restaurant/restaurant-camera-wizard.tsx:134-150,298-310` adds explicit branch
  loading, access/error, empty, and disabled-submit states so unavailable authorization data cannot
  be mistaken for a usable camera setup.

## Scope constraints

No packages were installed and no tests, builds, application server, browser session, database
access, or hardware probes were run. The changes retain the existing central procedure gates,
tenant filters, active-branch checks, and two-person revocation contract.
