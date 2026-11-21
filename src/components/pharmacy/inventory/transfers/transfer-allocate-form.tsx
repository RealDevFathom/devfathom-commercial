import { SelectField as StudioSelect } from '@/components/ui/select-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { TransferActionForm, type TransferStepAction } from './transfer-action-form';
import { selectClass } from './transfer-receive-form';

export type TransferOption = { value: string; label: string };

/** Rows offered per allocation; a row left without units is not sent. */
export const ALLOCATE_ROWS = 3;

/**
 * INV-07 allocate: pick stock lines from this branch and one destination
 * location. Allocation holds nothing — availability is re-checked at dispatch —
 * and needs a second person to approve before anything moves.
 */
export function TransferAllocateForm({
  branchId,
  stock,
  destinations,
  action,
}: {
  branchId: string;
  stock: ReadonlyArray<TransferOption>;
  destinations: ReadonlyArray<TransferOption>;
  action: TransferStepAction;
}) {
  return (
    <TransferActionForm action={action} className="grid gap-4" label="Allocate a transfer">
      <input name="action" type="hidden" value="allocate" />
      <input name="branchId" type="hidden" value={branchId} />
      <label className="text-sm">
        Destination branch and receiving location
        <StudioSelect className={selectClass} name="destination" required>
          {destinations.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </StudioSelect>
      </label>
      {Array.from({ length: ALLOCATE_ROWS }, (_, index) => (
        <div className="grid gap-3 md:grid-cols-[1fr_10rem]" key={index}>
          <label className="text-sm">
            Stock line {index + 1}
            {index > 0 ? ' (optional)' : ''}
            <StudioSelect
              className={selectClass}
              defaultValue={index === 0 ? undefined : ''}
              name={`position:${index}`}
            >
              {index > 0 ? <option value="">Not used</option> : null}
              {stock.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </StudioSelect>
          </label>
          <label className="text-sm">
            Units
            <Input
              className="mt-1"
              inputMode="numeric"
              min={1}
              name={`units:${index}`}
              required={index === 0}
              type="number"
            />
          </label>
        </div>
      ))}
      <Button type="submit">Allocate transfer</Button>
    </TransferActionForm>
  );
}
