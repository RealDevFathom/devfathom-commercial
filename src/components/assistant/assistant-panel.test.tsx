import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const state = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: [],
    status: state.error ? 'error' : 'ready',
    error: state.error,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    addToolApprovalResponse: vi.fn(),
  }),
}));
vi.mock('@/lib/assistant-store', () => ({
  useAssistant: () => ({ open: true, setOpen: vi.fn() }),
}));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./markdown', () => ({ AssistantMarkdown: () => null }));
import { AssistantPanel } from './assistant-panel';
beforeEach(() => {
  state.error = undefined;
  Element.prototype.scrollTo = vi.fn();
});
describe('assistant request error', () => {
  it('announces sanitized failure and keeps composer/close available', () => {
    state.error = new Error('private provider detail');
    render(<AssistantPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('No cached answer was used');
    expect(screen.queryByText(/private provider detail/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close assistant' })).toBeEnabled();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });
  it('has no failure alert before a request fails', () => {
    render(<AssistantPanel />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
