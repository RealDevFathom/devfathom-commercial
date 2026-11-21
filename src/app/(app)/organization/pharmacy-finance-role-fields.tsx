'use client';

import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { PHARMACY_FINANCE_SUB_ROLES } from '@/lib/abac/pharmacy-sub-roles';
import { decideFromRules } from '@/lib/abac/capabilities';
import { organizationRolePermissionsSchema } from '@/lib/organization-role';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

export function PharmacyFinanceRoleFields({
  initial = [],
  disabled = false,
  errorId,
}: {
  initial?: Rule[];
  disabled?: boolean;
  errorId?: string;
}) {
  const [value, setValue] = useState(() =>
    JSON.stringify(
      initial.map(({ capability, effect }) => ({ capability, effect })),
      null,
      2
    )
  );
  let rules: Rule[] | undefined;
  try {
    rules = organizationRolePermissionsSchema.safeParse(JSON.parse(value)).data;
  } catch {
    // An unfinished advanced edit remains visible and cannot be replaced by a tick.
  }
  return (
    <fieldset aria-describedby={errorId} disabled={disabled} className="space-y-2">
      <legend className="text-sm font-semibold text-text-strong">Pharmacy accounts access</legend>
      {PHARMACY_FINANCE_SUB_ROLES.map(({ key, label, actions: [action] }) => {
        const others = rules?.filter((rule) => rule.capability !== action);
        const inherited = others && decideFromRules(others, action);
        return (
          <label key={key} className="flex min-h-11 items-center gap-3 text-sm text-text-body">
            <Checkbox
              disabled={disabled || !rules || inherited === false}
              checked={Boolean(rules && decideFromRules(rules, action))}
              onCheckedChange={(checked) => {
                if (!others || inherited === false) return;
                const next = [...others];
                if (checked !== Boolean(inherited))
                  next.push({ capability: action, effect: checked ? 'ALLOW' : 'DENY' });
                setValue(JSON.stringify(next, null, 2));
              }}
            />
            {label}
            {inherited === false ? ' (blocked by a deny rule)' : ''}
          </label>
        );
      })}
      <details>
        <summary className="cursor-pointer text-sm text-text-muted">
          Advanced permission rules
        </summary>
        <textarea
          name="permissions"
          aria-label="Permission rules"
          aria-invalid={!rules || Boolean(errorId)}
          aria-describedby={errorId}
          className="mt-2 min-h-28 w-full rounded-control border border-border-default bg-surface-raised p-2 font-mono text-sm text-text-body"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </details>
    </fieldset>
  );
}
