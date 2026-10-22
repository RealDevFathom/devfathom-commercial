# Issue #238 — already fixed

Verified against repository HEAD `16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca` (the merge of pull request #388). The checkout exposes this HEAD as the local `work` branch and does not contain a local or remote `main` ref.

The reported cashier upload mismatch is already resolved:

- The canonical pharmacy cashier role grants both `pharmacy:counter` and `pharmacy:orders` in `PHARMACY_ROLE_TEMPLATES`.
- Prescription file upload and capture authorize either `pharmacy:orders` or `pharmacy:dispense`, so a canonical cashier satisfies the upload guard without receiving clinical dispensing authority.
- The prescription router test covers successful image upload/capture through the `pharmacy:orders` authorization path.
- The database capability test verifies that a cashier resolves `pharmacy:orders` while remaining unauthorized for unrelated pharmacy capabilities.

No product code or tests were changed because the current implementation already meets the issue's expected behavior. Per the task constraint for the old environment, no test suite was executed.
