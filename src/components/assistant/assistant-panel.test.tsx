import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'next-auth';
import { type UIMessage, type UIMessageChunk, createUIMessageStreamResponse } from 'ai';
import { EntitlementsProvider } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';
import { useAssistant } from '@/lib/assistant-store';

const fixtures = vi.hoisted(() => ({
  session: vi.fn(),
  messages: [] as UIMessage[],
  reducedMotion: false,
}));
vi.mock('next-auth/react', () => ({ useSession: fixtures.session }));
vi.mock('motion/react', () => ({ useReducedMotion: () => fixtures.reducedMotion }));
// Seed tool states while retaining the installed SDK's transport, streaming,
// status changes, approval continuation, stop and unmount behavior.
vi.mock('@ai-sdk/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-sdk/react')>();
  return {
    ...actual,
    useChat: (options: Parameters<typeof actual.useChat>[0]) =>
      actual.useChat({ ...options, messages: fixtures.messages }),
  };
});

import { AssistantPanel } from './assistant-panel';

const user: Session['user'] = {
  id: 'synthetic-user-a',
  organizationId: 'synthetic-org-a',
  organizationSlug: 'synthetic',
  organizationStatus: 'ACTIVE',
  name: 'Synthetic User',
  email: 'synthetic@example.invalid',
  role: 'EMPLOYEE',
  department: 'QUALITY',
  title: 'Test',
  status: 'ACTIVE',
};
const fetchMock = vi.fn<typeof fetch>();
const scrollTo = vi.fn();

function entitlement(
  vertical: EntitlementView['vertical'] = 'AGENCY',
  enabledModules = ['projects', 'notes', 'meetings']
): EntitlementView {
  return {
    organizationId: user.organizationId,
    vertical,
    enabledModules,
    seatLimit: 5,
    activeSeats: 1,
    modules: [],
    limits: {},
  };
}
function panel(value = entitlement()) {
  return (
    <EntitlementsProvider value={value}>
      <AssistantPanel />
    </EntitlementsProvider>
  );
}
function response(chunks: UIMessageChunk[] = []) {
  return createUIMessageStreamResponse({
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of [
          { type: 'start', messageId: 'synthetic-answer' },
          ...chunks,
          { type: 'finish', finishReason: 'stop' },
        ] as UIMessageChunk[])
          controller.enqueue(chunk);
        controller.close();
      },
    }),
  });
}
function answer(text = 'Synthetic answer') {
  return response([
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
  ]);
}
function enter(text = 'Find my notes') {
  fireEvent.change(screen.getByLabelText('Your question'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}
function tool(part: Record<string, unknown>, text?: string) {
  fixtures.messages = [
    {
      id: 'synthetic-tool-message',
      role: 'assistant',
      parts: [
        {
          type: 'tool-createNote',
          toolCallId: 'call',
          input: { title: 'Synthetic note' },
          ...part,
        },
        ...(text ? [{ type: 'text', text }] : []),
      ],
    } as UIMessage,
  ];
}
function pendingFetch() {
  let signal: AbortSignal | null | undefined;
  fetchMock.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        signal = options?.signal;
        signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), {
          once: true,
        });
      })
  );
  return () => signal;
}

