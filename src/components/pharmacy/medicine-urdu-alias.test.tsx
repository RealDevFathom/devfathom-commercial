import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderWithIntl as render } from '@/test/intl';
const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  reset: vi.fn(),
  error: null as null | { data: { code: string } },
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyMedicine: { get: { invalidate: mocks.invalidate } } }),
    pharmacyMedicine: {
      addUrduAlias: {
        useMutation: () => ({
          mutateAsync: mocks.mutate,
          reset: mocks.reset,
          isPending: false,
          error: mocks.error,
        }),
      },
    },
  },
}));
import { MedicineUrduAlias } from './medicine-urdu-alias';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.error = null;
  mocks.mutate.mockResolvedValue({ id: 'alias-a' });
});
it('keeps invalid text local and sends the selected medicine and trimmed Urdu name', async () => {
  render(<MedicineUrduAlias medicineId="medicine-a" />);
  const field = screen.getByLabelText('Urdu medicine alias');
  fireEvent.change(field, { target: { value: 'Aspirin' } });
  expect(screen.getByRole('button', { name: 'Save Urdu alias' })).toBeDisabled();
  fireEvent.change(field, { target: { value: ' پیراسٹامول ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Urdu alias' }));
  await waitFor(() =>
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
      medicineId: 'medicine-a',
      value: 'پیراسٹامول',
    })
  );
  await screen.findByRole('status');
  expect(field).toHaveValue('');
  expect(mocks.invalidate).toHaveBeenCalledWith({ id: 'medicine-a' });
});
it('retains the Urdu name and shows a localized permission refusal', async () => {
  mocks.error = { data: { code: 'FORBIDDEN' } };
  mocks.mutate.mockRejectedValue(new Error('denied'));
  render(<MedicineUrduAlias medicineId="medicine-a" />, { locale: 'ur' });
  const field = screen.getByLabelText('دوا کا اردو متبادل نام');
  fireEvent.change(field, { target: { value: 'پیراسٹامول' } });
  fireEvent.click(screen.getByRole('button', { name: 'اردو نام محفوظ کریں' }));
  await screen.findByRole('alert');
  expect(field).toHaveValue('پیراسٹامول');
  expect(mocks.invalidate).not.toHaveBeenCalled();
  expect(field).toHaveAttribute('dir', 'rtl');
});
