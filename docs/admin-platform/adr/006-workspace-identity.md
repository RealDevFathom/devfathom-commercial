# ADR 006: Workspace means authenticated organization

Status: accepted

## Decision

In tenant chrome, “workspace” is the organization selected during authentication. The displayed
workspace identity must carry the same organization ID as `session.user.organizationId`. The app
layout derives both the tenant database scope and displayed brand from that authenticated actor,
and rendering fails closed if the IDs differ.

Changing organizations is therefore an authentication transition, not presentation state. The
chrome action ends the current session and returns to the shared-host login flow, where credentials
are proven and the server-computed eligible organization is selected before a new organization-
scoped JWT is minted. Roles, staff, catalogs, entitlements, and all other tenant reads then use the
new session organization through the existing forced-RLS boundary.

## Rejected alternative

A presentation-only company selector was rejected. It could imply that roles, settings, staff, or
catalog data changed tenant while the authenticated organization and RLS scope remained unchanged.
Keeping a separate client-side workspace identity would make divergence representable and would
turn tenant chrome into a misleading security signal.

## Consequences

- There is no in-session organization mutation.
- “Switch organization” signs out before offering another organization.
- A mismatched brand/session ID is an application error and no tenant chrome is rendered.
- Organization-scoped role, staff, settings, catalog, and entitlement behavior remains enforced by
  the existing session-derived tenant database scope.
