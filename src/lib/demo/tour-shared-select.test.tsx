// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RestaurantBranchSelect } from '@/components/restaurant/restaurant-branch-select';
import { TOUR_STEPS } from './tour';
import { prepareTourTarget } from './tour-preparation';

afterEach(cleanup);

const branches = [
  { id: 'closed', name: 'Closed', active: false, isDefault: false },
  { id: 'main', name: 'Main', active: true, isDefault: true },
  { id: 'second', name: 'Second', active: true, isDefault: false },
];

function TourSurface({ mode, initial = '' }: { mode: 'floor' | 'daily-close'; initial?: string }) {
  const [branch, setBranch] = useState(initial);
  const [tab, setTab] = useState(false);
  return (
    <>
      <RestaurantBranchSelect branches={branches} value={branch} onChange={setBranch} />
      {mode === 'daily-close' && (
        <button type="button" role="tab" onClick={() => setTab(true)}>
          Daily close
        </button>
      )}
      {branch && (mode === 'floor' || tab) && (
        <section data-tour={mode === 'floor' ? 'floor-table' : 'daily-close'}>
          Ready for {branch}
        </section>
      )}
    </>
  );
}

describe('restaurant demo preparation with the shared branch selector', () => {
  for (const [mode, step] of [
    ['floor', 3],
    ['daily-close', 5],
  ] as const) {
    it(`chooses a real shared option before showing ${mode}`, async () => {
      render(<TourSurface mode={mode} />);
      let preparation: ReturnType<typeof prepareTourTarget>;
      await act(async () => {
        preparation = prepareTourTarget(TOUR_STEPS[step], { document });
      });
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('Main (default)')
      );
      const prepared = await preparation!;
      expect(prepared.target).toHaveTextContent('Ready for main');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  }

  it('keeps an already selected branch when preparing daily close', async () => {
    render(<TourSurface mode="daily-close" initial="second" />);
    let preparation: ReturnType<typeof prepareTourTarget>;
    await act(async () => {
      preparation = prepareTourTarget(TOUR_STEPS[5], { document });
    });
    const prepared = await preparation!;
    expect(prepared.target).toHaveTextContent('Ready for second');
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('Second');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
