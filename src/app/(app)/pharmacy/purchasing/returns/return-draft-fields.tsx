'use client';

import { useState } from 'react';
import { Field, SelectField, TextField, type SelectOption } from '../_components/form-controls';
import type { Notice } from '../_lib/types';

type HeldReturn = {
  supplierId: string;
  disposition: 'QUARANTINE' | 'DAMAGED';
  quantityUnits: number;
};
type Lot = {
  key: string;
  label: string;
  locationName: string;
  availableUnits: number;
  approvedHeldReturns: HeldReturn[];
};

function heldLabel(hold: HeldReturn) {
  return `${hold.quantityUnits} ${hold.disposition === 'DAMAGED' ? 'damaged' : 'quarantined'} units approved for return`;
}

function QuantityField({
  name,
  notice,
  lot,
  held,
  fromQuality,
}: {
  name: string;
  notice: Notice | null;
  lot?: Lot;
  held: HeldReturn[];
  fromQuality: boolean;
}) {
  const approved = [...new Set(held.map((row) => row.quantityUnits))];
  if (lot && !lot.availableUnits && approved.length) {
    return (
      <SelectField
        label="Units"
        name={name}
        notice={notice}
        required
        defaultValue={approved.length === 1 ? String(approved[0]) : ''}
        options={approved.map((units) => ({ value: String(units), label: String(units) }))}
        emptyHint="Select an approved quantity."
        hint="Use the exact quantity from one quality review."
      />
    );
  }
  const hint = held.length
    ? `Choose up to ${lot?.availableUnits} available units or an exact approved quantity (${approved.join(', ')}). Matching approved quantities use held stock.`
    : undefined;
  function validate(input: HTMLInputElement | null) {
    if (!input) return;
    const units = input.valueAsNumber;
    input.setCustomValidity(
      lot && Number.isFinite(units) && units > lot.availableUnits && !approved.includes(units)
        ? (hint ?? `Enter up to ${lot.availableUnits} available units.`)
        : ''
    );
  }
  return (
    <Field label="Units" name={name} notice={notice} hint={hint}>
      {(control) => (
        <input
          {...control}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          required={Boolean(lot)}
          defaultValue={fromQuality && approved.length === 1 ? approved[0] : undefined}
          ref={validate}
          onChange={(event) => validate(event.currentTarget)}
        />
      )}
    </Field>
  );
}

export function ReturnDraftFields({
  suppliers,
  lots,
  slots,
  linkedLotKey,
  notice,
}: {
  suppliers: SelectOption[];
  lots: Lot[];
  slots: readonly number[];
  linkedLotKey: string;
  notice: Notice | null;
}) {
  const linkedLot = lots.find((lot) => lot.key === linkedLotKey);
  const linkedSuppliers = suppliers.filter((supplier) =>
    linkedLot?.approvedHeldReturns?.some((row) => row.supplierId === supplier.value)
  );
  const initialSupplier = linkedSuppliers.length === 1 ? linkedSuppliers[0]!.value : '';
  const [supplierId, setSupplierId] = useState(initialSupplier);
  const [picked, setPicked] = useState<Record<number, string>>(
    initialSupplier ? { 0: linkedLotKey } : {}
  );
  const choices = lots.flatMap((lot) => {
    const held = (lot.approvedHeldReturns ?? []).filter((row) => row.supplierId === supplierId);
    if (!lot.availableUnits && !held.length) return [];
    const amounts = [
      ...(lot.availableUnits > 0 ? [`${lot.availableUnits} available`] : []),
      ...new Set(held.map(heldLabel)),
    ];
    return [
      {
        lot,
        held,
        value: lot.key,
        label: `${lot.label} · ${amounts.join(' · ')} in ${lot.locationName}`,
      },
    ];
  });

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField label="Reference" name="reference" notice={notice} required />
        <SelectField
          emptyHint="No suppliers yet — add one on the supplier page."
          label="Supplier"
          name="supplierId"
          notice={notice}
          options={suppliers}
          required
          value={supplierId}
          onChange={(event) => {
            setSupplierId(event.target.value);
            setPicked({});
          }}
        />
        <SelectField
          defaultValue="PURCHASE_RETURN"
          emptyHint="—"
          label="Kind"
          name="kind"
          notice={notice}
          options={[
            { value: 'PURCHASE_RETURN', label: 'Purchase return' },
            { value: 'EXPIRY_CLAIM', label: 'Expiry claim' },
          ]}
        />
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-text-body">
          Lots — leave a slot empty to skip it
        </legend>
        {slots.map((slot) => {
          const chosen = choices.find((row) => row.value === picked[slot]);
          return (
            <div
              className="grid gap-3 rounded-[var(--radius-sm)] border border-border-subtle p-3 sm:grid-cols-2 lg:grid-cols-5"
              key={slot}
            >
              <SelectField
                className="lg:col-span-2"
                emptyHint={
                  supplierId
                    ? 'No lots eligible for return to this supplier.'
                    : 'Choose a supplier to see approved held returns.'
                }
                label={`Line ${slot + 1} — lot`}
                name={`lot-${slot}`}
                notice={notice}
                options={choices}
                value={chosen?.value ?? ''}
                onChange={(event) => setPicked({ ...picked, [slot]: event.target.value })}
                placeholder="Skip this line"
              />
              <QuantityField
                key={`${supplierId}:${chosen?.value ?? ''}`}
                name={`quantityUnits-${slot}`}
                notice={notice}
                lot={chosen?.lot}
                held={chosen?.held ?? []}
                fromQuality={slot === 0 && chosen?.value === linkedLotKey}
              />
              <TextField
                label="Return window ends"
                name={`returnWindowEndsAt-${slot}`}
                notice={notice}
                type="date"
                hint="The supplier's deadline."
              />
              <TextField
                inputMode="decimal"
                label="Expected credit (PKR)"
                name={`expectedCredit-${slot}`}
                notice={notice}
              />
              <TextField
                className="lg:col-span-5"
                label="Reason"
                name={`reason-${slot}`}
                notice={notice}
              />
            </div>
          );
        })}
      </fieldset>
    </>
  );
}
