# Emergency supply policy (DEV-98)

Emergency controlled-medicine supplies use the jurisdiction rule set linked to
the branch's current effective regulatory profile. Configure each province's
policy in `JurisdictionRuleSet.controlledRegisterFlags.values.emergencySupply`:

```json
{
  "maxUnits": 10,
  "repeatWindowHours": 72,
  "source": "JURISDICTION_RULE_SET"
}
```

These example numbers preserve the legacy policy; they do not establish a legal
limit. Both numbers must be positive integers. `maxUnits` counts canonical units
and must be a safe JavaScript integer. `repeatWindowHours` must not exceed
2,400,000,000 so the lookback remains a valid date. A configured policy may omit
`source`, which then resolves to `JURISDICTION_RULE_SET`.

Absent or malformed policies use 10 canonical units and a 72-hour repeat window,
marked `DEFAULT_POLICY`. New placeholder rule sets explicitly carry this default.
Existing immutable rule sets require no backfill. To change a province's policy,
publish a new jurisdiction rule-set version and link it through a new effective
branch regulatory profile using the existing versioning process. Do not update
historical rule sets or disable their immutability trigger.

The server checks prior emergency sales for the same organization, patient and
medicine across branches within the configured window. An open missing-Rx
follow-up continues to block another supply regardless of the elapsed window.
Existing pharmacist permission, witness, consent and stock checks still apply.

When emergency eligibility is evaluated, the request audit metadata records
`emergencySupply` with the rule-set ID, province, source, cap, repeat window,
medicine ID and requested canonical units, including refused requests. This
identifies the applied default even for historical rule sets without the field.
