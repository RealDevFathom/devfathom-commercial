import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  PrinterRegistrationFields,
  printerDraftPayload,
  validPrinterDrafts,
  validPrinterTarget,
  type PrinterDraft,
} from './printer-registration-fields';
const row: PrinterDraft = {
  key: 'draft',
  name: ' Receipt ',
  address: ' tcp://printer:9100 ',
  paperWidthMm: 80,
};
function Form() {
  const [rows, setRows] = useState<PrinterDraft[]>([]);
  return <PrinterRegistrationFields rows={rows} onChange={setRows} />;
}
it('keeps surviving printer values and label identities when another row is removed', () => {
  render(<Form />);
  fireEvent.click(screen.getByRole('button', { name: 'Add printer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add printer' }));
  fireEvent.change(screen.getByLabelText('Printer 2 name'), { target: { value: 'Kitchen' } });
  fireEvent.change(screen.getByLabelText('Printer 2 target'), {
    target: { value: 'queue:///Kitchen' },
  });
  fireEvent.change(screen.getByLabelText('Printer 2 paper width'), { target: { value: '58' } });
  const id = screen.getByLabelText('Printer 2 name').id;
  fireEvent.click(screen.getByRole('button', { name: 'Remove printer 1' }));
  expect(screen.getByLabelText('Printer 1 name')).toHaveValue('Kitchen');
  expect(screen.getByLabelText('Printer 1 name').id).toBe(id);
  expect(screen.getByLabelText('Printer 1 target')).toHaveValue('queue:///Kitchen');
  expect(screen.getByLabelText('Printer 1 paper width')).toHaveValue('58');
});
it.each([
  'tcp://host:9100',
  'TCP://[::1]:9100',
  'tcp://host',
  'queue:///Kitchen',
  'QUEUE:///Receipt%20Printer',
  '/dev/usb/lp0',
  'serial:///dev/ttyUSB0',
  'file:///dev/usb/lp0',
])('accepts supported target format %s', (address) => {
  expect(validPrinterTarget(address)).toBe(true);
});
it.each([
  'https://printer',
  'tcp://user:secret@host',
  'tcp://host/path',
  'tcp://host:0',
  'tcp://host:65536',
  'tcp://host?key=secret',
  'queue://remote/Printer',
  'queue:///Bad%2FName',
  'queue:///%20Printer',
  'queue:///Bad%',
  '/tmp/receipt',
  'usb:///dev//lp0',
  'serial:///dev/%2e%2e/file',
  'queue:///Bad%00Name',
])('rejects unsupported or unsafe target format %s', (address) => {
  expect(validPrinterTarget(address)).toBe(false);
});
it('allows zero printers, caps rows at twenty, and disables all edits during submission', () => {
  const onChange = vi.fn();
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...row, key: `p${i}` }));
  const view = render(<PrinterRegistrationFields rows={rows} onChange={onChange} />);
  expect(screen.getByRole('button', { name: 'Add printer' })).toBeDisabled();
  view.rerender(<PrinterRegistrationFields rows={rows} onChange={onChange} disabled />);
  expect(screen.getByLabelText('Printer 1 name')).toBeDisabled();
  expect(screen.getByLabelText('Printer 1 paper width')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Remove printer 1' })).toBeDisabled();
  expect(validPrinterDrafts([])).toBe(true);
  expect(validPrinterDrafts(rows)).toBe(true);
  expect(validPrinterDrafts([...rows, row])).toBe(false);
});
it('prepares trimmed API payloads without UI keys and rejects incomplete or oversized drafts', () => {
  expect(printerDraftPayload([row])).toEqual([
    { name: 'Receipt', address: 'tcp://printer:9100', paperWidthMm: 80 },
  ]);
  for (const invalid of [
    { ...row, name: ' ' },
    { ...row, name: 'a'.repeat(121) },
    { ...row, address: '' },
    { ...row, address: 'a'.repeat(129) },
  ])
    expect(validPrinterDrafts([invalid])).toBe(false);
  expect(validPrinterDrafts([{ ...row, paperWidthMm: 58 }])).toBe(true);
});
