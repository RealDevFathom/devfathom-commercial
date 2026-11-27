import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WalletEditor } from './wallet-editor';

it('previews edits before saving, displays TEST and prints only the selected branch poster', async () => {
  const save = vi.fn().mockResolvedValue(undefined),
    poster = vi.fn().mockResolvedValue('/wallet/join/test');
  render(
    <WalletEditor
      design={{
        programDisplayName: 'Example',
        backgroundColor: '#ffffff',
        foregroundColor: '#111110',
        enabled: true,
        logo: null,
      }}
      mode="TEST"
      branches={[{ id: 'branch-a', name: 'North counter' }]}
      onSave={save}
      onPoster={poster}
    />
  );
  fireEvent.change(screen.getByLabelText('Programme name'), { target: { value: 'North rewards' } });
  expect(screen.getByRole('region', { name: 'Card preview' })).toHaveTextContent('North rewards');
  expect(screen.getByText(/unsigned/i)).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save design' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ programDisplayName: 'North rewards' })
    )
  );
  fireEvent.click(screen.getByRole('button', { name: /North counter/ }));
  await waitFor(() => expect(poster).toHaveBeenCalledWith('branch-a'));
  expect(
    await screen.findByRole('img', { name: 'North counter enrollment QR' })
  ).toBeInTheDocument();
});
