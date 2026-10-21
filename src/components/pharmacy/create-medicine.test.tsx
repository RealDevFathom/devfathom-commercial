import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  mutation: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as unknown },
  invalidate: vi.fn(),
  success: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyMedicine: { referenceCandidates: { invalidate: mocks.invalidate } },
    }),
    pharmacyMedicine: {
      createMedicine: {
        useMutation: (options: { onSuccess: () => Promise<void> }) => {
          mocks.success = options.onSuccess;
          return mocks.mutation;
        },
      },
    },
  },
}));
import { CreateMedicine } from './create-medicine';
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutation.isPending = false;
  mocks.mutation.error = null;
});
function fill() {
  for (const [label, value] of [
    ['Product name', 'Paracetamol'],
    ['Generic ingredient name', 'Paracetamol'],
    ['Strength (for example, 500 mg)', '500 mg'],
    ['Dosage form', 'Tablet'],
    ['Presentation (for example, 10 tablets)', '10 tablets'],
    ['DRAP registration number', 'REG-123'],
    ['Manufacturer', 'Example maker'],
    ['Evidence source (pack label or registration record)', 'Pack and regulator record'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
it('explains the no-import first medicine path and creates an unreviewed draft using the existing procedure', () => {
  render(<CreateMedicine />);
  fill();
  expect(screen.getByText(/No import is needed/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Create medicine' }));
  const input = mocks.mutation.mutate.mock.calls[0][0];
  expect(input).toMatchObject({
    productName: 'Paracetamol',
    productFamily: 'PHARMACEUTICAL',
    saleable: false,
  });
  expect(input).not.toHaveProperty('organizationId');
  expect(input.provenance).toHaveLength(7);
  expect(input.provenance).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: 'drapRegistrationNumber',
        status: 'UNREVIEWED',
        sourceType: 'USER',
        assertedValue: expect.objectContaining({ value: 'REG-123', blockingIssues: [] }),
      }),
    ])
  );
  expect(input.provenance.every((p: object) => !('reviewer' in p))).toBe(true);
});
it('blocks ambiguous strengths and preserves the facts', () => {
  render(<CreateMedicine />);
  fill();
  fireEvent.change(screen.getByLabelText(/Strength \(/), { target: { value: '500 mg / 5 ml' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create medicine' }));
  expect(mocks.mutation.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('one positive strength');
  expect(screen.getByLabelText(/Strength \(/)).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Product name')).toHaveValue('Paracetamol');
});
it.each(['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED'])(
  'keeps entries after %s and disables denied retries',
  (code) => {
    const view = render(<CreateMedicine />);
    fill();
    mocks.mutation.error = { message: 'Denied', data: { code } };
    view.rerender(<CreateMedicine />);
    expect(screen.getByRole('alert')).toHaveTextContent('entries are preserved');
    expect(screen.getByLabelText('Product name')).toHaveValue('Paracetamol');
    if (code !== 'BAD_REQUEST')
      expect(screen.getByRole('button', { name: 'Create medicine' })).toBeDisabled();
  }
);
it('prevents duplicate pending submissions and refreshes candidates after creation', async () => {
  const view = render(<CreateMedicine />);
  fill();
  mocks.mutation.isPending = true;
  view.rerender(<CreateMedicine />);
  expect(screen.getByRole('button', { name: 'Creating medicine…' })).toBeDisabled();
  expect(screen.getByLabelText('Product name')).toBeDisabled();
  await mocks.success?.();
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('accept them, then publish and add a pack')
  );
  expect(mocks.invalidate).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Add another medicine' }));
  expect(screen.getByLabelText('Product name')).toHaveValue('');
});
