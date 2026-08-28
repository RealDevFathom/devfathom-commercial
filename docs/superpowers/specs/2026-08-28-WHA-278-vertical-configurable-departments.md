# WHA-278: Vertical-configurable departments

## Data model and contract

`organization_departments` owns a tenant's department vocabulary. `(organizationId, key)` is the stable identity used by the existing `User.department` API; `label` is editable display text and unique per tenant. A composite foreign key from `users` prevents cross-tenant department assignment. Department rows use forced tenant RLS, while tenant administration is restricted to the existing admin procedure.

## Defaults and compatibility

The vertical catalog supplies copy-on-provision defaults. Agency retains `LEADERSHIP`, `ENGINEERING`, `PRODUCT`, `QUALITY`, `MARKETING`, and `DESIGN`. Restaurant starts with `LEADERSHIP`, `KITCHEN`, and `FRONT_OF_HOUSE`; it receives no agency-only defaults. Existing string-shaped API/session fields remain compatible.

## Migration and backfill

The forward migration converts `users.department` from the PostgreSQL enum to text without changing values. It inserts every distinct existing `(organizationId, department)` before adding the composite foreign key, then fills missing catalog defaults according to `organizations.vertical`. This preserves custom/legacy values without coercion or loss. The migration is atomic and fails closed if uniqueness or referential integrity cannot be established.

## Administration and isolation

Tenant admins can list, add, relabel, and remove unused departments in their own organization. Keys are immutable through the API. Removing an in-use department is rejected until members are reassigned. All application predicates include `organizationId`, and forced RLS remains the database boundary.

## Rollback

Rollback is operational, not an automatic down migration: remove the composite foreign key, verify every user value belongs to the original six agency values, cast `users.department` back to a recreated enum, then drop `organization_departments`. A tenant that has added restaurant/custom keys cannot safely roll back until those users are explicitly reassigned; rollback therefore fails closed rather than discarding values.
