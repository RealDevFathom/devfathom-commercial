# DevFathom documentation

This is the starting point for all DevFathom documentation. Find the row that describes you and start with the link next to it.

## Start here

| You are…                                     | Start with                                      | Then read                                                                                        |
| -------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A pharmacy owner or manager                  | [Product overview](product/overview.md)         | [Pharmacy guide](product/pharmacy-guide.md)                                                      |
| A pharmacist or counter staff member         | [Pharmacy guide](product/pharmacy-guide.md)     | [Glossary](product/glossary.md)                                                                  |
| A restaurant owner, manager or cashier       | [Restaurant guide](product/restaurant-guide.md) | [Restaurant glossary](product/restaurant-glossary.md)                                            |
| In sales, or running a pilot with a customer | [Product overview](product/overview.md)         | [Pharmacy guide](product/pharmacy-guide.md)                                                      |
| New to the words we use                      | [Glossary](product/glossary.md)                 |                                                                                                  |
| An engineer or coding agent                  | Coming soon: developer onboarding guide         | For now, use [LOCAL_SETUP.md](LOCAL_SETUP.md) and [technical-overview.md](technical-overview.md) |

## What is in this folder today

- **[product/overview.md](product/overview.md)**: what DevFathom is and what it does, in plain words.
- **[product/pharmacy-guide.md](product/pharmacy-guide.md)**: a feature-by-feature guide for pharmacy owners and counter staff, including who is allowed to do what.
- **[product/glossary.md](product/glossary.md)**: short meanings of the words you will see in the app and in these guides.
- **[product/restaurant-guide.md](product/restaurant-guide.md)**: a plain-language guide for restaurant owners, managers and cashiers (draft).
- **[product/restaurant-glossary.md](product/restaurant-glossary.md)**: restaurant words in plain language (draft).

## Coming next

These guides are planned but not written yet:

- **Agency guide**: for agency owners and staff.
- **Developer guides**: setup, how the system is built, roles and permissions, testing, and how to contribute.
- **Deploy, operations and security guides**: for the technical team and security reviewers.

Hotel features are **not** covered by these docs. They are not part of the current product.

## Older documents

Some older files in this folder (for example `azure-deployment.md`) describe a previous Azure setup. **DEPRECATED: never deploy to Azure.** Azure has been shut down; deployments go to AWS. These files are kept for reference only until a decision is made about them. Do not follow them for new work.

## Rules for people writing these docs

- **Never put usernames, passwords or other login details in any doc.**
- Use the status vocabulary from the [living status ledger](status-ledger.md) (for example,
  **IMPLEMENTED**, **IN PROGRESS**, **PARTIAL**, **PLANNED**, **BLOCKED** and **FUTURE**) when making
  feature-status claims. "Complete" in an older document is not enough evidence; if another document
  disagrees, the current status ledger wins until the documents are reconciled.
- Take screenshots only from the demo pharmacy and the demo admin account on the test system, never from a real customer's account.
- If you are not sure something is true, write `TODO(confirm)` next to it rather than guessing.
- Content about DRAP rules and the controlled-drugs register stays marked **DRAFT – pending legal review** until a pharmacist or legal reviewer has checked it.
- TODO(confirm): which languages the customer guides should also be written in (for example Urdu or Roman Urdu).

## Existing technical and product references

These documents already existed before this guide set and are still useful:

- [Technical overview](technical-overview.md) and [Local setup](LOCAL_SETUP.md)
- [Admin platform handbook](admin-platform/README.md), including [tenancy/RLS](admin-platform/architecture-tenancy.md), [identity and access](admin-platform/identity-access.md), [data model](admin-platform/data-model.md), [entitlements](admin-platform/entitlements.md), [runbooks](admin-platform/runbooks.md) and the [security threat model](admin-platform/security-threat-model.md)
- [Product and commercial pack](product-pack.md), [pitch-deck source](pitch-deck.md) and the [living status ledger](status-ledger.md)
- Module PRDs: [POS & terminal](product/modules/pos-terminal.md), [Kitchen Display System](product/modules/kds.md)
- [Documentation QA](qa.md)
- [Azure deployment](azure-deployment.md): **DEPRECATED – never deploy to Azure.**
