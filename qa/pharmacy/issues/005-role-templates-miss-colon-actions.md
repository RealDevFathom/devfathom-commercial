[QA][Pharmacy][SEV1] Pharmacy role templates do not grant the actions the product checks
Labels: qa, pharmacy, sev1-critical, security

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Tenant: `http://qa-clifton.localhost:3000/organization`
- Signed in as `owner@qa-clifton.test`, organization role “Organization administrator” (`ALLOW *`)

## Test cases

PH-PM-01, PH-PM-02, PH-PM-03, PH-UR-01

## Steps

1. Sign in as the bootstrap pharmacy administrator.
2. Open `/organization` and read Custom roles.
3. Compare each ALLOW line with `capabilityMatches` in `src/lib/abac/index.ts`.

A cashier and a pharmacist user were not created. `/team` is the HR module, which this package does not enable, and the organization people card has no invite control (see issue 010). The grants below are the templates the product already installed.

## Expected

The role a pharmacy assigns for a job satisfies the checks that job performs. A wildcard written as `pharmacy.*` covers `pharmacy:dispense`, `pharmacy:safety`, `reports:financial`, and `reports:operational`. The Pharmacist template can dispense. The Cashier template can run the counter. Owner can see financial reports.

## Actual

`capabilityMatches` returns true only for `*`, an exact action string, or a rule that ends in `:*`. A dot rule such as `pharmacy.*` or `pharmacy.dispense` does not match a colon action such as `pharmacy:dispense`.

Live ALLOW lines on the organization page:

| Role | Grants shown | What those grants match |
| --- | --- | --- |
| Organization administrator | `ALLOW *` | Every action. This is the bootstrap role, not a pharmacy job template. |
| Owner | `pharmacy.*`, `pharmacy:orders` | `pharmacy:orders` only. `pharmacy.*` matches neither `pharmacy:dispense` nor `reports:financial`. |
| Owner / Operator | `pharmacy:catalogue-review`, `pharmacy:dispense`, `pharmacy:orders`, `pharmacy:safety`, `reports:financial`, `reports:operational` | Those colon actions. |
| Pharmacist | `pharmacy.dispense`, `pharmacy:catalogue-review` | Catalogue review only. `pharmacy.dispense` does not match `pharmacy:dispense`. |
| Manager | `pharmacy.manage`, `pharmacy:orders` | `pharmacy:orders` only. |
| Cashier | `pharmacy.counter`, `pharmacy:orders` | `pharmacy:orders` only. |
| Procurement | `pharmacy.procurement` | No colon action. |
| Inventory | `pharmacy.inventory` | No colon action. |
| Finance | `pharmacy.finance` | No colon action. `reports:financial` is not granted. |
| Auditor | `pharmacy.audit` | No colon action. |

`reports:financial` has an empty static policy list (`src/lib/abac/policies.ts`), so the decision is the custom role grant alone. Assigning Pharmacist, Cashier, Finance, or Owner does not grant the colon actions those names imply. Owner / Operator is the template that carries the colon grants, and provisioning does not assign it to the bootstrap owner.

## Evidence

- `qa/pharmacy/evidence/fu-_organization.txt` (Custom roles section)
- `qa/pharmacy/evidence/fu-_organization.png`

## Suggested code area

- `src/lib/vertical-catalog.ts` — `PHARMACY_ROLE_TEMPLATES`
- `src/lib/abac/index.ts` — `capabilityMatches`
- `src/lib/abac/policies.ts` — `reports:financial` policy list is empty
- Pharmacy procedure checks that require `pharmacy:dispense`, `pharmacy:safety`, `pharmacy:catalogue-review`, `pharmacy:orders`, `reports:operational`, `reports:financial`

No fix is proposed here.
