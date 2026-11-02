import { Input } from '@/components/ui/input';
import { inputControl } from './controls';

/**
 * Whole-day period pickers read in the workspace zone (DEV-591). The action
 * converts `firstDay`/`lastDay` with `timezone` into the server's UTC `from`
 * and exclusive `cutoff`; see `./period`.
 */
export function PeriodFields({
  timeZone,
  firstDay,
  lastDay,
}: {
  timeZone: string;
  firstDay: string;
  /** Also the latest selectable day: yesterday in the workspace zone. */
  lastDay: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="timezone" value={timeZone} />
      <label className="text-sm">
        First day
        <Input
          name="firstDay"
          type="date"
          required
          defaultValue={firstDay}
          max={lastDay}
          className={inputControl}
        />
      </label>
      <label className="text-sm">
        Last day
        <Input
          name="lastDay"
          type="date"
          required
          defaultValue={lastDay}
          max={lastDay}
          className={inputControl}
        />
      </label>
    </div>
  );
}

/** A send date and time picked as wall time in the workspace zone. */
export function SendTimeField({
  timeZone,
  zone,
  defaultValue,
  label = 'Send date and time',
  required = true,
}: {
  timeZone: string;
  /** `zoneLabel(timeZone)`, shown so the owner knows which clock this is. */
  zone: string;
  defaultValue?: string;
  label?: string;
  required?: boolean;
}) {
  return (
    <>
      <input type="hidden" name="timezone" value={timeZone} />
      <label className="block text-sm">
        {label} ({zone})
        <Input
          name="scheduledAt"
          type="datetime-local"
          required={required}
          defaultValue={defaultValue}
          className={inputControl}
        />
      </label>
    </>
  );
}
