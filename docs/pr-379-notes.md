# PR #379 review notes

## Findings addressed

- The command-centre pharmacist-coverage count did not reject regulatory profiles whose qualified-person registration had expired. The query now requires `qualifiedPersonValidTo` to be strictly later than the read instant, matching the existing half-open validity convention.
- A future-dated qualified-person registration is not current coverage either. The query now also requires `qualifiedPersonValidFrom` to be at or before the same read instant.
- All effective-profile and qualified-person comparisons now share one captured timestamp. This avoids inconsistent boundary decisions if the clock advances between constructing individual predicates.
- The regression test uses a dedicated regulatory-profile count spy and asserts the complete predicate, including selected-branch scope and both effective and qualified-person validity windows.

## Review checks

- Tenant isolation remains enforced through the existing `ScopedDb` reader and database row-level security; the selected branch IDs remain explicit in the count predicate.
- The change does not alter authorization/grant resolution, pharmacy capability caps, or monetary calculations.
- No dependency installation or test execution was performed, as requested.
