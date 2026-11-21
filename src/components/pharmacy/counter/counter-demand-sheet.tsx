'use client';

import { useRef, useState } from 'react';
import { Dialog as Primitive } from '@base-ui/react/dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogPortal, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select-field';
import { browserUuid } from '@/lib/browser-uuid';
import { trpc } from '@/lib/trpc';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import {
  COUNTER_SHEET_BACKDROP,
  CounterSheetHeader,
  CounterSheetFooter,
  counterSheetClassName,
} from './counter-sheet';

const reasons = {
  STOCKOUT: 'Out of stock',
  NOT_CARRIED: 'We don’t stock it',
  PACK_UNAVAILABLE: 'Pack size not available',
  PRICE_REJECTED: 'Too expensive',
  SUBSTITUTE_DECLINED: 'Didn’t want the alternative',
} as const;

type Props = {
  branchId: string;
  query: string;
  medicines: { medicineId: string; displayName: string }[];
  patient: { patientId: string; displayName: string } | null;
  disabled: boolean;
  onSaved: (message: string) => void;
};

export function CounterDemandSheet(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button type="button" variant="outline" size="touch" disabled={props.disabled} />}
      >
        Customer asked for it
      </DialogTrigger>
      <DialogPortal>
        <Primitive.Backdrop className={`fixed inset-0 z-50 ${COUNTER_SHEET_BACKDROP}`} />
        <Primitive.Popup className={counterSheetClassName('dialog')}>
          <CounterSheetHeader
            eyebrow="Restock demand"
            title="Customer asked for it"
            subtitle="Record what the customer wanted at this branch."
          />
          {open && (
            <DemandForm
              {...props}
              onSaved={(message) => {
                props.onSaved(message);
                setOpen(false);
              }}
            />
          )}
        </Primitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
function DemandForm({ branchId, query, medicines, patient, disabled, onSaved }: Props) {
  const [text, setText] = useState(query);
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState<keyof typeof reasons>('STOCKOUT');
  const [notify, setNotify] = useState(false);
  const [reserve, setReserve] = useState(false);
  const [channel, setChannel] = useState<'SMS' | 'WHATSAPP'>('SMS');
  const [error, setError] = useState('');
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  const save = trpc.pharmacySales.recordCounterDemand.useMutation();
  const options = Array.from(new Map(medicines.map((row) => [row.medicineId, row])).values());
  const [medicineId, setMedicineId] = useState(
    options.find((row) => row.displayName === query)?.medicineId ?? ''
  );
  const eligible = Boolean(medicineId && patient);
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={async (e) => {
        e.preventDefault();
        if (disabled || save.isPending) return;
        const input = {
          branchId,
          requestedText: text.trim(),
          requestedMedicineId: medicineId || undefined,
          quantity: Number(quantity),
          reason,
          followUp:
            notify && eligible && patient
              ? { patientId: patient.patientId, channel, reserveOnArrival: reserve }
              : undefined,
        };
        const payload = JSON.stringify(input);
        if (attempt.current?.payload !== payload) attempt.current = { payload, id: browserUuid() };
        setError('');
        try {
          await save.mutateAsync({ ...input, requestId: attempt.current.id });
          onSaved(`Recorded ${quantity} units of ${text} on the restock list.`);
        } catch (e) {
          setError(counterErrorMessage(e));
        }
      }}
    >
      <fieldset
        disabled={save.isPending || disabled}
        className="min-h-0 space-y-3 overflow-y-auto px-5 py-4"
      >
        {options.length > 0 && (
          <>
            <Label htmlFor="asked-match">Medicine from search results</Label>
            <SelectField
              id="asked-match"
              value={medicineId}
              onChange={(e) => {
                const id = e.target.value;
                setMedicineId(id);
                setNotify(false);
                const row = options.find((m) => m.medicineId === id);
                if (row) setText(row.displayName);
              }}
            >
              <option value="">Enter a medicine name</option>
              {options.map((row) => (
                <option key={row.medicineId} value={row.medicineId}>
                  {row.displayName}
                </option>
              ))}
            </SelectField>
          </>
        )}
        <Label htmlFor="asked-name">Requested medicine</Label>
        <Input
          id="asked-name"
          required
          maxLength={250}
          value={text}
          readOnly={Boolean(medicineId)}
          onChange={(e) => setText(e.target.value)}
        />
        <Label htmlFor="asked-reason">Why they couldn’t buy it</Label>
        <SelectField
          id="asked-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value as keyof typeof reasons)}
        >
          {Object.entries(reasons).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
        <Label htmlFor="asked-qty">How many units they wanted</Label>
        <Input
          id="asked-qty"
          required
          type="number"
          min={1}
          max={2147483647}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={notify && eligible}
            disabled={!eligible}
            onChange={(e) => setNotify(e.target.checked)}
          />
          Tell the customer when it’s back
        </label>
        {!eligible && (
          <p className="text-sm text-text-muted">
            Select a catalogue medicine and link a patient for a restock reminder.
          </p>
        )}
        {notify && eligible && (
          <>
            <p>Reminder for {patient?.displayName}</p>
            <Label htmlFor="asked-channel">Message by</Label>
            <SelectField
              id="asked-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as typeof channel)}
            >
              <option value="SMS">SMS</option>
              <option value="WHATSAPP">WhatsApp</option>
            </SelectField>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={reserve}
                onChange={(e) => setReserve(e.target.checked)}
              />
              Keep it aside for them when it arrives
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </fieldset>
      <CounterSheetFooter>
        <Button type="submit" size="touch" disabled={disabled || save.isPending || !text.trim()}>
          {save.isPending ? 'Saving…' : 'Save request'}
        </Button>
      </CounterSheetFooter>
    </form>
  );
}