beforeEach(() => {
  fixtures.messages = [];
  fixtures.reducedMotion = false;
  fixtures.session.mockReturnValue({ data: { user }, status: 'authenticated' });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => answer());
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollTo = scrollTo;
  scrollTo.mockClear();
  useAssistant.setState({ open: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Ask Fathom context and suggestions', () => {
  it.each([
    ['AGENCY', ['projects', 'notes'], 'Your agency workspace', 'Show my open tasks'],
    [
      'RESTAURANT',
      ['restaurant-core', 'notes'],
      'Your restaurant workspace',
      'Find notes I can access',
    ],
    ['PHARMACY', ['pharmacy-core', 'notes'], 'Your pharmacy workspace', 'Find notes I can access'],
  ] as const)('uses canonical %s context', (vertical, modules, heading, suggestion) => {
    render(panel(entitlement(vertical, [...modules])));
    expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    expect(screen.getByRole('button', { name: suggestion })).toBeEnabled();
    expect(screen.queryByText(/Aisha/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /financ|revenue|profit/i })
    ).not.toBeInTheDocument();
    if (vertical !== 'AGENCY')
      expect(screen.queryByRole('button', { name: /projects|tasks/i })).not.toBeInTheDocument();
  });
  it('describes existing Restaurant and Catering reports only under the canonical core entitlement', () => {
    const view = render(panel(entitlement('RESTAURANT', ['restaurant-core'])));
    expect(screen.getByText(/Restaurant and Catering reports/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /catering/i })).not.toBeInTheDocument();
    view.rerender(panel(entitlement('RESTAURANT', [])));
    expect(screen.getByText(/Restaurant reports are not enabled/)).toBeVisible();
    expect(screen.queryByText(/Catering/)).not.toBeInTheDocument();
  });
  it('describes the existing Pharmacy report tool only when entitled', () => {
    const view = render(panel(entitlement('PHARMACY', ['pharmacy-reports'])));
    expect(screen.getByText(/Report access is checked when you ask/)).toBeVisible();
    view.rerender(panel(entitlement('PHARMACY', [])));
    expect(screen.getByText(/Pharmacy reports are not enabled/)).toBeVisible();
  });
  it.each(['EMPLOYEE', 'HR', 'ADMIN'])(
    'does not infer financial grants from the %s role',
    (role) => {
      fixtures.session.mockReturnValue({
        data: { user: { ...user, role } },
        status: 'authenticated',
      });
      render(panel(entitlement('AGENCY', ['finance'])));
      expect(screen.queryByRole('button', { name: /finance/i })).not.toBeInTheDocument();
      expect(screen.getByText(/No suggested actions/)).toBeVisible();
    }
  );
  it.each(['loading', 'unauthenticated'] as const)(
    'fails closed for %s session context',
    (status) => {
      fixtures.session.mockReturnValue({ data: null, status });
      render(panel());
      expect(screen.getByLabelText('Your question')).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Show my open tasks' })).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it.each([undefined, 'UNKNOWN'])('fails closed for unknown business type %s', (vertical) => {
    render(panel({ ...entitlement(), vertical: vertical as EntitlementView['vertical'] }));
    expect(screen.getByText(/Workspace context is unavailable/)).toBeVisible();
    expect(screen.getByLabelText('Your question')).toBeDisabled();
  });
  it('does not use the URL as tenant or business-type authority', () => {
    window.history.replaceState({}, '', '/?vertical=AGENCY&organizationId=other');
    render(panel(entitlement('PHARMACY', [])));
    expect(screen.getByRole('heading', { name: 'Your pharmacy workspace' })).toBeVisible();
    window.history.replaceState({}, '', '/');
  });
  it('rejects a revoked session and hides suggestions', () => {
    fixtures.session.mockReturnValue({
      data: { user: { ...user, sessionRevoked: true } },
      status: 'authenticated',
    });
    render(panel());
    expect(screen.getByText(/Your session has ended/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});

describe('Ask Fathom request and result states', () => {
  it('shows setup guidance without retry or provider diagnostics and preserves the question', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "Ask Fathom isn't set up yet, contact support." }, { status: 503 })
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(panel());
    enter();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Ask Fathom isn't set up yet, contact support."
    );
    expect(screen.queryByRole('button', { name: 'Review and retry' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your question')).toHaveValue('Find my notes');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Your question'), { key: 'Enter' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([['ASSISTANT_REQUEST_FAILED']]);
    log.mockRestore();
  });
  it('has no failure alert before a request fails', () => {
    render(panel());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('offers pharmacy report example questions and hints on an empty send', () => {
    render(panel(entitlement('PHARMACY', ['pharmacy-reports'])));
    expect(screen.getByRole('button', { name: "What are today's sales?" })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Which medicines are expiring soon?' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Your question'), { key: 'Enter' });
    expect(screen.getByText('Type a question before sending.')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'x' } });
    expect(screen.queryByText('Type a question before sending.')).not.toBeInTheDocument();
  });
  it('sends an entitled suggestion through the SDK and shows its response', async () => {
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Find notes I can access' }));
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].parts[0].text).toBe(
      'Find notes I can access'
    );
    expect(screen.getByLabelText('Your question')).toHaveValue('');
  });
  it('retains the draft on provider failure and requires review before an explicit retry', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('synthetic provider diagnostic must not render', { status: 503 })
    );
    render(panel());
    enter();
    expect(await screen.findByRole('alert')).toHaveTextContent('currently unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('No cached answer was used');
    expect(screen.getByRole('button', { name: 'Close assistant' })).toBeEnabled();
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(screen.getByLabelText('Your question')).toHaveValue('Find my notes');
    expect(screen.queryByText(/synthetic provider diagnostic/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review and retry' }));
    expect(screen.getByLabelText('Your question')).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403])(
    'shows permission denial for HTTP %s without a retry or discarded draft',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response('denied', { status }));
      render(panel());
      enter();
      expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
      expect(screen.getByLabelText('Your question')).toHaveValue('Find my notes');
      expect(screen.getByLabelText('Your question')).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Review and retry' })).not.toBeInTheDocument();
    }
  );
  it('shows an explicit empty response and retains its question', async () => {
    fetchMock.mockResolvedValueOnce(response());
    render(panel());
    enter();
    expect(await screen.findByText(/No answer was returned/)).toBeVisible();
    expect(screen.getByLabelText('Your question')).toHaveValue('Find my notes');
  });
  it('shows pending status and stops the request without claiming rollback', async () => {
    const signal = pendingFetch();
    render(panel());
    enter();
    expect(await screen.findByText('Working on your request…')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(signal()?.aborted).toBe(true));
    expect(screen.getByText(/Completed actions are not undone/)).toBeVisible();
    expect(screen.getByLabelText('Your question')).toHaveValue('Find my notes');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('sends explicit approval=%s and waits for a result', async (approved) => {
    tool({ state: 'approval-requested', approval: { id: 'approval' } });
    pendingFetch();
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: approved ? 'Confirm & run' : 'Cancel' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.messages[0].parts[0].approval.approved).toBe(approved);
    expect(
      screen.getByText(approved ? 'Approved — awaiting result' : 'Cancellation pending')
    ).toBeVisible();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });
  it('keeps a failed write visible even beside a successful answer and other tool result', () => {
    tool(
      { state: 'output-error', errorText: 'Synthetic write was denied' },
      'Other information is available.'
    );
    fixtures.messages[0].parts.push({
      type: 'tool-searchNotes',
      state: 'output-available',
      toolCallId: 'read',
      input: {},
      output: [],
    });
    render(panel());
    expect(screen.getByText('Synthetic write was denied')).toBeVisible();
    expect(screen.getByText('Other information is available.')).toBeVisible();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });
  it.each(['refusal', 'cannot_answer', 'unavailable'])(
    'shows Pharmacy %s output as failure',
    (kind) => {
      tool({
        type: 'tool-askPharmacyReports',
        state: 'output-available',
        output: { kind, message: 'Synthetic report unavailable' },
      });
      render(panel(entitlement('PHARMACY', ['pharmacy-reports'])));
      expect(screen.getByText('Synthetic report unavailable')).toBeVisible();
      expect(screen.queryByText('Done')).not.toBeInTheDocument();
      expect(screen.queryByText('Read pharmacy reports')).not.toBeInTheDocument();
    }
  );
  it.each([
    ['askPharmacyReports', 'pharmacy reports', 'PHARMACY', 'pharmacy-reports'],
    ['askPharmacyBusinessInsights', 'pharmacy business insights', 'PHARMACY', 'pharmacy-reports'],
    ['askPharmacyFinanceInsights', 'pharmacy finance insights', 'PHARMACY', 'pharmacy-reports'],
    ['askRestaurantReports', 'restaurant reports', 'RESTAURANT', 'restaurant-core'],
  ] as const)('labels successful %s as a read', (name, label, vertical, module) => {
    tool({
      type: `tool-${name}`,
      state: 'output-available',
      output: { kind: 'answer', claims: [] },
    });
    render(panel(entitlement(vertical, [module])));
    expect(screen.getByText(`Read ${label}`)).toBeVisible();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });
  it('shows a declined tool as cancelled', () => {
    tool({ state: 'output-denied' });
    render(panel());
    expect(screen.getByText('Cancelled')).toBeVisible();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });
  it('shows a business refusal instead of a completed write', () => {
    tool({ state: 'output-available', output: { error: 'Synthetic action refused' } });
    render(panel());
    expect(screen.getByText('Synthetic action refused')).toBeVisible();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });
});

