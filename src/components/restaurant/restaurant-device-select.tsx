'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

export type RestaurantDeviceOption = {
  id: string;
  name: string;
  branch: { id: string; name: string };
  status: string;
};

export function RestaurantDeviceSelect({
  devices,
  branchId,
  name = 'deviceId',
  label = 'Device',
  loading = false,
  error = false,
  required = false,
  allowEmpty = false,
  value,
  onChange,
}: {
  devices: RestaurantDeviceOption[];
  branchId?: string;
  name?: string;
  label?: string;
  loading?: boolean;
  error?: boolean;
  required?: boolean;
  allowEmpty?: boolean;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const eligible = devices.filter(
    (device) => device.status === 'ACTIVE' && (!branchId || device.branch.id === branchId)
  );
  const unavailable = loading || error || eligible.length === 0;
  const prompt = loading
    ? 'Loading devices…'
    : error
      ? 'Devices unavailable — try again'
      : eligible.length === 0
        ? 'No active devices for this branch'
        : allowEmpty
          ? 'Any active device'
          : 'Select a device';

  return (
    <StudioSelect
      name={name}
      aria-label={label}
      required={required}
      disabled={unavailable}
      {...(value === undefined ? { defaultValue: '' } : { value })}
      onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <option value="" disabled={!allowEmpty}>
        {prompt}
      </option>
      {eligible.map((device) => (
        <option key={device.id} value={device.id}>
          {device.name} — {device.branch.name}
        </option>
      ))}
    </StudioSelect>
  );
}
