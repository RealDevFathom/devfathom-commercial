'use client';

import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select-field';
import type { SaleUnitKind } from '@/lib/pharmacy/counter-pricing';
import { trpc } from '@/lib/trpc';

export function CounterBranchUnitSetting({
  branchId,
  value,
}: {
  branchId: string;
  value: SaleUnitKind;
}) {
  const owner = trpc.pharmacySales.billDiscountSetting.useQuery({ branchId });
  const utils = trpc.useUtils();
  const save = trpc.pharmacySales.saveCounterDefaultSaleUnit.useMutation({
    onSettled: () => utils.pharmacySales.counterBranches.invalidate(),
  });
  if (!owner.data?.canChange) return null;
  return (
    <div className="space-y-1">
      <Label htmlFor="counter-branch-unit">Starting unit for new bills at this branch</Label>
      <SelectField
        id="counter-branch-unit"
        value={value}
        disabled={save.isPending}
        onChange={(event) =>
          save.mutate({ branchId, previous: value, unit: event.target.value as SaleUnitKind })
        }
      >
        <option value="UNIT">Unit</option>
        <option value="STRIP">Strip</option>
        <option value="PACK">Pack</option>
      </SelectField>
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      )}
    </div>
  );
}
