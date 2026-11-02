import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
function asRole(role: string) {
  fixtures.session.mockReturnValue({ data: { user: { ...user, role } }, status: 'authenticated' });
}
/** Rendered user bubbles; the composer's textarea is not a paragraph. */
function userBubbles(text: string) {
  return screen.queryAllByText(text, { selector: 'p' });
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
      'What can you help me with?',
    ],
    [
      'PHARMACY',
      ['pharmacy-core', 'notes'],
      'Your pharmacy workspace',
      'What can you help me with?',
    ],
  ] as const)('uses canonical %s context', (vertical, modules, heading, suggestion) => {
    render(panel(entitlement(vertical, [...modules])));
    expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    expect(screen.getByRole('button', { name: suggestion })).toBeEnabled();
    expect(screen.queryByText(/Aisha/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /financ|revenue|profit/i })
    ).not.toBeInTheDocument();
    if (vertical !== 'AGENCY') {
      expect(screen.queryByRole('button', { name: /projects|tasks/i })).not.toBeInTheDocument();
      // The server composes notes and meetings tools for Agency workspaces only.
      expect(screen.queryByRole('button', { name: /notes|meetings/i })).not.toBeInTheDocument();
    }
  });
  it('describes existing Restaurant and Catering reports only under the canonical core entitlement', () => {
    asRole('ADMIN');
    const view = render(panel(entitlement('RESTAURANT', ['restaurant-core'])));
    expect(screen.getByText(/Restaurant and Catering reports/)).toBeVisible();
    expect(screen.getByRole('button', { name: "What were today's settled sales?" })).toBeVisible();
    expect(screen.queryByRole('button', { name: /catering/i })).not.toBeInTheDocument();
    view.rerender(panel(entitlement('RESTAURANT', [])));
    expect(screen.getByText(/Restaurant reports are not enabled/)).toBeVisible();
    expect(screen.queryByText(/Catering/)).not.toBeInTheDocument();
  });
  it('offers restaurant staff POS how-to examples instead of reports', () => {
    render(panel(entitlement('RESTAURANT', ['restaurant-core', 'restaurant-pos'])));
    expect(
      screen.getByRole('button', { name: 'How do I split a bill at checkout?' })
    ).toBeVisible();
    expect(screen.queryByText(/Catering reports/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sales|refund/i })).not.toBeInTheDocument();
  });
  it('describes the Pharmacy report tool to the owner only when entitled', () => {
    asRole('ADMIN');
    const view = render(panel(entitlement('PHARMACY', ['pharmacy-reports'])));
    expect(screen.getByText(/today's sales, expiring or low stock/)).toBeVisible();
    view.rerender(panel(entitlement('PHARMACY', [])));
    expect(screen.getByText(/Pharmacy reports are not enabled/)).toBeVisible();
  });
  it.each(['EMPLOYEE', 'HR', 'ADMIN'])(
    'does not infer financial grants from the %s role',
    (role) => {
      asRole(role);
      render(panel(entitlement('AGENCY', ['finance'])));
      expect(screen.queryByRole('button', { name: /financ/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'What can you help me with?' })).toBeEnabled();
      expect(screen.queryByText(/No suggested actions/)).not.toBeInTheDocument();
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

describe('Ask Fathom role-aware empty state', () => {
  const pharmacy = () =>
    entitlement('PHARMACY', ['pharmacy-core', 'pharmacy-counter', 'pharmacy-reports']);
  const examples = () =>
    within(screen.getByRole('list', { name: 'Try asking' }))
      .getAllByRole('button')
      .map((button) => button.textContent);

  it('gives the owner report examples without access wording (DEV-584, DEV-605)', () => {
    asRole('ADMIN');
    render(panel(pharmacy()));
    expect(examples()).toEqual([
      "What were today's sales?",
      'Which stock is expiring soon?',
      'Which medicines are running low and need reordering?',
      'How do I process a customer return?',
      'What can you help me with?',
    ]);
    expect(
      screen.queryByText(/No suggested actions|current access|Examples match your role/)
    ).not.toBeInTheDocument();
  });
  it('gives the cashier counter examples and never promises reports (DEV-605)', () => {
    render(panel(pharmacy()));
    expect(examples()).toEqual([
      'How do I check whether a medicine is in stock?',
      'How do I process a customer return?',
      'What can you help me with?',
    ]);
    expect(screen.getByText(/counter tasks/)).toBeVisible();
    expect(screen.queryByText(/Report access is checked when you ask/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ask about .*pharmacy reports/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sales|expir|reorder/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Examples match your role/)).toBeVisible();
  });
  it('offers three to five tappable examples and sends the one tapped (DEV-593)', async () => {
    render(panel(pharmacy()));
    expect(examples().length).toBeGreaterThanOrEqual(3);
    expect(examples().length).toBeLessThanOrEqual(5);
    fireEvent.click(screen.getByRole('button', { name: 'How do I process a customer return?' }));
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].parts[0].text).toBe(
      'How do I process a customer return?'
    );
  });
});

describe('Ask Fathom request and result states', () => {
  it('has no failure alert before a request fails', () => {
    render(panel());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('sends an entitled suggestion through the SDK and shows its response', async () => {
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Show my open tasks' }));
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].parts[0].text).toBe(
      'Show my open tasks'
    );
    expect(screen.getByLabelText('Your question')).toHaveValue('');
  });
  it('explains a failure plainly and retries the same question without a second bubble (DEV-592)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('synthetic provider diagnostic must not render', { status: 503 })
    );
    render(panel());
    enter();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      "Ask Fathom can't answer right now. Try again in a few minutes; if it keeps happening, contact support."
    );
    expect(alert).not.toHaveTextContent(/action results|cached/i);
    expect(screen.queryByText(/synthetic provider diagnostic/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close assistant' })).toBeEnabled();
    expect(screen.getByLabelText('Your question')).toBeEnabled();
    expect(userBubbles('Find my notes')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(userBubbles('Find my notes')).toHaveLength(1);
    const retried = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
      messages: UIMessage[];
    };
    expect(retried.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
  it.each([401, 403])(
    'shows permission denial for HTTP %s without a retry or a lost question',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response('denied', { status }));
      render(panel());
      enter();
      expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
      expect(userBubbles('Find my notes')).toHaveLength(1);
      expect(screen.getByLabelText('Your question')).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    }
  );
  it('shows an explicit empty response and retries its question in place', async () => {
    fetchMock.mockResolvedValueOnce(response());
    render(panel());
    enter();
    expect(await screen.findByText(/No answer was returned/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(userBubbles('Find my notes')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('shows pending status and stops the request without claiming rollback', async () => {
    const signal = pendingFetch();
    render(panel());
    enter();
    expect(await screen.findByText('Working on your request…')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(signal()?.aborted).toBe(true));
    expect(screen.getByText(/Completed actions are not undone/)).toBeVisible();
    expect(userBubbles('Find my notes')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('ignores repeat Enter while a reply loads and locks the composer (DEV-600)', async () => {
    pendingFetch();
    render(panel());
    enter('Loading question');
    const box = screen.getByLabelText('Your question');
    expect(await screen.findByText('Working on your request…')).toBeVisible();
    expect(box).toHaveValue('');
    expect(box).toHaveAttribute('readonly');
    // Even text forced into the locked box cannot queue a second question.
    fireEvent.change(box, { target: { value: 'Loading question' } });
    for (let press = 0; press < 3; press++) fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {});
    expect(userBubbles('Loading question')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not resend a failed question as a new bubble on Enter (DEV-600)', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }));
    render(panel());
    enter('Owner question');
    await screen.findByRole('alert');
    const box = screen.getByLabelText('Your question');
    expect(box).toHaveValue('');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {});
    expect(userBubbles('Owner question')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('explains an empty send instead of doing nothing (DEV-593)', () => {
    render(panel());
    const box = screen.getByLabelText('Your question');
    const hint = 'Type a question first, or choose an example above.';
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByText(hint)).toBeVisible();
    expect(box).toHaveAccessibleDescription(hint);
    fireEvent.change(box, { target: { value: '   ' } });
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByText(hint)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("lays out mixed Urdu and English by each paragraph's first strong character (DEV-599)", async () => {
    const mixed = 'آج کی سیل کتنی ہے؟ Panadol 500mg کے 1,250 units اور PKR 45,300 کی ریفنڈ';
    fetchMock.mockImplementation(async () => answer(mixed));
    render(panel());
    const box = screen.getByLabelText('Your question');
    expect(box).toHaveAttribute('dir', 'auto');
    expect(box).toHaveClass('[unicode-bidi:plaintext]');
    enter(mixed);
    await waitFor(() => expect(screen.getAllByText(mixed)).toHaveLength(2));
    const [question, reply] = screen.getAllByText(mixed);
    expect(question).toHaveAttribute('dir', 'auto');
    expect(question).toHaveClass('[unicode-bidi:plaintext]');
    expect(reply).toHaveAttribute('dir', 'auto');
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
  it('opens on the question box, keeps typing inside, and restores focus on close (DEV-603)', async () => {
    useAssistant.setState({ open: false });
    render(
      <>
        <button type="button">Launcher</button>
        {panel()}
      </>
    );
    const launcher = screen.getByRole('button', { name: 'Launcher' });
    launcher.focus();
    act(() => useAssistant.setState({ open: true }));
    const box = await screen.findByLabelText('Your question');
    await waitFor(() => expect(box).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Close assistant' })).not.toHaveFocus();
    fireEvent.change(box, { target: { value: 'Typed straight away' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Synthetic answer')).toBeVisible();
    expect(useAssistant.getState().open).toBe(true);
    expect(userBubbles('Typed straight away')).toHaveLength(1);
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(useAssistant.getState().open).toBe(false));
    await waitFor(() => expect(launcher).toHaveFocus());
  });
  it('follows the current theme through tokens when reopened (DEV-598)', async () => {
    try {
      render(panel());
      enter();
      await screen.findByText('Synthetic answer');
      act(() => useAssistant.setState({ open: false }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      document.documentElement.setAttribute('data-theme', 'dark');
      act(() => useAssistant.setState({ open: true }));
      const dialog = await screen.findByRole('dialog', { name: 'Ask Fathom' });
      // The surface reads the theme token; only opacity and position animate,
      // so a theme switch can never leave it on the previous theme's colour.
      expect(dialog).toHaveClass('bg-popover', 'transition-[opacity,translate]');
      expect(dialog.className).not.toMatch(/(^|\s)transition(\s|$)/);
      for (const element of [dialog, ...dialog.querySelectorAll('*')]) {
        expect(element.getAttribute('class') ?? '').not.toMatch(
          /rgba?\(|#[0-9a-f]{3,8}\b|\b(bg|text|border)-(white|black)\b/i
        );
        expect(element.getAttribute('style') ?? '').not.toMatch(/colou?r|background/i);
      }
    } finally {
      document.documentElement.removeAttribute('data-theme');
    }
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
