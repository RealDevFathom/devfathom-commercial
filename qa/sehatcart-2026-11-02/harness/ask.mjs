// Ask Fathom probe: node ask.mjs <role> "<question>" ["<question2>" ...]
import { api, disposeApis, pkt, save } from './lib.mjs';
const [role, ...questions] = process.argv.slice(2);
const results = [];
for (const q of questions) {
  const a = await api(role);
  const body = { messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: q }] }] };
  const t0 = Date.now();
  const res = await a.post('/api/assistant', {
    data: body,
    headers: { 'content-type': 'application/json' },
    timeout: 90000,
  });
  const ms = Date.now() - t0;
  const txt = await res.text();
  // Parse SSE UI message stream: lines "data: {...}"
  let answer = '';
  const tools = [];
  const errors = [];
  for (const line of txt.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload);
      if (ev.type === 'text-delta') answer += ev.delta ?? ev.textDelta ?? '';
      else if (ev.type?.startsWith('tool-input-available') || ev.type === 'tool-call')
        tools.push(ev.toolName);
      else if (ev.type === 'tool-output-available')
        tools.push('out:' + JSON.stringify(ev.output).slice(0, 300));
      else if (ev.type === 'error') errors.push(ev.errorText ?? JSON.stringify(ev));
    } catch {}
  }
  const r = {
    role,
    q,
    status: res.status(),
    ms,
    answer: answer || (res.status() >= 400 ? txt.slice(0, 300) : ''),
    tools,
    errors,
    at: pkt(),
  };
  results.push(r);
  console.log(
    `\n=== [${role}] ${q}\n${res.status()} ${ms}ms tools=${JSON.stringify(tools).slice(0, 600)} errors=${JSON.stringify(errors)}\n${r.answer.slice(0, 1500)}`
  );
}
save(`ask-${role}-${Date.now()}.json`, results);
await disposeApis();