describe('Ask Fathom lifecycle and keyboard', () => {
  it('blocks a queued request if the tenant changes before transport fetch', async () => {
    const view = render(panel());
    expect(fetchMock).not.toHaveBeenCalled();
    enter('Prior tenant queued question');
    fixtures.session.mockReturnValue({
      data: { user: { ...user, organizationId: 'synthetic-org-b' } },
      status: 'authenticated',
    });
    view.rerender(panel({ ...entitlement(), organizationId: 'synthetic-org-b' }));
    // Let the real SDK resolve request options and invoke the old transport.
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Prior tenant queued question')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your question')).toHaveValue('');
    enter('New tenant question');
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain('Prior tenant queued question');
  });
  it('aborts and removes the old conversation when tenant context changes', async () => {
    const signal = pendingFetch();
    const view = render(panel());
    enter('Prior tenant draft');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fixtures.session.mockReturnValue({
      data: { user: { ...user, organizationId: 'synthetic-org-b' } },
      status: 'authenticated',
    });
    view.rerender(panel());
    expect(screen.queryByText('Prior tenant draft')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your question')).toHaveValue('');
    expect(screen.getByLabelText('Your question')).toBeDisabled();
    await waitFor(() => expect(signal()?.aborted).toBe(true));
    fetchMock.mockImplementation(async () => answer('New tenant answer'));
    view.rerender(panel({ ...entitlement(), organizationId: 'synthetic-org-b' }));
    enter('New tenant question');
    expect(await screen.findByText('New tenant answer')).toBeVisible();
    expect(String(fetchMock.mock.calls[1][1]?.body)).not.toContain('Prior tenant draft');
  });
  it('preserves conversation across close/reopen and closes with Escape', async () => {
    render(panel());
    enter();
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    fireEvent.keyDown(screen.getByLabelText('Your question'), { key: 'Escape' });
    await waitFor(() => expect(useAssistant.getState().open).toBe(false));
    act(() => useAssistant.setState({ open: true }));
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('honors reduced motion for scrolling and uses a named dialog', async () => {
    fixtures.reducedMotion = true;
    render(panel());
    expect(screen.getByRole('dialog', { name: 'Ask Fathom' })).toBeVisible();
    enter();
    await screen.findByText('Synthetic answer');
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });
  it('keeps Shift+Enter and composing Enter local; Enter sends once', async () => {
    render(panel());
    const input = screen.getByLabelText('Your question');
    fireEvent.change(input, { target: { value: 'Keyboard question' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
