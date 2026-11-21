import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Dialog, DialogPortal } from '@/components/ui/dialog';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import {
  CounterNoPermission,
  CounterNote,
  CounterSheetFooter,
  CounterSheetHeader,
  CounterStateCard,
  counterSheetClassName,
} from './counter-sheet';

describe('DEV-977 phase 2B: the Counter v2 sheet frame', () => {
  it('sizes each sheet as the design draws it', () => {
    const dialog = counterSheetClassName('dialog');
    expect(dialog).toContain('rounded-t-xl');
    expect(dialog).toContain('lg:w-[min(35rem,calc(100vw-4rem))]');
    expect(dialog).toContain('lg:rounded-xl');
    const wide = counterSheetClassName('wide');
    expect(wide).toContain('inset-0');
    expect(wide).toContain('lg:w-[min(62.5rem,calc(100vw-4rem))]');
    const side = counterSheetClassName('side');
    expect(side).toContain('md:w-[28.75rem]');
    expect(side).toContain('lg:w-[30rem]');
    // Every sheet carries the pharmacy scope, so its metadata keeps the 12px step.
    for (const name of [dialog, wide, side]) {
      expect(name).toContain('pharmacy-workspace');
      expect(name).toContain('bg-surface-card');
    }
  });

  it('heads a sheet with an eyebrow, a title that names it, a subtitle and an icon close', () => {
    render(
      <Dialog open>
        <DialogPortal>
          <DialogPrimitive.Popup>
            <CounterSheetHeader eyebrow="Bill · 2 lines" title="Take payment" subtitle="Two" />
            <CounterSheetFooter>
              <button type="button">Done</button>
            </CounterSheetFooter>
          </DialogPrimitive.Popup>
        </DialogPortal>
      </Dialog>
    );
    const sheet = screen.getByRole('dialog', { name: 'Take payment' });
    expect(within(sheet).getByText('Bill · 2 lines')).toHaveAttribute('data-slot', 'eyebrow');
    expect(within(sheet).getByRole('heading', { name: 'Take payment' })).toBeInTheDocument();
    expect(within(sheet).getByText('Two')).toBeInTheDocument();
    const close = within(sheet).getByRole('button', { name: 'Close' });
    expect(close.textContent).toBe('');
    expect(close.className).toContain('size-11');
    expect(sheet.querySelector('[data-counter-sheet-foot]')).toHaveTextContent('Done');
  });

  it('never carries a tone by colour alone', () => {
    render(
      <>
        <CounterNote tone="danger">Below cost</CounterNote>
        <CounterStateCard tone="success" heading="Paid">
          Receipt printed.
        </CounterStateCard>
      </>
    );
    const note = screen.getByText('Below cost').closest('[data-counter-note]')!;
    expect(note).toHaveAttribute('data-counter-note', 'danger');
    expect(note.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    const state = screen.getByRole('heading', { name: 'Paid' }).closest('[data-counter-state]')!;
    expect(state).toHaveAttribute('data-counter-state', 'success');
    expect(state.querySelector('svg')).not.toBeNull();
  });

  it('says what an action needs, who can do it and the member’s role (C6)', () => {
    render(
      <CounterNoPermission
        heading="Ask a pharmacist"
        who="Pharmacists and the owner"
        role="Cashier"
      >
        <p>Needs the dispensing permission.</p>
      </CounterNoPermission>
    );
    const card = screen.getByRole('heading', { name: 'Ask a pharmacist' }).parentElement!;
    expect(card).toHaveTextContent('Needs the dispensing permission.');
    expect(within(card).getByText('Who can').nextElementSibling).toHaveTextContent(
      'Pharmacists and the owner'
    );
    expect(within(card).getByText('Your role').nextElementSibling).toHaveTextContent('Cashier');
    expect(within(card).queryByRole('button')).toBeNull();
  });
});
