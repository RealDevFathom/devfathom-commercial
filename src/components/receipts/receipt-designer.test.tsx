import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { ReceiptDesigner } from './receipt-designer';

const branch = { id: 'a', name: 'Branch A', revision: 0, layout: DEFAULT_RECEIPT_LAYOUT };
afterEach(() => vi.unstubAllGlobals());
describe('receipt designer', () => {
  it('renders Unicode layout text losslessly in the existing browser preview', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ branches: [branch] })));
    render(<ReceiptDesigner />);
    const footer = await screen.findByLabelText('Footer text (500 characters)');
    const text = 'شکریہ e\u0301 👩‍👩‍👧‍👦 '.repeat(6);
    fireEvent.change(footer, { target: { value: text } });
    expect(footer).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Sample receipt').textContent).toContain(text);
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeEnabled();
  });
  it('preserves draft after failed save and makes reset an explicit save', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ branches: [branch] }))
      .mockResolvedValueOnce(
        Response.json({ error: 'Conflict. Reload saved settings.' }, { status: 409 })
      );
    vi.stubGlobal('fetch', fetch);
    render(<ReceiptDesigner />);
    const footer = await screen.findByLabelText('Footer text (500 characters)');
    fireEvent.change(footer, { target: { value: 'Visit again soon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Conflict');
    expect(footer).toHaveValue('Visit again soon');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(footer).toHaveValue(DEFAULT_RECEIPT_LAYOUT.footerText);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('shows permission denial without an editable form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'Permission denied.' }, { status: 403 }))
    );
    render(<ReceiptDesigner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
    expect(screen.queryByRole('button', { name: 'Save layout' })).not.toBeInTheDocument();
  });
  it('marks invalid text and disables saving while retaining input', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ branches: [branch] })));
    render(<ReceiptDesigner />);
    const footer = await screen.findByLabelText('Footer text (500 characters)');
    fireEvent.change(footer, { target: { value: '<script>' } });
    expect(footer).toHaveAttribute('aria-invalid', 'true');
    expect(footer).toHaveValue('<script>');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save layout' })).toBeDisabled());
  });
});
