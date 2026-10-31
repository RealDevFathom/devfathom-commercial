# Restaurant delivery gap fixes

## Findings and resolution

1. **High — zone deactivation was irreversible: fixed.** Before this change, the server exposed only `deactivateZone`, the domain helper could only write `active: false`, and inactive rows had no recovery action. A tenant-and-branch-scoped `reactivateDeliveryZone` helper was added in `src/lib/restaurant/delivery.ts`, exposed through the capability-protected and audited `reactivateZone` mutation in `src/server/routers/restaurant-delivery.ts`, and connected to an explicit confirmation flow for inactive rows in `src/components/restaurant/delivery/delivery-console.tsx`. Tests cover scoped persistence, authorization/audit delegation, and the confirmed UI operation.

2. **Medium — unchecking the current default address falsely appeared to work: fixed.** The update helper intentionally has no valid transition to a state with no default address, but the edit form previously presented the current default as an ordinary checkbox. The current default is now visibly checked but disabled, with an explanation directing the operator to make another address the default.

3. **Medium — set-default API had no UI flow: fixed.** The existing narrow `setDefaultAddress` mutation is now wired into the console, included in pending/error/success handling and list invalidation, and exposed as **Make default** only on non-default address cards. The action submits only the selected customer and address identifiers rather than resubmitting PII.

## Scope notes

- No schema or migration change was needed.
- Tenant and branch predicates remain mandatory for zone state changes.
- Every new server mutation uses the central `restaurant:configure` capability procedure and branch-scope check.
- Customer pagination is outside this change.

## QA follow-up

- **Make default** has its own success handler, so a delayed response refreshes saved addresses and reports success without closing an unrelated editor or confirmation. Regression tests cover unsaved input in both Edit and Add address forms.
- Saved-address actions wrap so all three buttons remain inside the card at 320px.
- Row-level Deactivate/Reactivate zone actions are disabled while a delivery mutation is pending.
