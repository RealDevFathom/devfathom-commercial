import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ReadinessChecklist,
  ReadinessChecklistSkeleton,
  type ReadinessChecklistRow,
} from './readiness-checklist';

const rows: ReadinessChecklistRow[] = [
  {
    key: 'ORG_TYPE',
    step: 1,
    label: 'Organization type',
    state: 'DONE',
    why: 'Recorded as a pharmacy workspace.',
    href: null,
    linkLabel: null,
  },
  {
    key: 'PREMISES_AND_LICENCES',
    step: 4,
    label: 'Premises and licences',
    state: 'NEEDS_YOU',
    why: 'Add a branch regulatory profile with a valid licence.',
    href: '/pharmacy/regulatory',
    linkLabel: 'Open regulatory profile',
  },
  {
    key: 'DEVICES_AND_DOCUMENTS',
    step: 11,
    label: 'Devices and documents',
    state: 'OPTIONAL',
    why: 'Record the counters and printers this site will use.',
    href: null,
    linkLabel: null,
  },
];

describe('ReadinessChecklist', () => {
  it('renders the walk as an ordered list, each row carrying its own state and reason', () => {
    render(<ReadinessChecklist rows={rows} title="Your setup steps" />);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText('Done')).toBeTruthy();
    expect(within(items[1]!).getByText('Needs you')).toBeTruthy();
    expect(within(items[2]!).getByText('Optional')).toBeTruthy();
    // The reason is on the row, not in one banner sentence (UX rule 13).
    expect(
      within(items[1]!).getByText('Add a branch regulatory profile with a valid licence.')
    ).toBeTruthy();
    expect(screen.getByText('1/3 done')).toBeTruthy();
  });

  it('links a row only where the caller supplied a real destination and a label', () => {
    render(<ReadinessChecklist rows={rows} title="Your setup steps" />);

    const link = screen.getByRole('link', { name: /Open regulatory profile/ });
    expect(link.getAttribute('href')).toBe('/pharmacy/regulatory');
    // A row with nowhere to go offers no link at all, rather than a dead one.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('states each status in text as well as colour, and keeps the step number readable', () => {
    render(<ReadinessChecklist rows={rows} title="Your setup steps" />);

    // Status is a labelled pill: colour is never the only carrier of state.
    for (const label of ['Done', 'Needs you', 'Optional']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    const heading = screen.getByRole('heading', { name: /Premises and licences/ });
    expect(heading.textContent).toContain('Step 4');
  });

  it('renders the caller’s control inside the row it belongs to, and nowhere else', () => {
    render(
      <ReadinessChecklist
        actions={{
          PREMISES_AND_LICENCES: <button type="button">Confirm this step</button>,
          ORG_TYPE: null,
        }}
        rows={rows}
        title="Your setup steps"
      />
    );

    const items = screen.getAllByRole('listitem');
    expect(within(items[1]!).getByRole('button', { name: 'Confirm this step' })).toBeTruthy();
    expect(within(items[0]!).queryByRole('button')).toBeNull();
  });

  it('ships an empty state that explains, rather than an empty panel', () => {
    render(
      <ReadinessChecklist
        emptyMessage="There is nothing to set up here yet."
        rows={[]}
        title="Your setup steps"
      />
    );
    expect(screen.getByText('There is nothing to set up here yet.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    // No count badge on an empty list — "0/0 done" reads as a failure.
    expect(screen.queryByText('0/0 done')).toBeNull();
  });

  it('ships a loading state in the same card geometry, announced to a screen reader', () => {
    const { container } = render(<ReadinessChecklistSkeleton rowCount={4} />);
    expect(container.querySelectorAll('li')).toHaveLength(4);
    expect(screen.getByText('Loading your setup steps.')).toBeTruthy();
  });

  it('anchors each row so an activation panel can link straight to the step', () => {
    const { container } = render(<ReadinessChecklist rows={rows} title="Your setup steps" />);
    expect(container.querySelector('#readiness-step-4')).toBeTruthy();
    expect(container.querySelector('#readiness-step-11')).toBeTruthy();
  });
});
