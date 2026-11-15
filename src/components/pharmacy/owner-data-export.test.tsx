// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OwnerDataExportConsole } from './owner-data-export';

describe('OwnerDataExportConsole time zone', () => {
  it('shows request times and the picked-date zone in the organization time zone', () => {
    render(
      <OwnerDataExportConsole
        timeZone="Asia/Karachi"
        initial={[
          {
            id: 'j1',
            status: 'QUEUED',
            requestedAt: '2026-11-03T13:24:00.000Z',
            expiresAt: null,
            downloadable: false,
            rowCounts: null,
          } as never,
        ]}
      />
    );
    expect(screen.getByText('3 Nov 2026, 6:24 PM PKT')).toBeTruthy();
    expect(screen.getByText(/read in your workspace timezone \(PKT\)/)).toBeTruthy();
  });
});
