# GitHub issue #424 is already fixed

Verified against the current `work` branch on 2026-10-22. The reported Restaurant Staff UX gap is no longer present, so no production code was changed.

## File-and-line evidence

- `src/components/restaurant/restaurant-staff-console.tsx:98-101` loads branch-scoped restaurant roles while the new-staff dialog is open.
- `src/components/restaurant/restaurant-staff-console.tsx:127-134` configures the restaurant staff invitation mutation and confirms successful invitations.
- `src/components/restaurant/restaurant-staff-console.tsx:220-237` submits a new staff member's name, email, restaurant role, and primary branch to that invitation mutation.
- `src/components/restaurant/restaurant-staff-console.tsx:475-524` presents the **Add staff member** dialog as an invitation flow, with required email and restaurant-role inputs. The existing-organization-user selector is now rendered only when editing a staff profile (`src/components/restaurant/restaurant-staff-console.tsx:526-568`).
- `src/server/routers/restaurant-staff.ts:124-149` gates the invitation endpoint with the existing `staff:manage` capability procedure and validates all invitation fields.
- `src/server/routers/restaurant-staff.ts:150-187` enforces branch authorization and prevents an inviter from assigning a role above their own effective access.
- `src/server/routers/restaurant-staff.ts:189-252` scopes the user lookup to the workspace organization and atomically creates the invited user, restaurant staff profile, role assignment, and invitation record.
- `src/server/routers/restaurant-staff.ts:256-282` sends the invitation email, records a non-secret audit event, and returns the invite URL so it can be shared manually if email delivery fails.
- `src/server/routers/restaurant-staff.ts:749-768` exposes only assignable roles for an authorized branch, excluding owner/admin roles and roles whose capabilities exceed the inviter's effective access.
- `src/components/restaurant/restaurant-staff-console.test.tsx:281-309` contains a focused UI test proving a brand-new waiter's email and selected branch role are submitted to the invitation mutation.
- `src/server/routers/restaurant-staff.test.ts:208-242` contains focused router tests proving atomic invitation provisioning and rejection of privilege-escalating role assignment.

The existing implementation therefore satisfies R9 directly from `/restaurant/staff`: a manager can enter a new person's email, choose an authorized branch and waiter/manager role, and create both the invitation and linked restaurant staff profile without detouring through Team.
