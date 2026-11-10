# Data model overview

> `prisma/schema.prisma` at `1906b530`: **491 models, 271 enums**, 211 migrations. The full model list by area is in Appendix D of [`../features/devfathom-all-features.md`](../features/devfathom-all-features.md).

## Groups

| Group | Count | Main models |
|---|---|---|
| Platform (`Platform*`) | 24 | `PlatformUser`, `PlatformSession`, `PlatformRecoveryCode`, `PlatformModule`, `PlatformPackage`, CRM (`PlatformAccount`, `PlatformLead`, `PlatformOpportunity`, `PlatformProposal`), commercial (`PlatformContract`, `PlatformInvoice`, `PlatformPayment`, `PlatformRenewal`), `PlatformJob`, `PlatformSupportSession`, `PlatformAuditLog`, `PlatformNotification` (new: AI cap alerts) |
| Tenancy (`Organization*`) | 16 | `Organization`, `OrganizationModule`, `OrganizationLimit`, `OrganizationRole`, `OrganizationRolePermission`, `OrganizationDomain`, identity (SSO/SCIM), `OrganizationLifecycleEvent` |
| AI (`AI*`) | 6 | `AIUsage`, `AISetting`, `AIModelPrice`, `AIProviderUsage`, `AIBudgetAlertMonth`, `AIAssistantAction` |
| Pharmacy (`Pharmacy*`) | 152 | branches and assignments; sales, tenders, refunds, drawer, daily close; khata and loyalty; patients, prescribers, prescriptions; pharmacist review and substitutions; controlled register; lots, stock ledger, counts, transfers, recalls; purchasing (requisition → quote → PO → goods receipt → returns, debit notes, supplier credits); supplier links and licences; bookkeeping, settlement, bank reconciliation, tax; migration and cutover; offline devices; marketing and WhatsApp; **procedures** (`PharmacySopSite`, `PharmacySopSiteSetting`, `PharmacySopEvidenceCapture`, `PharmacySopRecordLink`, `PharmacySopReworkNote`) |
| Restaurant (`Restaurant*`) | 164 | branches, staff, devices and terminal sessions; catalogue and recipes; menus; floor; orders and KDS; bills, payments, cash; tax; stock and purchasing; **the shared SOP engine** (`RestaurantSop*`); job roles and capabilities; loyalty, promotions, catering, delivery, shifts, insights, growth, cameras |
| Hotel (`Hotel*`) | 12 | `HotelProperty`, `HotelPropertyAssignment`, room types, rooms, beds, blocks, meal plans, function spaces and bookings, journey templates |
| Shared and agency | the rest | `User`, medicine reference (`Medicine`, `Ingredient`, `Presentation`, `PackLevel`, `MedicinePackMrp`, `MedicineBarcode`), agency (`Client`, `Project`, `Board`, `Task`, `TimeEntry`, `Invoice`, `Payment`), chat, meetings, notes, email, `AuditLog`, `Webhook`, `ApiToken`, CRM (`Customer*`, `Loyalty*`), cameras (`Camera*`), wallet passes, `OutboundEffect`, `RateLimitBucket` |

## Rules for new tables

1. **Tenant-scoped by default.** Add `organizationId`, with composite foreign keys that include it where you reference other tenant rows.
2. **An RLS policy in the same migration**, with `FORCE ROW LEVEL SECURITY`, plus test coverage. `db:push` can't create these, which is why it's disabled.
3. **Append-only where it's evidence.** Audit, register, proof-receipt and event tables must refuse UPDATE and DELETE (see the `*_append_only_rls` migrations). The tenant `audit_logs` table isn't append-only yet (open PR #171).
4. **Money** is stored in integer minor units or `Decimal`, never as a float. AI spend uses integer cents (`src/lib/ai/money.ts`).
5. **Per-organization uniqueness.** Business numbers are unique per organization, not globally. For example, agency invoice numbers became `@@unique([organizationId, invoiceNumber])` in #1226 and are allocated under a tenant advisory lock.
