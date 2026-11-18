import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ReportPrintButton } from './report-print-button';

it('waits for streamed report content before allowing print', async () => {
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  try {
    render(
      <div data-report-print>
        <ReportPrintButton />
        <div aria-busy="true">Loading work pack</div>
      </div>
    );
    const button = screen.getByRole('button', { name: 'Preparing report for print…' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(print).not.toHaveBeenCalled();
    await act(async () => {
      document.querySelector('[aria-busy]')!.remove();
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeEnabled()
    );
    fireEvent.click(button);
    expect(print).toHaveBeenCalledOnce();
  } finally {
    print.mockRestore();
  }
});
