# Loyalty voucher scope

**Status:** binding

The default pharmacy voucher scope is `WHOLE_BASKET`. `NON_DRUG_ONLY` is an
owner-configured tenant option and is never inferred as the default.

For `NON_DRUG_ONLY`, a sale line is ineligible when its canonical catalogue
medicine has either `rx` or `otc` classification. All other lines are eligible.
The voucher is capped at the eligible subtotal; money remains integer paisa.

Changing the option requires `pharmacy:loyalty-manage`. Central `can()` remains
the authorization decision point, so an explicit `DENY` overrides role or
wildcard `ALLOW`. Each change stores the complete old and new settings values.
