export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantApproval {
  approvalId: string;
  name: string;
  arguments: Record<string, unknown>;
  messageId: string;
}

export function useAssistant() {
  const open = useState('assistant-open', () => false);
  const messages = useState<AssistantMessage[]>('assistant-messages', () => []);
  const streaming = useState('assistant-streaming', () => false);
  const error = useState('assistant-error', () => '');
  const approvals = useState<AssistantApproval[]>('assistant-approvals', () => []);
  const config = useRuntimeConfig();
  const token = useCookie<string | null>('df_access_token');

  async function run(approvedTools: string[] = []) {
    const reply = reactive<AssistantMessage>({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
    });
    messages.value.push(reply);
    streaming.value = true;
    try {
      const response = await fetch(`${config.public.apiBase}/api/assistant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
        },
        body: JSON.stringify({ messages: messages.value.slice(0, -1), approvedTools }),
      });
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.detail || 'The assistant is unavailable.');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const event = frame.match(/^event: (.+)$/m)?.[1];
          const raw = frame.match(/^data: (.+)$/m)?.[1];
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (event === 'text') reply.content += data.text || '';
          if (event === 'tool_result')
            reply.content += `\n${data.name}: ${data.result?.ok ? 'completed' : data.result?.error || 'failed'}\n`;
          if (event === 'approval_required') {
            reply.content = `Approval required to run ${data.name}.`;
            approvals.value.push({ ...data, messageId: reply.id });
          }
          if (event === 'error') throw new Error(data.message || 'The assistant stream failed.');
        }
        if (done) break;
      }
    } catch (caught: any) {
      error.value = caught?.message || 'The assistant is unavailable.';
      if (!reply.content) messages.value.pop();
    } finally {
      streaming.value = false;
    }
  }

  async function send(content: string) {
    const text = content.trim();
    if (!text || streaming.value) return;
    error.value = '';
    messages.value.push({ id: crypto.randomUUID(), role: 'user', content: text });
    await run();
  }

  async function approve(approval: AssistantApproval) {
    if (streaming.value) return;
    approvals.value = approvals.value.filter((item) => item.approvalId !== approval.approvalId);
    messages.value = messages.value.filter((item) => item.id !== approval.messageId);
    await run([approval.approvalId]);
  }

  return { open, messages, approvals, streaming, error, send, approve };
}
