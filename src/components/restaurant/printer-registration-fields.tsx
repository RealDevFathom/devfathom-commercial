'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type PrinterDraft = { key: string; name: string; address: string; paperWidthMm: 58 | 80 };
/** Browser-only format check; the server remains authoritative about supported targets. */
export function validPrinterTarget(address: string) {
  const value = address.trim();
  if (!value || value.length > 128 || /[\x00-\x20\x7f]/.test(value)) return false;
  try {
    const target = new URL(value.startsWith('/') ? `file://${value}` : value);
    if (target.username || target.password || target.search || target.hash) return false;
    if (target.protocol === 'tcp:') {
      const port = Number(target.port || '9100');
      return (
        Boolean(target.hostname) &&
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65535 &&
        ['', '/'].includes(target.pathname)
      );
    }
    const path = decodeURIComponent(target.pathname);
    if (target.host || /[\x00-\x1f\x7f]/.test(path)) return false;
    if (target.protocol === 'queue:') {
      const queue = path.slice(1);
      return (
        path.startsWith('/') && Boolean(queue) && !/[/\\]/.test(queue) && queue.trim() === queue
      );
    }
    return (
      ['file:', 'usb:', 'serial:'].includes(target.protocol) &&
      path.startsWith('/dev/') &&
      path
        .split('/')
        .slice(1)
        .every(
          (part, index, parts) =>
            part !== '.' && part !== '..' && (part !== '' || index === parts.length - 1)
        )
    );
  } catch {
    return false;
  }
}
export function printerDraftPayload(rows: readonly PrinterDraft[]) {
  return rows.map(({ name, address, paperWidthMm }) => ({
    name: name.trim(),
    address: address.trim(),
    paperWidthMm,
  }));
}
export function validPrinterDrafts(rows: readonly PrinterDraft[]) {
  return (
    rows.length <= 20 &&
    rows.every(
      (row) =>
        row.name.trim().length > 0 &&
        row.name.trim().length <= 120 &&
        validPrinterTarget(row.address) &&
        [58, 80].includes(row.paperWidthMm)
    )
  );
}

export function PrinterRegistrationFields({
  rows,
  onChange,
  disabled = false,
}: {
  rows: readonly PrinterDraft[];
  onChange: (rows: PrinterDraft[]) => void;
  disabled?: boolean;
}) {
  const prefix = useId();
  const next = useRef(0);
  const update = (key: string, value: Partial<PrinterDraft>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...value } : row)));
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="mb-2 text-sm font-medium">Printers</legend>
      <p className="text-sm text-text-muted">
        Register up to 20 targets. Use tcp://host:9100, queue:///encoded-name, or a supported /dev/
        path. Registration does not verify connectivity.
      </p>
      {rows.map((row, index) => (
        <div key={row.key} className="space-y-3 rounded-md border border-border-default p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Printer {index + 1}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
            >
              Remove printer {index + 1}
            </Button>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${row.key}-name`} className="block text-sm">
              Printer {index + 1} name
            </label>
            <Input
              id={`${row.key}-name`}
              className="h-11"
              value={row.name}
              maxLength={120}
              required
              onChange={(event) => update(row.key, { name: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${row.key}-address`} className="block text-sm">
              Printer {index + 1} target
            </label>
            <Input
              id={`${row.key}-address`}
              className="h-11"
              value={row.address}
              maxLength={128}
              required
              autoComplete="off"
              aria-invalid={Boolean(row.address) && !validPrinterTarget(row.address)}
              aria-describedby={
                row.address && !validPrinterTarget(row.address) ? `${row.key}-error` : undefined
              }
              onChange={(event) => update(row.key, { address: event.target.value })}
            />
            {row.address && !validPrinterTarget(row.address) ? (
              <p id={`${row.key}-error`} role="alert" className="text-sm text-destructive">
                Use a valid TCP, local queue, or supported /dev/ target without credentials or query
                parameters.
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <label htmlFor={`${row.key}-width`} className="block text-sm">
              Printer {index + 1} paper width
            </label>
            <StudioSelect
              id={`${row.key}-width`}
              className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              value={row.paperWidthMm}
              onChange={(event) =>
                update(row.key, { paperWidthMm: event.target.value === '58' ? 58 : 80 })
              }
            >
              <option value="80">80 mm</option>
              <option value="58">58 mm</option>
            </StudioSelect>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        className="min-h-11"
        disabled={disabled || rows.length >= 20}
        onClick={() =>
          onChange([
            ...rows,
            { key: `${prefix}-${next.current++}`, name: '', address: '', paperWidthMm: 80 },
          ])
        }
      >
        Add printer
      </Button>
    </fieldset>
  );
}
