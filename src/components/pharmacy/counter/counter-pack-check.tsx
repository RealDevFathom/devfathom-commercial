'use client';

import { useState } from 'react';
import { Dialog as Primitive } from '@base-ui/react/dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogPortal, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select-field';
import { trpc } from '@/lib/trpc';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import {
  COUNTER_SHEET_BACKDROP,
  CounterSheetHeader,
  CounterSheetFooter,
  CounterNote,
  counterSheetClassName,
} from './counter-sheet';

type Props = {
  branchId: string;
  saleId: string;
  lines: { saleLineId: string; medicineName: string; packCheckBlocked?: boolean }[];
  disabled: boolean;
  refresh: () => Promise<unknown>;
};
export function CounterPackCheck(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="touch" disabled={props.disabled || !props.lines.length} />
        }
      >
        Pack check
      </DialogTrigger>
      <DialogPortal>
        <Primitive.Backdrop className={`fixed inset-0 z-50 ${COUNTER_SHEET_BACKDROP}`} />
        <Primitive.Popup className={counterSheetClassName('dialog')}>
          <CounterSheetHeader
            eyebrow="Pack check"
            title="Check a pack against this bill"
            subtitle="Scan the code printed on the pack. Each check is recorded."
          />
          {open && <PackForm {...props} />}
        </Primitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
function PackForm({ branchId, saleId, lines, disabled, refresh }: Props) {
  const [lineId, setLineId] = useState(
    (lines.find((l) => l.packCheckBlocked) ?? lines[0])?.saleLineId ?? ''
  );
  const [code, setCode] = useState('');
  const [result, setResult] = useState<{ matched: boolean; batchChecked: boolean } | null>(null);
  const [error, setError] = useState('');
  const check = trpc.pharmacySales.checkBillLinePack.useMutation();
  const selected = lines.find((l) => l.saleLineId === lineId);
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!selected || !code.trim() || check.isPending || disabled) return;
        setError('');
        setResult(null);
        try {
          const response = await check.mutateAsync({
            branchId,
            saleId,
            saleLineId: lineId,
            payload: code.trim(),
          });
          setResult(response);
          setCode('');
        } catch (e) {
          setError(counterErrorMessage(e));
        } finally {
          await refresh();
        }
      }}
    >
      <fieldset
        disabled={check.isPending || disabled}
        className="min-h-0 space-y-3 overflow-y-auto px-5 py-4"
      >
        <Label htmlFor="pack-line">Bill line</Label>
        <SelectField
          id="pack-line"
          value={lineId}
          onChange={(e) => {
            setLineId(e.target.value);
            setCode('');
            setResult(null);
            setError('');
          }}
        >
          {lines.map((l, i) => (
            <option key={l.saleLineId} value={l.saleLineId}>
              {i + 1}. {l.medicineName}
            </option>
          ))}
        </SelectField>
        <Label htmlFor="pack-code">Pack code</Label>
        <Input
          id="pack-code"
          autoComplete="off"
          value={code}
          maxLength={512}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Scan the pack"
        />
        {(result?.matched === false || (!result && selected?.packCheckBlocked)) && (
          <CounterNote tone="danger" role="alert">
            <b>This pack doesn’t match the bill line.</b> Set it aside and tell the pharmacist. Scan
            a matching pack or remove this line before taking payment.
          </CounterNote>
        )}
        {result?.matched && (
          <CounterNote tone={result.batchChecked ? 'success' : 'warning'} role="status">
            {result.batchChecked
              ? 'The pack matches this line’s allocated batch. Check recorded.'
              : 'Product matched. Batch not checked: confirm the batch on the pack.'}
          </CounterNote>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </fieldset>
      <CounterSheetFooter>
        <Button
          type="submit"
          size="touch"
          disabled={disabled || !selected || !code.trim() || check.isPending}
        >
          {check.isPending ? 'Checking…' : 'Check pack'}
        </Button>
      </CounterSheetFooter>
    </form>
  );
}
