import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const idle = {
  data: undefined,
  isFetching: false,
  isPending: false,
  error: null,
  refetch: vi.fn(),
};
const mutation = { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null };
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyMedicine: {
        get: { invalidate: vi.fn() },
        referenceCandidates: { invalidate: vi.fn() },
      },
    }),
    pharmacyMedicine: {
      catalogueQueueAccess: { useQuery: () => ({ data: { canEdit: true }, isPending: false }) },
      drapReferenceSearch: { useQuery: () => ({ ...idle, data: undefined }) },
      addMedicineDraft: { useMutation: () => mutation },
      search: { useQuery: () => idle },
      get: { useQuery: () => idle },
      createPackLevel: { useMutation: () => mutation },
      setPackBarcode: { useMutation: () => mutation },
    },
  },
}));

import { AddMedicineForm } from './add-medicine-form';
import { MedicinePackSetup } from './medicine-pack-setup';

afterEach(cleanup);

describe('DEV-935 medicines page accessible names', () => {
  it('gives the new-medicine and pack-search fields distinct names', () => {
    render(
      <>
        <AddMedicineForm />
        <MedicinePackSetup />
      </>
    );
    expect(screen.getByLabelText('New medicine name', { exact: true })).toBeVisible();
    expect(screen.getByLabelText('Find a medicine', { exact: true })).toBeVisible();
    expect(screen.queryByLabelText('Medicine name', { exact: true })).toBeNull();
  });

  it('has no two form controls with the same accessible name', () => {
    const { container } = render(
      <>
        <AddMedicineForm />
        <MedicinePackSetup />
      </>
    );
    const names: string[] = [];
    for (const control of container.querySelectorAll(
      'input:not([aria-hidden="true"]), select:not([aria-hidden="true"]), textarea, [data-select-field-trigger]'
    )) {
      if (control instanceof HTMLInputElement && ['hidden', 'radio'].includes(control.type))
        continue;
      const labelled = control.getAttribute('aria-label');
      const byId = control.getAttribute('aria-labelledby');
      const label =
        labelled ??
        (byId ? container.querySelector(`#${CSS.escape(byId)}`)?.textContent : null) ??
        control.closest('label')?.textContent ??
        '';
      names.push(label.replace(/\s+/g, ' ').trim());
    }
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});
