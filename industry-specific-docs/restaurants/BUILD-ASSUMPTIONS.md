# Restaurant vertical — Build Assumptions (`restaurant/v1`)

Conservative build-time assumptions for the restaurant vertical. An entry is
recorded only when an **OPEN** decision in the planning D-register would
otherwise block an implementation choice: apply the conservative default that
sits behind the plan's seam, record it here, and name what would revisit it.
This file is not a place to resolve open decisions — it documents the safe
default taken until the owning decision is closed.

## Entry format

```
D-id · assumption · why conservative · what revisits it
```

## Entries

**D09 (franchise/legal isolation)** · Restaurant branches live strictly inside
the existing organization RLS boundary; there is no cross-organization
aggregation or consolidated franchisor reporting. `RestaurantBranch` and
`RestaurantBranchAssignment` carry a bare, RLS-guarded `organizationId` exactly
like the other operational tables, and `vertical-catalog.ts` exposes no
cross-organization query. · Conservative because widening a tenant boundary to
approximate franchisor rollups is the failure mode D09 explicitly forbids;
keeping branches inside org RLS cannot leak one franchisee's data to another. ·
Revisited by D09 closing — a separately contracted, security-reviewed
cross-organization aggregation capability with its own explicit design.

**D10 (package/limit matrix)** · The catalog ships three §13 packages
(`restaurant-essentials`, `restaurant-operations`, `restaurant-enterprise`) whose
included modules and §7 limit keys use conservative default values (Essentials
`restaurant.locations.max = 1`); names, prices, and exact quantities are
provisional. Package compatibility is modeled as a single `vertical` enum column
on `PlatformPackage`, matched by exact equality in
`assertPackageCompatibleWithVertical`. · Conservative because a single-column
equality is the smallest rule that rejects a mismatched package server-side, and
tight Essentials limits under-provision rather than over-promise scale before
pricing exists. · Revisited by D10 closing — an approved package/limit matrix and
contract wording, which may add richer compatibility metadata than one column.

**D12 (branch enforcement)** · `restaurant_branches` and
`restaurant_branch_assignments` receive forced org-level RLS identical to the
existing tenant tables (same `app.current_organization_id` / `app.is_platform_admin`
clause). Branch-level authorization is expressed as explicit
`RestaurantBranchAssignment` rows enforced in server code, not a database policy;
the `branchId` columns and the assignment table are the policy-ready seams for a
later branch-scope decision. · Conservative because inventing a branch-scope DB
policy now — before the multi-branch-staff, org-wide-reporting, emergency-support,
and fail-closed cases are decided — risks a wrong, hard-to-reverse boundary; org
RLS already fails closed. · Revisited by D12 closing — an accepted ADR plus a live
non-superuser cross-branch harness deciding whether sensitive branch-owned tables
also get database-enforced branch policies.
