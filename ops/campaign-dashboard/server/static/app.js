/* DevFathom campaign ops dashboard — vanilla JS, no dependencies, CSP-safe (no inline styles/handlers). */
'use strict';

(() => {
  const REFRESH_MS = 30000;
  const PKT_MS = 5 * 3600 * 1000;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'text', 'title', 'defs', 'linearGradient', 'stop']);
  const GATE_ORDER = ['prisma', 'typecheck', 'lint', 'complete_unit', 'host_build', 'docker', 'differential'];
  const GATE_TAIL = ['qa_browser', 'security', 'final_sha', 'merged', 'linear', 'gh'];
  const GATE_LABEL = {
    prisma: 'Prisma', typecheck: 'Types', lint: 'Lint', complete_unit: 'Unit', host_build: 'Build',
    docker: 'Docker', differential: 'Diff', qa_browser: 'QA', security: 'Sec', final_sha: 'Final SHA',
    merged: 'Merged', linear: 'Linear', gh: 'GH',
  };
  const GATE_LONG = {
    prisma: 'Prisma generate', typecheck: 'Typecheck', lint: 'Lint', complete_unit: 'Complete unit', host_build: 'Host build',
    docker: 'Docker contract', differential: 'Differential vs baseline', qa_browser: 'QA / browser', security: 'Security',
    final_sha: 'Gates on final SHA', merged: 'Merged into develop', linear: 'Linear closed', gh: 'GitHub issue closed',
  };
  const ST_GLYPH = { PASS: '✓', FAIL: '✗', RUNNING: '●', BLOCKED: '!', PENDING: '·', SKIP: '–' };
  const MODEL_COLORS = ['#7c9cff', '#b28cff', '#34d399', '#f7b955', '#4fb3ff', '#ff8a9b'];
  const FUNNEL = [
    ['tasks', 'Tasks', '#5b6b8c'], ['fixed', 'Fixed', '#8b7bff'], ['gated', 'Gated', '#6d8cff'], ['merged', 'Merged', '#2fb8a0'],
    ['gh', 'GH closed', '#28c48b'], ['linear', 'Linear closed', '#2dd47a'], ['done', 'Done', '#34d399'],
  ];
  const METRICS = {
    cpuPct: { label: 'CPU', unit: '%', max: 100, thr: null },
    load1: { label: 'Load (1 min)', unit: '', max: null, thr: 'load' },
    memPct: { label: 'RAM', unit: '%', max: 100, thr: null },
    workspacePct: { label: '/workspace disk', unit: '%', max: 100, thr: 85 },
    scratchPct: { label: '/scratch disk', unit: '%', max: 100, thr: 85 },
  };

  let S = null;
  let skew = 0;
  let lastFetchOk = 0;
  let fetchError = null;
  const prevNums = new Map();
  const ui = { batch: null, modal: [], evKind: '', evDay: null, evQ: '', evLimit: 100 };

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);

  function h(tag, attrs, ...kids) {
    const el = SVG_TAGS.has(tag) ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.setAttribute('class', v);
        else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const mount = (id, ...nodes) => { const el = $(id); el.replaceChildren(...nodes.flat(Infinity).filter(Boolean)); return el; };
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const nowSec = () => Date.now() / 1000 + skew;
  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pkt = (ts) => new Date(ts * 1000 + PKT_MS);
  const fmtHM = (ts) => { if (!isNum(ts)) return '—'; const d = pkt(ts); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fmtDT = (ts) => {
    if (!isNum(ts)) return '—';
    const d = pkt(ts);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const fmtFull = (ts) => (isNum(ts) ? `${fmtDT(ts)}:${pad(pkt(ts).getUTCSeconds())} PKT` : '—');
  const dayKey = (ts) => { const d = pkt(ts); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const dayLabel = (key) => { const d = new Date(`${key}T00:00:00Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  function fmtDur(sec) {
    if (!isNum(sec)) return '—';
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${pad(sec % 60)}s`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ${pad(Math.floor((sec % 3600) / 60))}m`;
    return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  }
  const ago = (ts) => (isNum(ts) ? `${fmtDur(nowSec() - ts)} ago` : 'never');
  const fmtNum = (v, d = 0) => (isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');
  const fmtGiB = (b) => (isNum(b) ? (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TiB` : `${(b / 1024 ** 3).toFixed(0)} GiB`) : '—');
  const pct = (a, b) => (b ? Math.max(0, Math.min(100, (100 * a) / b)) : 0);
  const batchById = (id) => (S ? S.batches.find((b) => b.id === id) : null);
  const batchName = (id) => { const b = batchById(id); return b ? (b.label || b.id) : (id || ''); };
  const ghLink = (kind, n) => (S && n ? `https://github.com/${S.repo}/${kind}/${encodeURIComponent(n)}` : null);
  const extLink = (kind, n, text) => h('a', { href: ghLink(kind, n), target: '_blank', rel: 'noopener noreferrer' }, text);
  const status = (s) => h('span', { class: `st st-${s || 'PENDING'}`, title: s || 'PENDING' }, ST_GLYPH[s] || '·');
  const phase = (p) => h('span', { class: `phase ph-${p || 'pending'}` }, p || 'pending');
  const activate = (fn) => ({ onclick: fn, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } } });
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function countUp(key, value, decimals = 0) {
    const el = h('span', { class: 'num' }, isNum(value) ? fmtNum(value, decimals) : '—');
    if (!isNum(value)) return el;
    const from = prevNums.has(key) ? prevNums.get(key) : 0;
    prevNums.set(key, value);
    if (reduceMotion || from === value) return el;
    const t0 = performance.now();
    const dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - k) ** 3;
      el.textContent = fmtNum(from + (value - from) * e, decimals);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return el;
  }

  function bar(value, max, cls, capAt) {
    const b = h('div', { class: `bar ${cls || ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': max || 0, 'aria-valuenow': value || 0 },
      h('i', { style: { width: `${pct(value || 0, max)}%` } }));
    if (isNum(capAt)) b.append(h('span', { class: 'cap', style: { left: `calc(${pct(capAt, max)}% - 1px)` } }));
    return b;
  }

  function levelFor(v, warn, crit) {
    if (!isNum(v)) return 'var(--dim)';
    if (v >= crit) return 'var(--bad)';
    if (v >= warn) return 'var(--warn)';
    return 'var(--ok)';
  }

  function gauge(label, value, text, sub, opts = {}) {
    const v = isNum(value) ? Math.max(0, Math.min(100, value)) : 0;
    const arc = 'M10 60 A50 50 0 0 1 110 60';
    const svg = h('svg', { class: 'arc', viewBox: '0 0 120 70', role: 'img', 'aria-label': `${label} ${text}` },
      h('path', { class: 'g-track', d: arc, pathLength: 100 }),
      h('path', { class: 'g-val', d: arc, pathLength: 100, stroke: levelFor(value, opts.warn ?? 70, opts.crit ?? 85),
        'stroke-dasharray': `${isNum(value) ? v : 0} 100` }),
      h('text', { class: 'g-text', x: 60, y: 58 }, text));
    if (isNum(opts.mark)) {
      const a = Math.PI * (1 - opts.mark / 100);
      svg.append(h('line', { class: 'g-mark', x1: 60 + 42 * Math.cos(a), y1: 60 - 42 * Math.sin(a), x2: 60 + 58 * Math.cos(a), y2: 60 - 58 * Math.sin(a) },
        h('title', null, `${opts.mark}% line`)));
    }
    const attrs = { class: `gauge ${opts.onclick ? 'card click' : ''}` };
    if (opts.onclick) Object.assign(attrs, { role: 'button', tabindex: 0, ...activate(opts.onclick) });
    return h('div', attrs, svg, h('div', { class: 'g-label' }, label), opts.spark || null, sub ? h('div', { class: 'g-sub' }, sub) : null);
  }

  function sparkline(values, max) {
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => isNum(v));
    if (pts.length < 2) return h('svg', { class: 'spark', viewBox: '0 0 100 26', preserveAspectRatio: 'none' });
    const n = values.length - 1 || 1;
    const top = Math.max(max ?? 0, ...pts.map(([, v]) => v), 1e-9);
    const xy = pts.map(([i, v]) => `${((i / n) * 100).toFixed(2)},${(25 - (v / top) * 23).toFixed(2)}`);
    return h('svg', { class: 'spark', viewBox: '0 0 100 26', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      h('polygon', { class: 's-area', points: `${xy[0].split(',')[0]},26 ${xy.join(' ')} ${xy[xy.length - 1].split(',')[0]},26` }),
      h('polyline', { class: 's-line', points: xy.join(' ') }));
  }

  function bigChart(rows, max, threshold) {
    const pts = rows.filter(([t, v]) => isNum(t) && isNum(v));
    const W = 800; const H = 200; const L = 34; const B = 18;
    const svg = h('svg', { class: 'bigchart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' },
      h('defs', null, h('linearGradient', { id: 'cgrad', x1: 0, y1: 0, x2: 0, y2: 1 },
        h('stop', { offset: 0, 'stop-color': '#7c9cff', 'stop-opacity': 0.45 }), h('stop', { offset: 1, 'stop-color': '#7c9cff', 'stop-opacity': 0 }))));
    if (pts.length < 2) { svg.append(h('text', { class: 'c-lbl', x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'not enough history yet')); return svg; }
    const t0 = pts[0][0]; const t1 = pts[pts.length - 1][0];
    const top = Math.max(max ?? 0, threshold ?? 0, ...pts.map((p) => p[1]), 1e-9);
    const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - 6);
    const y = (v) => H - B - (v / top) * (H - B - 10);
    for (let i = 0; i <= 4; i += 1) {
      const v = (top * i) / 4;
      svg.append(h('line', { class: 'c-grid', x1: L, x2: W, y1: y(v), y2: y(v) }), h('text', { class: 'c-lbl', x: 2, y: y(v) + 3 }, v >= 10 ? v.toFixed(0) : v.toFixed(1)));
    }
    for (let i = 0; i <= 5; i += 1) {
      const t = t0 + ((t1 - t0) * i) / 5;
      svg.append(h('text', { class: 'c-lbl', x: x(t), y: H - 4, 'text-anchor': i === 0 ? 'start' : i === 5 ? 'end' : 'middle' }, t1 - t0 > 2 * 86400 ? fmtDT(t) : fmtHM(t)));
    }
    const line = pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    svg.append(h('polygon', { class: 'c-area', points: `${x(t0)},${H - B} ${line} ${x(t1)},${H - B}` }), h('polyline', { class: 'c-line', points: line }));
    if (isNum(threshold)) svg.append(h('line', { class: 'c-thr', x1: L, x2: W, y1: y(threshold), y2: y(threshold) }));
    return svg;
  }

  function donut(entries, centerNum, centerLbl) {
    const total = entries.reduce((a, e) => a + e.value, 0);
    const svg = h('svg', { class: 'donut', viewBox: '0 0 150 150', role: 'img', 'aria-label': 'model split' },
      h('circle', { class: 'd-bg', cx: 75, cy: 75, r: 56 }));
    let offset = 0;
    for (const e of entries) {
      const len = total ? (100 * e.value) / total : 0;
      const seg = Math.max(0, len - 0.6);
      svg.append(h('circle', { class: 'd-seg', cx: 75, cy: 75, r: 56, pathLength: 100, stroke: e.color,
        'stroke-dasharray': `${seg} ${100 - seg}`, 'stroke-dashoffset': 25 - offset }, h('title', null, `${e.label}: ${e.value}`)));
      offset += len;
    }
    svg.append(h('text', { class: 'd-num', x: 75, y: 80 }, centerNum), h('text', { class: 'd-lbl', x: 75, y: 98 }, centerLbl));
    return svg;
  }

  function dayBars(items, tsKey, days = 30) {
    const counts = new Map();
    const today = nowSec();
    for (let i = days - 1; i >= 0; i -= 1) counts.set(dayKey(today - i * 86400), 0);
    for (const it of items) if (isNum(it[tsKey]) && counts.has(dayKey(it[tsKey]))) counts.set(dayKey(it[tsKey]), counts.get(dayKey(it[tsKey])) + 1);
    const vals = [...counts.entries()];
    const max = Math.max(1, ...vals.map(([, v]) => v));
    const w = 300 / vals.length;
    const svg = h('svg', { class: 'daybars', viewBox: '0 0 300 70', preserveAspectRatio: 'none', role: 'img', 'aria-label': `per day, last ${days} days` });
    vals.forEach(([k, v], i) => {
      const bh = v ? Math.max(3, (v / max) * 64) : 2;
      svg.append(h('rect', { class: v ? '' : 'zero', x: i * w + 1, y: 70 - bh, width: Math.max(1, w - 2), height: bh, rx: 1.5 }, h('title', null, `${dayLabel(k)}: ${v}`)));
    });
    return svg;
  }

  const evidence = (obj, label = 'Raw evidence (sanitized JSON)') => h('details', { class: 'evidence' }, h('summary', null, label),
    h('pre', { class: 'json' }, JSON.stringify(obj, null, 2)));
  const kv = (k, v) => h('div', null, h('dt', null, k), h('dd', null, v ?? '—'));

  // ------------------------------------------------------------------ derived data
  function allTasks() {
    const out = [];
    for (const b of S.batches) for (const t of b.tasks) out.push({ b, t });
    return out;
  }

  function stageTasks(stage) {
    const best = new Map();
    for (const { b, t } of allTasks()) {
      const cur = best.get(t.issue);
      if (!cur || (t.last || 0) > (cur.t.last || 0)) best.set(t.issue, { b, t, flags: { ...(cur ? cur.flags : {}) } });
      const f = best.get(t.issue).flags;
      f.tasks = true;
      f.fixed = f.fixed || !!t.fixed;
      f.gated = f.gated || !!t.gated;
      f.merged = f.merged || !!t.merged;
      f.gh = f.gh || !!t.ghClosed;
      f.linear = f.linear || t.linearClosed === true;
      f.done = f.done || !!t.done;
    }
    return [...best.values()].filter((x) => x.flags[stage]);
  }

  function classifyEvent(e) {
    if (e.kind === 'merge') return 'merge';
    if (e.kind === 'issue') return 'issue';
    if (e.kind === 'codex') return 'codex';
    if (e.kind === 'step' || e.kind === 'gates' || e.kind === 'review' || e.kind === 'baseline') return e.level === 'bad' ? 'gatefail' : (e.level === 'ok' ? 'gatepass' : 'other');
    if (e.level === 'bad') return 'gatefail';
    return 'other';
  }

  // ------------------------------------------------------------------ data
  async function load() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      skew = data.serverTime - Date.now() / 1000;
      S = data;
      lastFetchOk = nowSec();
      fetchError = null;
      const first = !render.done;
      render();
      render.done = true;
      if (first && location.hash && ROUTE_RE.test(location.hash)) route(location.hash);
    } catch (err) {
      fetchError = err.message || 'fetch failed';
      renderFreshness();
    }
  }

  function tickClock() {
    const d = pkt(nowSec());
    $('clock').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    $('clock-date').textContent = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · PKT`;
    if (S) { renderFreshness(); tickDurations(); }
  }

  function tickDurations() {
    const now = nowSec();
    for (const el of document.querySelectorAll('[data-since]')) el.textContent = fmtDur(now - Number(el.dataset.since));
  }
  const since = (ts) => (isNum(ts) ? h('span', { class: 'num', 'data-since': ts }, fmtDur(nowSec() - ts)) : h('span', null, '—'));

  // ------------------------------------------------------------------ render
  function render() {
    const safe = (fn) => { try { fn(); } catch (err) { console.error(fn.name, err); } };
    [renderFreshness, renderAlerts, renderFunnel, renderOverview, renderCodex, renderGatesNow, renderVitals, renderQueue,
      renderUpcoming, renderNextBatch, renderBatches, renderBatchDetail, renderActivity, renderMerges, renderEvents, renderWorker, renderAIStatus, renderInsights].forEach(safe);
    if (ui.modal.length && $('dlg').open) safe(renderModal);
  }

  function renderFreshness() {
    const el = $('freshness');
    if (fetchError && (!S || nowSec() - lastFetchOk > 90)) {
      el.className = 'pill pill-bad';
      el.textContent = `offline · ${fetchError}`;
      return;
    }
    if (!S) return;
    const stale = Object.entries(S.sources).filter(([, v]) => v.stale).map(([k]) => k);
    const ages = Object.values(S.sources).map((v) => v.receivedAt).filter(isNum);
    const newest = ages.length ? Math.max(...ages) : null;
    if (stale.length) {
      el.className = 'pill pill-warn';
      el.textContent = `stale: ${stale.join(', ')} · ${newest ? ago(newest) : 'no data'}`;
    } else {
      el.className = 'pill pill-ok live';
      el.textContent = `live · ${ago(newest)}`;
    }
    el.title = Object.entries(S.sources).map(([k, v]) => `${k}: ${v.receivedAt ? fmtFull(v.receivedAt) : 'never'}`).join('\n');
  }

  function renderAlerts() {
    const alerts = S.alerts || [];
    if (!alerts.length) return mount('alerts', h('div', { class: 'alert alert-ok' }, '✓ All checks nominal'));
    const order = { crit: 0, warn: 1 };
    return mount('alerts', [...alerts].sort((a, b) => order[a.level] - order[b.level]).map((a) =>
      h('button', { class: `alert alert-${a.level} click`, type: 'button', onclick: () => openModal('alert', a) }, h('b', null, a.level === 'crit' ? '▲' : '●'), a.message)));
  }

  function renderFunnel() {
    const counts = Object.fromEntries(FUNNEL.map(([k]) => [k, stageTasks(k).length]));
    const total = counts.tasks || 0;
    const linearOn = S.linear.available;
    mount('funnel', h('div', { class: 'funnel' }, FUNNEL.map(([k, label, color]) => {
      const n = counts[k];
      const off = k === 'linear' && !linearOn;
      return h('button', { class: 'f-stage', type: 'button', disabled: off || null, title: off ? (S.linear.reason || 'Linear not configured') : `Show ${label.toLowerCase()} tasks`,
        onclick: () => openModal('list', { stage: k, title: `${label} tasks` }) },
      h('span', { class: 'f-name' }, label),
      h('span', { class: 'f-track' }, h('span', { class: 'f-fill', style: { width: `${off ? 0 : Math.max(n ? 3 : 0, pct(n, total))}%`, background: `linear-gradient(90deg, ${color}cc, ${color})` } }, n ? h('b', null, n) : null)),
      h('span', { class: 'f-pct' }, off ? h('span', { class: 'dim' }, 'n/a') : [h('b', null, countUp(`f-${k}`, n)), total ? `${Math.round(pct(n, total))}%` : '']));
    })));
  }

  function card(key, label, value, foot, opts = {}) {
    const attrs = { class: `card ${opts.onclick ? 'click' : ''} ${opts.accent ? 'accent' : ''}` };
    if (opts.onclick) Object.assign(attrs, { role: 'button', tabindex: 0, ...activate(opts.onclick) });
    return h('div', attrs,
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, isNum(value) ? countUp(key, value, opts.decimals || 0) : (value ?? '—'), opts.small ? h('small', null, opts.small) : null),
      opts.bar || null,
      foot ? h('div', { class: 'foot' }, foot) : null);
  }

  function renderOverview() {
    const o = S.overview;
    const usage = o.usagePct;
    $('overview-meta').textContent = `${o.batches} batches · ${fmtNum(o.tasks)} unique tasks · ${fmtNum(o.codexJobsTotal)} Codex jobs`;
    const usageGauge = gauge('Weekly usage', usage, isNum(usage) ? `${Math.round(usage)}%` : 'unknown',
      o.usageStopActive ? '⛔ usage STOP marker active' : `stop line ${S.limits.usageStop}% · marker clear`,
      { warn: 80, crit: S.limits.usageStop, mark: S.limits.usageStop, onclick: () => openModal('usage', {}) });
    mount('overview',
      card('o-codex', 'Codex jobs', o.codexJobsTotal, `${fmtNum(o.codexActive)} active of ${o.codexCap} cap`, {
        accent: true, onclick: () => $('sec-now').scrollIntoView({ behavior: 'smooth' }),
        bar: bar(o.codexActive || 0, o.codexCap || 50, (o.codexActive || 0) >= (o.codexCap || 50) ? 'warn' : 'run'),
      }),
      card('o-done', 'Done', o.done, 'gated + merged + closed', { bar: bar(o.done, o.tasks, 'ok'), onclick: () => openModal('list', { stage: 'done', title: 'Done tasks' }) }),
      card('o-merged', 'Merged', o.merged, `${o.mergedLast30d} PRs into develop · 30 d`, { onclick: () => openModal('list', { stage: 'merged', title: 'Merged tasks' }) }),
      card('o-hours', 'Machine time', o.machineHours, isNum(o.machineCostUsd) ? `$${fmtNum(o.machineCostUsd, 2)} spot cost · all time` : 'cost unknown',
        { small: 'h', decimals: 1, onclick: () => openModal('workers', {}) }),
      card('o-cost', 'Spend', isNum(o.machineCostUsd) ? o.machineCostUsd : 'n/a', 'USD on worker spot capacity', { decimals: 2, onclick: () => openModal('workers', {}) }),
      h('div', { class: 'card' }, usageGauge));
  }

  function renderCodex() {
    const c = S.codex || {};
    const active = c.active || [];
    const cap = c.cap || 50;
    const count = c.activeCount ?? active.length;
    let byModel = Object.entries(c.byModel || {});
    if (!byModel.length) byModel = Object.entries((S.worker.codexProcs || {}).byModel || {});
    const entries = byModel.sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value, color: MODEL_COLORS[i % MODEL_COLORS.length] }));
    $('codex-meta').textContent = `${count} / ${cap} cap`;
    $('now-meta').textContent = `${count} Codex · ${(S.now.gates || []).length} machine runs · updated ${ago(S.worker.collectedAt)}`;
    mount('codex',
      h('div', { class: 'codex-top' },
        donut(entries, String(count), 'ACTIVE'),
        h('div', { class: 'cap-bar' },
          h('div', null, h('span', { class: 'big' }, countUp('c-active', count)), h('span', { class: 'muted' }, ` / ${cap} concurrent`)),
          bar(count, cap, count >= cap ? 'warn' : 'run'),
          h('div', { class: 'legend' }, entries.length ? entries.map((e) => h('span', null, h('i', { style: { background: e.color } }), `${e.label} · ${e.value}`))
            : h('span', null, 'no active models')))),
      active.length ? active.map((j) => {
        const t = (batchById(j.batch)?.tasks || []).find((x) => x.issue === j.issue);
        const steps = t ? ((t.runs || []).find((r) => r.run === j.run && r.kind === 'codex')?.steps || []) : [];
        return h('button', { class: 'item', type: 'button', onclick: () => openModal('task', { batch: j.batch, issue: j.issue }) },
          h('span', { class: 'dot run' }),
          h('span', { class: 'i-main' },
            h('div', { class: 'i-title' }, j.issue, ' ', h('span', { class: 'badge' }, j.status || 'running'), t && t.title ? h('span', { class: 'muted' }, ` · ${t.title}`) : null),
            h('div', { class: 'i-sub' }, `${j.model || 'model ?'}${j.effort ? ` · ${j.effort}` : ''} · ${j.step ? `step ${j.step}` : 'coding'} · ${batchName(j.batch)}`),
            steps.length ? h('div', { class: 'mini-steps' }, steps.map((s) => h('i', { class: s.status, title: `${s.name}: ${s.status}` }))) : null),
          h('span', { class: 'i-side' }, since(j.start)));
      }) : h('div', { class: 'empty' }, 'No Codex jobs running right now'));
  }

  function renderGatesNow() {
    const g = S.now.gates || [];
    $('gates-meta').textContent = `${g.length} running`;
    mount('gates-now', g.length ? g.map((r) => {
      const t = (batchById(r.batch)?.tasks || []).find((x) => x.issue === r.issue);
      const steps = t ? ((t.runs || []).find((x) => x.run === r.run)?.steps || []) : [];
      return h('button', { class: 'item', type: 'button', onclick: () => openModal('task', { batch: r.batch, issue: r.issue }) },
        h('span', { class: 'dot run' }),
        h('span', { class: 'i-main' },
          h('div', { class: 'i-title' }, r.issue, ' ', h('span', { class: 'badge' }, r.kind), ' ', h('span', { class: 'mono muted' }, r.step || 'starting')),
          h('div', { class: 'i-sub' }, `${r.run} · ${r.done}/${r.total} steps passed · ${batchName(r.batch)}`),
          steps.length ? h('div', { class: 'mini-steps' }, steps.map((s) => h('i', { class: s.status, title: `${s.name}: ${s.status}` }))) : null),
        h('span', { class: 'i-side' }, since(r.start)));
    }) : h('div', { class: 'empty' }, 'No gate or verification steps running'));
  }

  function historyCol(field) {
    const hist = S.worker.history;
    if (!hist || !hist.recent) return [];
    const idx = hist.fields.indexOf(field);
    return idx < 0 ? [] : hist.recent.map((r) => r[idx]);
  }

  function renderVitals() {
    const sys = S.worker.system || {};
    const cores = sys.cores || 1;
    const disks = sys.disks || {};
    $('vitals-meta').textContent = sys.cores ? `${cores} cores · up ${fmtDur(sys.uptimeSec)}` : 'no data';
    const row = (field, name, val, valTxt, max, cls) => h('button', { class: 'vital', type: 'button', onclick: () => openModal('metric', { field }) },
      h('span', { class: 'v-name' }, name),
      h('span', { class: 'v-chart' }, bar(isNum(val) ? val : 0, max, cls), sparkline(historyCol(field), max)),
      h('span', { class: 'v-val' }, valTxt));
    const lvl = (v, w, c) => (!isNum(v) ? '' : v >= c ? 'bad' : v >= w ? 'warn' : 'ok');
    const load = (sys.load || [])[0];
    const ws = disks['/workspace']; const sc = disks['/scratch'];
    const ks = S.worker.killSwitch || {};
    mount('vitals',
      row('cpuPct', 'CPU', sys.cpuPct, isNum(sys.cpuPct) ? `${Math.round(sys.cpuPct)}%` : '—', 100, lvl(sys.cpuPct, 70, 90)),
      row('load1', 'Load', load, isNum(load) ? load.toFixed(2) : '—', cores, lvl(isNum(load) ? (100 * load) / cores : null, 75, 90)),
      row('memPct', 'RAM', (sys.mem || {}).pct, isNum((sys.mem || {}).pct) ? `${Math.round(sys.mem.pct)}%` : '—', 100, lvl((sys.mem || {}).pct, 75, 90)),
      row('workspacePct', '/workspace', ws && ws.pct, ws ? `${Math.round(ws.pct)}%` : '—', 100, lvl(ws && ws.pct, 75, 85)),
      row('scratchPct', '/scratch', sc && sc.pct, sc ? `${Math.round(sc.pct)}%` : '—', 100, lvl(sc && sc.pct, 75, 85)),
      h('div', { class: 'subrow' },
        h('button', { class: `pill ${ks.pass === true ? 'pill-ok' : ks.pass === false ? 'pill-bad' : 'pill-muted'} chip click`, type: 'button', onclick: () => openModal('killswitch', {}) },
          `Kill-switch ${ks.pass === true ? 'PASS' : ks.pass === false ? 'FAIL' : 'unknown'}`),
        h('span', { class: 'small muted' }, `${(S.worker.codexProcs || {}).total ?? '—'} codex procs`)));
  }

  function renderQueue() {
    const q = S.next.queue || [];
    $('queue-meta').textContent = `${q.length} waiting`;
    $('next-meta').textContent = `${q.length} queued · ${Object.values(S.next.upcoming || {}).reduce((a, v) => a + v.length, 0)} tasks with a next step`;
    mount('queue', q.length ? h('div', { class: 'scroll' }, q.slice(0, 80).map((x, i) => h('button', { class: 'item', type: 'button', onclick: () => openModal('task', { batch: x.batch, issue: x.issue }) },
      h('span', { class: 'badge' }, `#${i + 1}`),
      h('span', { class: 'i-main' }, h('div', { class: 'i-title' }, x.issue, x.title ? h('span', { class: 'muted' }, ` · ${x.title}`) : null),
        h('div', { class: 'i-sub' }, `${batchName(x.batch)}${x.model ? ` · ${x.model}` : ''}${x.effort ? `/${x.effort}` : ''}`)),
      h('span', { class: 'i-side mono' }, x.status || 'pending')))) : h('div', { class: 'empty' }, 'Queue is empty'));
  }

  function renderUpcoming() {
    const up = S.next.upcoming || {};
    const keys = (S.next.pipeline || []).filter((k) => up[k] && up[k].length);
    const max = Math.max(1, ...keys.map((k) => up[k].length));
    mount('upcoming', keys.length ? keys.map((k) => {
      const list = up[k];
      const failing = list.filter((x) => ['FAIL', 'BLOCKED'].includes(x.status)).length;
      return h('button', { class: 'up-row', type: 'button', onclick: () => openModal('list', { gate: k, title: `Waiting on: ${GATE_LONG[k] || k}` }) },
        h('span', { class: 'small' }, GATE_LONG[k] || k),
        h('span', null, bar(list.length, max, failing ? 'warn' : 'run'), failing ? h('span', { class: 'small', style: { color: 'var(--warn)' } }, `${failing} failing/blocked`) : null),
        h('span', { class: 'n' }, list.length));
    }) : h('div', { class: 'empty' }, 'Nothing waiting on a gate'));
  }

  function renderNextBatch() {
    const current = S.batches.filter((b) => !b.historical);
    const queued = current.filter((b) => b.counts.total && (b.counts.pending || 0) === b.counts.total);
    const pick = queued[0] || [...current].sort((a, b) => (b.counts.pending || 0) - (a.counts.pending || 0)).find((b) => b.counts.pending) || null;
    const newest = [...S.batches].sort((a, b) => (b.start || 0) - (a.start || 0))[0];
    const box = (b, kicker) => h('div', { class: 'item', role: 'button', tabindex: 0, ...activate(() => selectBatch(b.id, true)) },
      h('span', { class: 'dot warn' }),
      h('span', { class: 'i-main' }, h('div', { class: 'small eyebrow' }, kicker), h('div', { class: 'i-title' }, b.label || b.id),
        h('div', { class: 'i-sub' }, `${b.counts.pending || 0} queued of ${b.counts.total} · ${b.counts.running || 0} running · cap ${b.cap || '—'}`)),
      h('span', { class: 'i-side' }, `started ${fmtDT(b.start)}`));
    mount('next-batch',
      pick ? box(pick, queued.includes(pick) ? 'Queued batch' : 'Most work remaining') : h('div', { class: 'empty' }, 'No queued batch — new job roots appear automatically'),
      newest && newest !== pick ? box(newest, 'Newest batch discovered') : null,
      h('div', { class: 'small muted', style: { 'margin-top': '10px' } }, `${current.length} current · ${S.batches.length - current.length} historical · admission/handoff files are in each batch's evidence`));
  }

  function batchRow(b) {
    const c = b.counts || {};
    const n = c.total || 0;
    const prog = (label, v, cls) => [h('span', null, label), bar(v || 0, n, cls), h('span', { class: 'n' }, `${v || 0}/${n}`)];
    const runs = (b.runs || []).map((r) => h('button', {
      class: `chip click ${r.active ? 'run' : ''}`, type: 'button', title: `${r.tasks} tasks — open run`,
      onclick: (e) => { e.stopPropagation(); openModal('run', { batch: b.id, run: r.name }); },
    }, h('i'), `${r.name}${r.active ? ` · ${r.active} active` : ''}`));
    return h('div', { class: `batch ${ui.batch === b.id ? 'selected' : ''}`, role: 'button', tabindex: 0, 'aria-pressed': ui.batch === b.id ? 'true' : 'false', ...activate(() => selectBatch(b.id)) },
      h('div', { class: 'b-meta' },
        h('div', { class: 'b-name' }, b.label || b.id),
        h('div', { class: 'b-id', title: b.id }, b.id),
        h('div', null, `${n} tasks · started ${fmtDT(b.start)} · last ${ago(b.last)}`),
        h('div', { class: 'chips' }, b.active ? h('span', { class: 'pill pill-run live' }, `${b.active} active`) : null,
          c.pending ? h('span', { class: 'pill pill-muted' }, `${c.pending} queued`) : null,
          c.blocked ? h('span', { class: 'pill pill-warn' }, `${c.blocked} blocked`) : null,
          c.failed ? h('span', { class: 'pill pill-bad' }, `${c.failed} failed`) : null)),
      h('div', { class: 'prog' }, prog('Fixed', c.fixed, 'ok'), prog('Gated', c.gated, 'ok'), prog('Merged', c.merged, 'ok'), prog('Closed', c.closed, 'ok')),
      h('div', { class: 'chips' }, runs.length ? runs : h('span', { class: 'muted small' }, 'no runs'),
        b.attemptDirs ? h('span', { class: 'chip', title: 'superseded attempt directories (history)' }, h('i'), `${b.attemptDirs} attempts`) : null));
  }

  function renderBatches() {
    const current = S.batches.filter((b) => !b.historical);
    const hist = S.batches.filter((b) => b.historical);
    $('batches-meta').textContent = `${S.batches.length} batches · ${current.length} current · ${hist.length} historical`;
    const wasOpen = document.querySelector('details.hist')?.open;
    mount('batches',
      current.length ? current.map(batchRow) : h('div', { class: 'empty' }, 'No current batches'),
      hist.length ? h('details', { class: 'hist', open: wasOpen || hist.some((b) => b.id === ui.batch) },
        h('summary', null, `Historical batches (${hist.length})`), hist.map(batchRow)) : null);
  }

  function selectBatch(id, forceOpen) {
    ui.batch = ui.batch === id && !forceOpen ? null : id;
    $('f-gate').dataset.batch = '';
    if ($('dlg').open) $('dlg').close();
    renderBatches();
    renderBatchDetail();
    if (ui.batch) $('batch-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function gateColumns(tasks) {
    const seen = new Set();
    for (const t of tasks) for (const k of Object.keys(t.gates || {})) seen.add(k);
    const extra = [...seen].filter((k) => !GATE_ORDER.includes(k) && !GATE_TAIL.includes(k)).sort();
    return [...GATE_ORDER, ...extra, ...GATE_TAIL];
  }

  function gateTitle(key, g) {
    if (!g) return `${key}: pending`;
    const bits = [`${GATE_LONG[key] || key}: ${g.status}`];
    if (g.raw && g.raw !== g.status) bits.push(`raw ${g.raw}`);
    if (g.run) bits.push(`run ${g.run}`);
    if (g.sha) bits.push(`sha ${g.sha}`);
    if (isNum(g.dur)) bits.push(`took ${fmtDur(g.dur)}`);
    if (isNum(g.passed) || isNum(g.failed)) bits.push(`tests ${g.passed ?? '?'} passed / ${g.failed ?? '?'} failed`);
    if (g.newFailures) bits.push(`${g.newFailures.length} new failures vs baseline, ${g.baselineFailures || 0} pre-existing`);
    if (g.note) bits.push(g.note);
    if (g.state) bits.push(`state ${g.state}`);
    if (g.pr) bits.push(`PR #${g.pr}`);
    return bits.join('\n');
  }

  function taskMatches(t, f) {
    if (f.status) {
      if (['fixed', 'gated', 'merged', 'done', 'running'].includes(f.status)) { if (!t[f.status]) return false; } else if (t.phase !== f.status) return false;
    }
    if (f.gate) {
      const g = (t.gates || {})[f.gate];
      if (!g || !['FAIL', 'BLOCKED'].includes(g.status)) return false;
    }
    if (f.q) {
      const hay = [t.issue, t.title, t.finalSHA, t.sourceSHA, t.model, t.status].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }

  function renderBatchDetail() {
    const panel = $('batch-detail');
    const b = S && batchById(ui.batch);
    if (!b) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    $('bd-title').textContent = b.label || b.id;
    const relB = allInsights().filter((x) => x.batch === b.id && !x.issue);
    if (!$('bd-ins')) $('bd-summary').before(h('div', { id: 'bd-ins', class: 'strip' }));
    mount('bd-ins', relB.map((x) => insightRow(x, true)));
    $('bd-sub').textContent = `${b.id} · started ${fmtDT(b.start)} PKT · last activity ${ago(b.last)}`;
    const c = b.counts;
    const base = b.baseline;
    mount('bd-summary',
      ['total', 'running', 'pending', 'fixed', 'gated', 'merged', 'closed', 'done', 'blocked', 'failed'].map((k) => h('button', {
        class: 'chip click', type: 'button', onclick: () => { $('f-status').value = k === 'total' || k === 'closed' ? '' : k; renderBatchDetail(); },
      }, h('b', null, fmtNum(c[k] || 0)), k === 'pending' ? 'queued' : k)),
      base ? h('button', { class: `chip click ${base.norm === 'FAIL' ? 'warn' : 'ok'}`, type: 'button', onclick: () => openModal('run', { batch: b.id, run: base.run }) }, h('i'),
        `baseline ${base.baseSHA || ''} · ${base.numFailedTests ?? '?'} failing tests in ${base.failedFileCount ?? '?'} files`) : h('span', { class: 'chip' }, h('i'), 'no baseline in this batch'),
      (b.policies || []).map((p) => h('span', { class: 'chip', title: 'merge gate policy present' }, h('i'), p)),
      [...(b.ledgers || []), ...(b.files || [])].map((l) => h('button', { class: 'chip click', type: 'button', onclick: () => openModal('file', { batch: b.id, file: l }) }, h('i'),
        `${l.run ? `${l.run}/` : ''}${l.file}${isNum(l.at) ? ` @ ${fmtHM(l.at)}` : ''}`)));

    const cols = gateColumns(b.tasks);
    const gsel = $('f-gate');
    if (gsel.dataset.batch !== b.id) {
      const keep = gsel.value;
      gsel.replaceChildren(h('option', { value: '' }, 'Any gate'), ...cols.filter((k) => !['final_sha', 'merged', 'linear', 'gh'].includes(k))
        .map((k) => h('option', { value: k }, `Failing: ${GATE_LONG[k] || k}`)));
      gsel.value = cols.includes(keep) ? keep : '';
      gsel.dataset.batch = b.id;
    }
    const f = { status: $('f-status').value, gate: gsel.value, q: $('f-search').value.trim().toLowerCase() };
    const tasks = b.tasks.filter((t) => taskMatches(t, f));
    $('bd-count').textContent = `${tasks.length} of ${b.tasks.length} tasks`;
    mount('bd-legend', Object.keys(ST_GLYPH).map((s) => h('span', null, status(s), s.toLowerCase())));
    const head = h('thead', null, h('tr', null, h('th', null, 'Issue'), h('th', null, 'Title'), h('th', null, 'Phase'), h('th', null, 'Next'),
      cols.map((k) => h('th', { class: 'gate', title: GATE_LONG[k] || k }, GATE_LABEL[k] || k)), h('th', null, 'Last')));
    const body = h('tbody', null, tasks.length ? tasks.map((t) => h('tr', { class: 'click', tabindex: 0, ...activate(() => openModal('task', { batch: b.id, issue: t.issue })) },
      h('td', null, h('b', null, t.issue)),
      h('td', { class: 'wrap muted' }, t.title || '—'),
      h('td', null, phase(t.phase)),
      h('td', { class: 'small muted' }, t.nextGate ? (GATE_LABEL[t.nextGate] || t.nextGate) : '✓'),
      cols.map((k) => {
        const g = (t.gates || {})[k];
        if (k === 'final_sha') return h('td', { class: 'gate mono', title: gateTitle(k, g) }, g && g.sha ? h('span', { class: `st st-${g.status}` }, g.sha.slice(0, 7)) : status('PENDING'));
        return h('td', { class: 'gate', title: gateTitle(k, g) }, status(g ? g.status : 'PENDING'));
      }),
      h('td', { class: 'muted small' }, ago(t.last)))) : h('tr', null, h('td', { class: 'empty', colspan: cols.length + 5 }, 'No tasks match the filters')));
    $('matrix').replaceChildren(head, body);
  }

  // ------------------------------------------------------------------ history
  function renderActivity() {
    const days = 14;
    const keys = [];
    for (let i = days - 1; i >= 0; i -= 1) keys.push(dayKey(nowSec() - i * 86400));
    const cats = ['merge', 'issue', 'gatepass', 'gatefail', 'codex', 'other'];
    const catLabel = { merge: 'merges', issue: 'issues closed', gatepass: 'gate passes', gatefail: 'gate fails', codex: 'Codex runs', other: 'other' };
    const data = Object.fromEntries(keys.map((k) => [k, Object.fromEntries(cats.map((c) => [c, 0]))]));
    for (const e of S.events || []) {
      const k = dayKey(e.ts);
      if (data[k]) data[k][classifyEvent(e)] += 1;
    }
    const totals = keys.map((k) => cats.reduce((a, c) => a + data[k][c], 0));
    const max = Math.max(1, ...totals);
    const W = 840; const H = 170; const B = 18; const colW = W / days;
    const svg = h('svg', { class: 'activity', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'activity per day' });
    keys.forEach((k, i) => {
      const g = h('g', { class: `a-col ${ui.evDay === k ? 'a-sel' : ''}`, ...activate(() => { ui.evDay = ui.evDay === k ? null : k; ui.evLimit = 100; renderActivity(); renderEvents(); }) },
        h('title', null, `${dayLabel(k)}\n${cats.map((c) => `${catLabel[c]}: ${data[k][c]}`).join('\n')}`),
        h('rect', { class: 'a-hit', x: i * colW, y: 0, width: colW, height: H }));
      let y = H - B;
      for (const c of cats) {
        const v = data[k][c];
        if (!v) continue;
        const bh = (v / max) * (H - B - 12);
        y -= bh;
        g.append(h('rect', { class: `seg k-${c}`, x: i * colW + colW * 0.18, y, width: colW * 0.64, height: Math.max(1, bh - 1), rx: 2 }));
      }
      g.append(h('text', { class: 'a-lbl', x: i * colW + colW / 2, y: H - 4 }, dayLabel(k).slice(4)));
      svg.append(g);
    });
    mount('activity', svg, h('div', { class: 'legend' }, cats.map((c) => h('span', null, h('i', { class: `k-${c}` }), catLabel[c])),
      ui.evDay ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { ui.evDay = null; renderActivity(); renderEvents(); } }, `Clear day filter (${dayLabel(ui.evDay)})`) : null));
    $('history-meta').textContent = `${(S.events || []).length} events retained · ${fmtNum(S.overview.mergedLast30d)} merges in 30 d`;
  }

  function renderMerges() {
    const merged = S.github.merged || [];
    const closed = S.github.closedIssues || [];
    $('merges-meta').textContent = `${merged.length} in 30 d${S.github.developSha ? ` · develop @ ${S.github.developSha.slice(0, 7)} (${fmtDT(S.github.developAt)})` : ''}`;
    $('issues-meta').textContent = `${closed.length} with DEV- refs in 30 d`;
    mount('merges', dayBars(merged, 'mergedAt'),
      merged.length ? h('div', { class: 'scroll' }, merged.map((p) => h('button', { class: 'item', type: 'button', onclick: () => openModal('merge', { number: p.number }) },
        h('span', { class: 'dot ok' }),
        h('span', { class: 'i-main' }, h('div', { class: 'i-title' }, `#${p.number} `, h('span', { class: 'muted' }, p.title)),
          h('div', { class: 'i-sub' }, `${fmtDT(p.mergedAt)} PKT · ${(p.sha || '').slice(0, 7)}${(p.issues || []).length ? ` · ${p.issues.join(', ')}` : ''}`)),
        h('span', { class: 'i-side' }, ago(p.mergedAt))))) : h('div', { class: 'empty' }, 'No merges reported'));
    mount('issues', dayBars(closed, 'closedAt'),
      closed.length ? h('div', { class: 'scroll' }, closed.map((i) => h('button', { class: 'item', type: 'button', onclick: () => openModal('ghissue', { number: i.number }) },
        h('span', { class: 'dot ok' }),
        h('span', { class: 'i-main' }, h('div', { class: 'i-title' }, `#${i.number} `, h('span', { class: 'muted' }, i.title)),
          h('div', { class: 'i-sub' }, `${fmtDT(i.closedAt)} PKT · ${(i.issues || []).join(', ')}`)),
        h('span', { class: 'i-side' }, ago(i.closedAt))))) : h('div', { class: 'empty' }, 'No closed issues reported'));
  }

  function openEvent(e) {
    if (e.pr) return openModal('merge', { number: e.pr });
    if (e.ghIssue) return openModal('ghissue', { number: e.ghIssue });
    if (e.batch && e.issue && batchById(e.batch)) return openModal('task', { batch: e.batch, issue: e.issue });
    if (e.batch && e.run) return openModal('run', { batch: e.batch, run: e.run });
    return openModal('event', e);
  }

  function renderEvents() {
    const all = S.events || [];
    const kinds = [...new Set(all.map((e) => e.kind).filter(Boolean))].sort();
    const q = ui.evQ.toLowerCase();
    const list = all.filter((e) => (!ui.evKind || e.kind === ui.evKind) && (!ui.evDay || dayKey(e.ts) === ui.evDay)
      && (!q || [e.text, e.issue, e.batch, e.run].filter(Boolean).join(' ').toLowerCase().includes(q)));
    const shown = list.slice(0, ui.evLimit);
    $('events-meta').textContent = `${list.length} of ${all.length} events${ui.evDay ? ` · ${dayLabel(ui.evDay)}` : ''}`;
    const groups = [];
    for (const e of shown) {
      const k = dayKey(e.ts);
      if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, items: [] });
      groups[groups.length - 1].items.push(e);
    }
    const search = $('ev-q') || h('input', { id: 'ev-q', type: 'search', placeholder: 'Search events…', 'aria-label': 'Search events', autocomplete: 'off' });
    if (!search.dataset.wired) {
      search.dataset.wired = '1';
      search.addEventListener('input', () => { ui.evQ = search.value.trim(); ui.evLimit = 100; renderEvents(); });
    }
    const tools = $('ev-tools') || h('div', { id: 'ev-tools', class: 'tl-tools' });
    tools.replaceChildren(search, ...['', ...kinds].map((k) => h('button', {
      class: `btn ${ui.evKind === k ? 'on' : ''}`, type: 'button', onclick: () => { ui.evKind = k; ui.evLimit = 100; renderEvents(); },
    }, k || 'all')));
    const wrap = h('div', { class: 'tl-wrap' }, groups.length ? groups.map((g) => [h('div', { class: 'tl-day' }, `${dayLabel(g.k)} · ${g.items.length}`),
      h('div', { class: 'tl' }, g.items.map((e) => h('button', { class: `tl-item ev-${e.level || ''} ${e.kind === 'merge' ? 'k-merge-i' : ''}`, type: 'button', onclick: () => openEvent(e) },
        h('span', { class: 't' }, fmtHM(e.ts)),
        h('span', { class: 'x' }, h('span', { class: 'txt' }, h('span', { class: 'ev-kind' }, e.kind || 'event'), e.issue ? h('b', null, `${e.issue} `) : null, e.text)),
        h('span', { class: 'muted small' }, e.batch ? batchName(e.batch) : ''))))]) : h('div', { class: 'empty' }, 'No events match'));
    const more = list.length > ui.evLimit ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { ui.evLimit += 200; renderEvents(); } }, `Load more (${list.length - ui.evLimit} older)`) : null;
    const container = $('events');
    const scrollTop = container.querySelector('.tl-wrap')?.scrollTop || 0;
    container.replaceChildren(tools, wrap, ...(more ? [more] : []));
    wrap.scrollTop = scrollTop;
  }

  // ------------------------------------------------------------------ machine
  function renderWorker() {
    const sys = S.worker.system || {};
    const workers = (S.box.workers || []);
    const w = workers.find((x) => x.primary) || workers[0] || {};
    const spot = w.spotPrice;
    const cap = S.limits.spotCap;
    $('worker-meta').textContent = S.worker.collectedAt ? `collected ${ago(S.worker.collectedAt)}` : 'no worker data yet';
    const cores = sys.cores || 1;
    const load = sys.load || [];
    const mem = sys.mem || {};
    const disks = sys.disks || {};
    const gauges = [
      gauge('CPU', sys.cpuPct, isNum(sys.cpuPct) ? `${Math.round(sys.cpuPct)}%` : '—', `${cores} cores`,
        { spark: sparkline(historyCol('cpuPct'), 100), onclick: () => openModal('metric', { field: 'cpuPct' }) }),
      gauge('Load', isNum(load[0]) ? (100 * load[0]) / cores : null, isNum(load[0]) ? load[0].toFixed(2) : '—',
        isNum(load[1]) ? `5m ${load[1].toFixed(2)} · 15m ${load[2].toFixed(2)}` : '',
        { warn: 75, crit: 90, mark: 90, spark: sparkline(historyCol('load1'), cores), onclick: () => openModal('metric', { field: 'load1' }) }),
      gauge('RAM', mem.pct, isNum(mem.pct) ? `${Math.round(mem.pct)}%` : '—', `${fmtGiB(mem.usedBytes)} / ${fmtGiB(mem.totalBytes)}`,
        { spark: sparkline(historyCol('memPct'), 100), onclick: () => openModal('metric', { field: 'memPct' }) }),
    ];
    for (const [path, field] of [['/workspace', 'workspacePct'], ['/scratch', 'scratchPct']]) {
      const d = disks[path];
      let sub = d ? `${fmtGiB(d.freeBytes)} free of ${fmtGiB(d.totalBytes)}` : 'not mounted';
      if (d && path === '/workspace') {
        const head = d.freeBytes - S.limits.reserveBytes;
        sub += ` · ${head >= 0 ? '+' : '−'}${fmtGiB(Math.abs(head))} vs 200 GiB reserve`;
      }
      gauges.push(gauge(path, d ? d.pct : null, d ? `${Math.round(d.pct)}%` : '—', sub,
        { warn: 75, crit: S.limits.diskAlert, mark: S.limits.diskAlert, spark: sparkline(historyCol(field), 100), onclick: () => openModal('metric', { field }) }));
    }
    const psi = sys.psi || {};
    const psiTxt = ['cpu', 'memory', 'io'].map((r) => {
      const p = psi[r];
      if (!p || !p.some) return null;
      return `${r} ${p.some.avg10.toFixed(1)}%${p.full ? ` / ${p.full.avg10.toFixed(1)}%` : ''}`;
    }).filter(Boolean).join(' · ') || 'n/a';
    const svc = S.worker.services;
    const services = svc === null || svc === undefined
      ? [h('span', { class: 'chip' }, h('i'), 'systemd unavailable')]
      : svc.length ? svc.map((s) => h('button', {
        class: `chip click ${s.active === 'active' ? 'ok' : s.active === 'failed' ? 'bad' : s.active === 'activating' ? 'run' : ''}`, type: 'button',
        title: `${s.active}/${s.sub}${s.result ? ` (${s.result})` : ''}`, onclick: () => openModal('service', { unit: s.unit }),
      }, h('i'), s.unit)) : [h('span', { class: 'muted small' }, 'no matching units')];
    const ks = S.worker.killSwitch || {};
    const procs = S.worker.codexProcs || {};
    mount('worker',
      h('dl', { class: 'kv' },
        kv('Instance', h('a', { href: '#', ...activate((e) => { e.preventDefault(); openModal('workers', {}); }) }, w.instanceId || '—')), kv('Type', w.instanceType), kv('AZ', w.az),
        kv('State', w.state ? `${w.state}${w.lifecycle ? ` · ${w.lifecycle}` : ''}` : '—'),
        kv('Uptime', isNum(sys.uptimeSec) ? fmtDur(sys.uptimeSec) : '—'),
        kv('Launched', isNum(w.launchTime) ? `${fmtDT(w.launchTime)} PKT` : '—'),
        kv('Codex procs', isNum(procs.total) ? String(procs.total) : '—'),
        kv('PSI some/full avg10', psiTxt)),
      h('div', { class: 'gauges' }, gauges),
      h('div', { class: 'subrow' },
        h('div', { class: 'spot' },
          h('div', { class: 'small muted' }, 'Spot price / hour vs ', h('b', null, `$${cap.toFixed(2)}`), ' cap'),
          h('div', { class: 'num' }, h('b', null, isNum(spot) ? `$${spot.toFixed(4)}` : 'unknown'),
            w.spotRequestState ? h('span', { class: 'muted small' }, ` · request ${w.spotRequestState}${w.spotRequestStatus ? ` (${w.spotRequestStatus})` : ''}`) : null),
          bar(isNum(spot) ? spot : 0, cap * 1.25, isNum(spot) && spot > cap ? 'bad' : 'ok', cap)),
        h('div', null, h('button', { class: `pill chip click ${ks.pass === true ? 'pill-ok' : ks.pass === false ? 'pill-bad' : 'pill-muted'}`, type: 'button', onclick: () => openModal('killswitch', {}) },
          `Kill-switch ${ks.pass === true ? 'PASS' : ks.pass === false ? 'FAIL' : 'unknown'}`),
        h('div', { class: 'small muted' }, ks.checkedAt ? `checked ${fmtHM(ks.checkedAt)} PKT` : ''))),
      h('h3', { class: 'section-title' }, 'Services'),
      h('div', { class: 'chips' }, services));
  }

  // ------------------------------------------------------------------ modal (drill-down with back stack)
  function openModal(kind, key) {
    const dlg = $('dlg');
    if (!dlg.open) ui.modal = [];
    ui.modal.push({ kind, key });
    renderModal();
    if (!dlg.open) dlg.showModal();
    $('dlg').scrollTop = 0;
  }

  function setHead(kicker, title, sub) {
    $('dlg-kicker').textContent = kicker;
    $('dlg-title').replaceChildren(...[title].flat());
    $('dlg-sub').textContent = sub || '';
    $('dlg-back').classList.toggle('hidden', ui.modal.length < 2);
  }

  const taskItem = (b, t) => h('button', { class: 'item', type: 'button', onclick: () => openModal('task', { batch: b.id, issue: t.issue }) },
    phase(t.phase),
    h('span', { class: 'i-main' }, h('div', { class: 'i-title' }, t.issue, t.title ? h('span', { class: 'muted' }, ` · ${t.title}`) : null),
      h('div', { class: 'i-sub' }, `${b.label || b.id}${t.finalSHA ? ` · ${t.finalSHA.slice(0, 7)}` : ''}${t.nextGate ? ` · next: ${GATE_LONG[t.nextGate] || t.nextGate}` : ''}`)),
    h('span', { class: 'i-side' }, ago(t.last)));

  function findTask(issue) {
    return allTasks().filter(({ t }) => t.issue === issue).sort((a, c) => (c.t.last || 0) - (a.t.last || 0))[0];
  }

  function renderModal() {
    const top = ui.modal[ui.modal.length - 1];
    if (!top) return;
    const R = {
      task: modalTask, merge: modalMerge, ghissue: modalGhIssue, run: modalRun, metric: modalMetric, list: modalList,
      service: modalService, alert: modalAlert, insight: modalInsight, killswitch: modalKillswitch, usage: modalUsage, workers: modalWorkers, file: modalFile, event: modalEvent,
    }[top.kind];
    mount('dlg-body', R ? R(top.key) : evidence(top));
  }

  function modalList(k) {
    let items;
    if (k.stage) items = stageTasks(k.stage).map(({ b, t }) => [b, t]);
    else if (k.gate) items = ((S.next.upcoming || {})[k.gate] || []).map((x) => { const b = batchById(x.batch); return [b, b && b.tasks.find((t) => t.issue === x.issue)]; }).filter(([b, t]) => b && t);
    else items = [];
    setHead('Task list', k.title, `${items.length} tasks`);
    return items.length ? h('div', null, items.map(([b, t]) => taskItem(b, t))) : h('div', { class: 'empty' }, 'No tasks');
  }

  function gantt(runs, now) {
    const spans = runs.map((r) => {
      const start = r.start ?? r.codexStart;
      const running = r.norm === 'RUNNING' || /RUNNING|VERIFYING/i.test(r.status || '');
      const end = r.end ?? (running ? now : r.last) ?? start;
      return { r, start, end };
    }).filter((s) => isNum(s.start));
    if (!spans.length) return h('div', { class: 'empty' }, 'No timing information yet');
    const t0 = Math.min(...spans.map((s) => s.start));
    const t1 = Math.max(t0 + 60, ...spans.map((s) => s.end || s.start));
    const W = 760; const L = 130; const rowH = 30; const H = 22 + spans.length * rowH;
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - 10);
    const svg = h('svg', { class: 'gantt', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'run timeline' });
    for (let i = 0; i <= 4; i += 1) {
      const t = t0 + ((t1 - t0) * i) / 4;
      svg.append(h('line', { class: 'g-grid', x1: x(t), x2: x(t), y1: 16, y2: H }), h('text', { class: 'g-tick', x: x(t), y: 11, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, fmtHM(t)));
    }
    spans.forEach(({ r, start, end }, i) => {
      const y = 20 + i * rowH;
      svg.append(h('text', { class: 'g-lbl', x: 6, y: y + 15 }, `${r.kind}:${r.run}`.slice(0, 20)));
      svg.append(h('rect', { class: 'fill-run', x: x(start), y: y + 2, width: Math.max(3, x(end) - x(start)), height: 20, rx: 4 },
        h('title', null, `${r.run} ${r.status || ''}\n${fmtDT(start)} → ${fmtDT(end)} (${fmtDur(end - start)})`)));
      if (isNum(r.codexStart)) {
        const ce = r.codexEnd ?? (r.norm === 'RUNNING' ? now : r.codexStart);
        svg.append(h('rect', { class: 'fill-RUNNING', x: x(r.codexStart), y: y + 6, width: Math.max(2, x(ce) - x(r.codexStart)), height: 5, rx: 2, opacity: 0.8 },
          h('title', null, `codex ${fmtDur(ce - r.codexStart)}`)));
      }
      for (const s of r.steps || []) {
        if (!isNum(s.start)) continue;
        const se = s.end ?? (s.status === 'RUNNING' ? now : s.start);
        svg.append(h('rect', { class: `fill-${s.status}`, x: x(s.start), y: y + 13, width: Math.max(2, x(se) - x(s.start)), height: 7, rx: 2 },
          h('title', null, `${s.name}: ${s.status} · ${fmtDur(se - s.start)}`)));
      }
    });
    return svg;
  }

  function modalTask(k) {
    const b = batchById(k.batch);
    const t = b && b.tasks.find((x) => x.issue === k.issue);
    if (!t) { setHead('Task', k.issue, 'not present in the latest data'); return h('div', { class: 'empty' }, 'Task no longer present in the latest data'); }
    const now = nowSec();
    setHead(`Task · ${b.label || b.id}`, [t.issue, ' ', phase(t.phase)], t.title || '');
    const cols = gateColumns([t]);
    const diff = t.gates.differential || {};
    const unit = t.gates.complete_unit || {};
    const unitFiles = unit.failedFiles || [];
    const newSet = new Set(diff.newFailures || []);
    const preExisting = unitFiles.filter((f) => !newSet.has(f));
    const linear = t.linearClosed === null ? 'n/a (Linear not configured)' : t.linear ? `${t.linear.state}${t.linearClosed ? ' ✓' : ''}` : 'unknown';
    const runs = [...(t.runs || [])].sort((a, c) => (a.start || a.last || 0) - (c.start || c.last || 0));
    const others = allTasks().filter(({ b: ob, t: ot }) => ot.issue === t.issue && ob.id !== b.id);
    const rel = relatedInsights(b.id, t.issue);
    return [
      rel.length ? h('div', { class: 'ins-list' }, rel.map((x) => insightRow(x, true))) : null,
      h('dl', { class: 'kv' },
        kv('Batch', h('a', { href: '#', ...activate((e) => { e.preventDefault(); selectBatch(b.id, true); }) }, b.label || b.id)),
        kv('Source SHA', h('span', { class: 'mono' }, t.sourceSHA || '—')),
        kv('Final SHA', h('span', { class: 'mono' }, t.finalSHA || '—')),
        kv('Model', t.model ? `${t.model}${t.effort ? ` · ${t.effort}` : ''}` : '—'),
        kv('Changed files', isNum(t.changedFiles) ? String(t.changedFiles) : '—'),
        kv('Next step', t.nextGate ? `${GATE_LONG[t.nextGate] || t.nextGate} (${t.nextGateStatus || 'pending'})` : 'complete'),
        kv('Merge PR', t.merge ? h('a', { href: '#', ...activate((e) => { e.preventDefault(); openModal('merge', { number: t.merge.number }); }) }, `#${t.merge.number}`) : 'not merged'),
        kv('Merged at', t.merge && isNum(t.merge.mergedAt) ? fmtFull(t.merge.mergedAt) : '—'),
        kv('GitHub issue', t.ghIssue ? h('a', { href: '#', ...activate((e) => { e.preventDefault(); openModal('ghissue', { number: t.ghIssue.number }); }) }, `#${t.ghIssue.number} closed`) : 'open / not found'),
        kv('Linear', linear),
        kv('Failed gate', t.failedGate || '—'),
        kv('Raw status', h('span', { class: 'mono', title: t.status || '' }, t.status || '—'))),
      h('div', null, h('h3', { class: 'section-title' }, 'Gates'),
        h('div', { class: 'gate-strip' }, cols.map((key) => {
          const g = t.gates[key];
          return h('span', { class: 'chip', title: gateTitle(key, g) }, status(g ? g.status : 'PENDING'), GATE_LONG[key] || key,
            key === 'final_sha' && g && g.sha ? h('span', { class: 'mono muted' }, g.sha.slice(0, 7)) : null);
        }))),
      h('div', null, h('h3', { class: 'section-title' }, 'Timeline'), gantt(runs, now),
        h('div', { class: 'legend' }, ['PASS', 'FAIL', 'RUNNING', 'BLOCKED', 'PENDING'].map((s) => h('span', null, h('i', { style: { background: `var(--${{ PASS: 'ok', FAIL: 'bad', RUNNING: 'run', BLOCKED: 'warn', PENDING: 'pend' }[s]})` } }), s.toLowerCase())),
          h('span', null, h('i', { style: { background: '#7c9cff55' } }), 'run span'))),
      h('div', { class: 'cols2' },
        h('div', null, h('h3', { class: 'section-title' }, `New unit failures vs baseline (${(diff.newFailures || []).length})`),
          diff.note ? h('div', { class: 'small muted' }, diff.note) : null,
          (diff.newFailures || []).length ? h('ul', { class: 'files new' }, diff.newFailures.map((f) => h('li', { title: f }, f)))
            : h('div', { class: 'small muted' }, diff.status === 'PASS' ? 'None — differential PASS' : `Differential ${diff.status || 'PENDING'}`)),
        h('div', null, h('h3', { class: 'section-title' }, `Pre-existing (baseline) failures (${preExisting.length})`),
          preExisting.length ? h('ul', { class: 'files base' }, preExisting.map((f) => h('li', { title: f }, f))) : h('div', { class: 'small muted' }, 'None'))),
      h('div', null, h('h3', { class: 'section-title' }, `Runs (${runs.length})`),
        h('div', { class: 'list' }, [...runs].reverse().map((r) => runCard(b, r, now)))),
      others.length ? h('div', null, h('h3', { class: 'section-title' }, 'Same issue in other batches'), others.map(({ b: ob, t: ot }) => taskItem(ob, ot))) : null,
      evidence(t),
    ];
  }

  function runCard(b, r, now) {
    return h('div', { class: 'run-card' },
      h('header', null, h('a', { href: '#', ...activate((e) => { e.preventDefault(); openModal('run', { batch: b.id, run: r.run }); }) }, h('b', null, r.run)),
        h('span', { class: 'chip' }, r.kind), status(r.norm),
        h('span', { class: 'mono muted small' }, r.status || ''),
        h('span', { class: 'muted small' }, `${fmtDT(r.start)} → ${r.end ? fmtDT(r.end) : (r.norm === 'RUNNING' ? 'now' : fmtDT(r.last))}`),
        isNum(r.start) ? h('span', { class: 'muted small' }, fmtDur((r.end || (r.norm === 'RUNNING' ? now : r.last) || r.start) - r.start)) : null,
        r.model ? h('span', { class: 'mono small' }, `${r.model}${r.effort ? `/${r.effort}` : ''}`) : null,
        isNum(r.codexExitCode) ? h('span', { class: `chip ${r.codexExitCode === 0 ? 'ok' : 'bad'}` }, h('i'), `exit ${r.codexExitCode}`) : null,
        r.newSourceSHA ? h('span', { class: 'mono small' }, `→ ${r.newSourceSHA}`) : (r.sourceSHA ? h('span', { class: 'mono small muted' }, `@ ${r.sourceSHA}`) : null),
        r.stale ? h('span', { class: 'pill pill-warn' }, 'stale ledger') : null),
      (r.steps || []).length || (r.subGates || []).length ? h('table', null,
        h('thead', null, h('tr', null, ['Step', 'Gate', 'Status', 'Started', 'Duration', 'Tests', 'Exit'].map((x) => h('th', null, x)))),
        h('tbody', null, [...(r.steps || []), ...(r.subGates || [])].map((s) => h('tr', null,
          h('td', { class: 'mono' }, s.name), h('td', { class: 'muted' }, GATE_LABEL[s.gate] || s.gate), h('td', null, status(s.status)),
          h('td', { class: 'muted small' }, isNum(s.start) ? fmtHM(s.start) : '—'),
          h('td', { class: 'num' }, isNum(s.start) ? fmtDur((s.end ?? (s.status === 'RUNNING' ? now : s.start)) - s.start) : '—'),
          h('td', { class: 'num' }, isNum(s.passed) || isNum(s.failed) ? `${s.passed ?? '?'} ✓ / ${s.failed ?? '?'} ✗` : '—'),
          h('td', { class: 'num' }, isNum(s.exit) ? String(s.exit) : '—'))))) : h('div', { class: 'small muted' }, 'No step details'),
      (r.failedFiles || []).length ? h('details', { class: 'evidence' }, h('summary', null, `Failed files (${r.failedFiles.length})`), h('ul', { class: 'files' }, r.failedFiles.map((f) => h('li', { title: f }, f)))) : null,
      r.error ? h('div', { class: 'err' }, r.error) : null);
  }

  function modalRun(k) {
    const b = batchById(k.batch);
    const run = b && (b.runs || []).find((r) => r.name === k.run);
    if (!b) { setHead('Run', k.run, ''); return h('div', { class: 'empty' }, 'Batch not present'); }
    const tasks = b.tasks.filter((t) => (t.runs || []).some((r) => r.run === k.run));
    const base = b.baseline && b.baseline.run === k.run ? b.baseline : null;
    const ledgers = (b.ledgers || []).filter((l) => l.run === k.run);
    setHead(`Run · ${b.label || b.id}`, k.run, run ? `${run.kind} · ${run.tasks} tasks · ${run.active || 0} active` : '');
    return [
      run ? h('dl', { class: 'kv' }, kv('Kind', run.kind), kv('Started', fmtFull(run.start)), kv('Last activity', `${fmtFull(run.last)} (${ago(run.last)})`),
        kv('Active', String(run.active || 0)), kv('Cap', run.cap ? String(run.cap) : '—'),
        kv('Statuses', Object.entries(run.counts || {}).map(([s, n]) => `${s} ${n}`).join(' · ') || '—')) : null,
      base ? h('div', null, h('h3', { class: 'section-title' }, 'Baseline'),
        h('dl', { class: 'kv' }, kv('Base SHA', h('span', { class: 'mono' }, base.baseSHA || '—')), kv('Status', base.status), kv('Failed tests', fmtNum(base.numFailedTests)),
          kv('Passed tests', fmtNum(base.numPassedTests)), kv('Failed files', fmtNum(base.failedFileCount)), kv('Window', `${fmtDT(base.start)} → ${fmtDT(base.end)}`)),
        h('ul', { class: 'files base' }, (base.failedFiles || []).map((f) => h('li', { title: f }, f)))) : null,
      ledgers.length ? h('div', null, h('h3', { class: 'section-title' }, 'Ledgers'), ledgers.map((l) => evidence(l, `${l.file} · ${isNum(l.at) ? fmtFull(l.at) : ''}`))) : null,
      h('div', null, h('h3', { class: 'section-title' }, `Tasks in this run (${tasks.length})`), tasks.length ? tasks.map((t) => taskItem(b, t)) : h('div', { class: 'empty' }, 'No tasks')),
      evidence({ run, baseline: base }),
    ];
  }

  function modalMerge(k) {
    const pr = (S.github.merged || []).find((p) => p.number === k.number);
    if (!pr) { setHead('Merge', `#${k.number}`, ''); return h('div', { class: 'empty' }, 'PR not in the last 30 days of data'); }
    setHead('Merged into develop', `PR #${pr.number}`, pr.title);
    const linked = (pr.issues || []).map(findTask).filter(Boolean);
    return [
      h('dl', { class: 'kv' }, kv('Merged at', fmtFull(pr.mergedAt)), kv('Merge SHA', h('span', { class: 'mono' }, pr.sha || '—')),
        kv('Issues', (pr.issues || []).join(', ') || '—'), kv('GitHub', extLink('pull', pr.number, `Open PR #${pr.number} ↗`))),
      h('div', null, h('h3', { class: 'section-title' }, `Campaign tasks (${linked.length})`), linked.length ? linked.map(({ b, t }) => taskItem(b, t)) : h('div', { class: 'empty' }, 'No matching campaign task')),
      evidence(pr),
    ];
  }

  function modalGhIssue(k) {
    const it = (S.github.closedIssues || []).find((i) => i.number === k.number);
    if (!it) { setHead('Issue', `#${k.number}`, ''); return h('div', { class: 'empty' }, 'Issue not in the last 30 days of data'); }
    setHead('GitHub issue closed', `#${it.number}`, it.title);
    const linked = (it.issues || []).map(findTask).filter(Boolean);
    return [
      h('dl', { class: 'kv' }, kv('Closed at', fmtFull(it.closedAt)), kv('Reason', it.stateReason || '—'), kv('Refs', (it.issues || []).join(', ')), kv('GitHub', extLink('issues', it.number, `Open issue #${it.number} ↗`))),
      h('div', null, h('h3', { class: 'section-title' }, `Campaign tasks (${linked.length})`), linked.length ? linked.map(({ b, t }) => taskItem(b, t)) : h('div', { class: 'empty' }, 'No matching campaign task')),
      evidence(it),
    ];
  }

  function modalMetric(k) {
    const m = METRICS[k.field] || { label: k.field };
    const hist = S.worker.history || {};
    const idx = (hist.fields || []).indexOf(k.field);
    const cores = (S.worker.system || {}).cores || 1;
    const thr = m.thr === 'load' ? 0.9 * cores : m.thr;
    const recent = idx < 0 ? [] : (hist.recent || []).map((r) => [r[0], r[idx]]);
    const hourly = idx < 0 ? [] : (hist.hourly || []).map((r) => [r[0], r[idx]]);
    const vals = recent.map((r) => r[1]).filter(isNum);
    const stat = (arr) => (arr.length ? { min: Math.min(...arr), max: Math.max(...arr), avg: arr.reduce((a, v) => a + v, 0) / arr.length } : {});
    const st = stat(vals);
    setHead('Worker metric', m.label, `${vals.length} samples in the last hour · 1-min resolution`);
    return [
      h('dl', { class: 'kv' }, kv('Latest', isNum(vals[vals.length - 1]) ? `${vals[vals.length - 1].toFixed(1)}${m.unit}` : '—'),
        kv('Min / avg / max (1 h)', isNum(st.avg) ? `${st.min.toFixed(1)} / ${st.avg.toFixed(1)} / ${st.max.toFixed(1)}${m.unit}` : '—'),
        kv('Alert threshold', isNum(thr) ? `${thr.toFixed(1)}${m.unit}${m.thr === 'load' ? ' (0.9 × cores, 5 min)' : ''}` : 'none')),
      h('div', null, h('h3', { class: 'section-title' }, 'Last hour'), bigChart(recent, m.max, thr)),
      h('div', null, h('h3', { class: 'section-title' }, 'Last 7 days (hourly average)'), bigChart(hourly, m.max, thr)),
      evidence({ system: S.worker.system }),
    ];
  }

  function modalService(k) {
    const s = (S.worker.services || []).find((x) => x.unit === k.unit) || {};
    setHead('systemd unit', k.unit, `${s.active || '?'} / ${s.sub || '?'}`);
    return [h('dl', { class: 'kv' }, kv('ActiveState', s.active), kv('SubState', s.sub), kv('Result', s.result)),
      h('div', { class: 'small muted' }, 'Read via `systemctl show` (read-only). The dashboard never starts or stops units.'), evidence(s)];
  }

  function modalAlert(a) {
    setHead(a.level === 'crit' ? 'Critical alert' : 'Warning', a.message, a.code);
    const related = a.code.startsWith('disk') || a.code === 'reserve' ? () => openModal('metric', { field: a.code.includes('scratch') ? 'scratchPct' : 'workspacePct' })
      : a.code === 'load' ? () => openModal('metric', { field: 'load1' }) : a.code === 'killswitch' ? () => openModal('killswitch', {})
        : a.code.startsWith('usage') ? () => openModal('usage', {}) : a.code.startsWith('spot') ? () => openModal('workers', {})
          : a.code.startsWith('unit-') ? () => openModal('service', { unit: a.code.slice(5) }) : null;
    return [related ? h('button', { class: 'btn', type: 'button', onclick: related }, 'Open related detail →') : null, evidence(a)];
  }

  function modalKillswitch() {
    const ks = S.worker.killSwitch || {};
    setHead('Egress kill-switch', `Kill-switch ${ks.pass === true ? 'PASS' : ks.pass === false ? 'FAIL' : 'unknown'}`, ks.detail || '');
    return [h('dl', { class: 'kv' }, kv('Result', ks.pass === true ? 'PASS' : ks.pass === false ? 'FAIL' : 'unknown'), kv('Checked', fmtFull(ks.checkedAt)), kv('Detail', ks.detail)),
      h('div', { class: 'small muted' }, 'Checked every 5 minutes with a read-only `tailscale status --json` inside the codex-home namespace: backend must be Running and the exit node online. Only pass/fail is reported — never addresses.'),
      evidence(ks)];
  }

  function modalUsage() {
    const u = S.worker.usage || {};
    setHead('Weekly usage', isNum(u.weeklyPct) ? `${u.weeklyPct}%` : 'unknown', u.stopActive ? 'usage STOP marker active' : 'stop marker clear');
    return [h('dl', { class: 'kv' }, kv('Weekly usage', isNum(u.weeklyPct) ? `${u.weeklyPct}%` : 'unknown'), kv('Stop line', `${S.limits.usageStop}%`),
      kv('Stop marker', u.stopActive ? 'ACTIVE' : 'clear'), kv('Stop since', fmtFull(u.stopSince)), kv('Last cleared', fmtFull(u.clearedAt)), kv('Note', u.note)),
    evidence(u)];
  }

  function modalWorkers() {
    const ws = S.box.workers || [];
    const m = S.box.machine || {};
    setHead('EC2 workers', `${ws.length} worker${ws.length === 1 ? '' : 's'}`, `region ${S.box.region || '—'}`);
    return [h('dl', { class: 'kv' }, kv('Machine hours (all time)', fmtNum(m.hours, 1)), kv('Spot cost (all time)', isNum(m.costUsd) ? `$${fmtNum(m.costUsd, 2)}` : '—'), kv('Tracking since', fmtFull(m.since))),
      ws.map((w) => h('div', { class: 'run-card' }, h('header', null, h('b', null, w.name || w.instanceId), h('span', { class: 'chip' }, w.state || '?'), w.primary ? h('span', { class: 'badge' }, 'primary') : null),
        h('dl', { class: 'kv' }, kv('Instance', w.instanceId), kv('Type', w.instanceType), kv('AZ', w.az), kv('Lifecycle', w.lifecycle), kv('Launched', fmtFull(w.launchTime)),
          kv('Spot price', isNum(w.spotPrice) ? `$${w.spotPrice.toFixed(4)}/h` : '—'), kv('Spot request', w.spotRequestState ? `${w.spotRequestState} (${w.spotRequestStatus || '?'})` : '—'),
          kv('Hours / cost', m.perInstance && m.perInstance[w.instanceId] ? `${m.perInstance[w.instanceId].hours} h · $${m.perInstance[w.instanceId].costUsd}` : '—')))),
      evidence(S.box)];
  }

  function modalFile(k) {
    setHead(`Campaign file · ${batchName(k.batch)}`, k.file.file, isNum(k.file.mtime) ? `modified ${fmtFull(k.file.mtime)}` : '');
    return [k.file.counts ? h('div', { class: 'chips' }, Object.entries(k.file.counts).map(([s, n]) => h('span', { class: 'chip' }, status(s), `${n}`))) : null, evidence(k.file, 'Summary (sanitized)')];
  }

  function modalEvent(e) {
    setHead(`Event · ${e.kind || ''}`, e.text, fmtFull(e.ts));
    return [e.batch && batchById(e.batch) ? h('button', { class: 'btn', type: 'button', onclick: () => selectBatch(e.batch, true) }, `Open batch ${batchName(e.batch)} →`) : null, evidence(e)];
  }


  // ------------------------------------------------------------------ deep links (also used by Claude's evidence links)
  function route(hash) {
    if (!S || !hash || hash.length < 2) return false;
    const raw = hash.slice(1);
    const [key, ...rest] = raw.split('=');
    const val = rest.join('=');
    const dec = (x) => { try { return decodeURIComponent(x); } catch (e) { return x; } };
    const pair = () => { const i = val.indexOf('/'); return i < 0 ? [dec(val), ''] : [dec(val.slice(0, i)), dec(val.slice(i + 1))]; };
    if (key === 'task') { const [batch, issue] = pair(); const f = batchById(batch) ? { batch, issue } : findTask(issue) && { batch: findTask(issue).b.id, issue }; if (f) openModal('task', f); return true; }
    if (key === 'run') { const [batch, run] = pair(); openModal('run', { batch, run }); return true; }
    if (key === 'batch') { selectBatch(dec(val), true); return true; }
    if (key === 'pr') { openModal('merge', { number: Number(val) }); return true; }
    if (key === 'issue') { openModal('ghissue', { number: Number(val) }); return true; }
    if (key === 'metric') { openModal('metric', { field: dec(val) }); return true; }
    if (raw === 'usage') { openModal('usage', {}); return true; }
    if (raw === 'workers') { openModal('workers', {}); return true; }
    return false;
  }
  const ROUTE_RE = /^#((task|run|batch|pr|issue|metric)=[\w%.\-/]+|usage|workers)$/;

  // ------------------------------------------------------------------ safe markdown (DOM only, no innerHTML)
  function safeHref(href) {
    if (ROUTE_RE.test(href)) return href;
    if (S && href.startsWith(`https://github.com/${S.repo}/`) && /^https:\/\/github\.com\/[\w.\-]+\/[\w.\-]+\/(pull|issues|commit)\/\w+$/.test(href)) return href;
    return null;
  }
  function inline(text) {
    const out = [];
    const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
    let last = 0; let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[2]) out.push(h('strong', null, m[2]));
      else if (m[3]) out.push(h('code', null, m[3]));
      else {
        const href = safeHref(m[5]);
        if (!href) out.push(m[4]);
        else if (href.startsWith('#')) out.push(h('a', { href }, m[4]));
        else out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, `${m[4]} ↗`));
      }
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function markdown(src) {
    const nodes = [];
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    let list = null; let para = [];
    const flushPara = () => { if (para.length) { nodes.push(h('p', null, inline(para.join(' ')))); para = []; } };
    const flushList = () => { if (list) { nodes.push(list); list = null; } };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flushPara(); flushList();
        const buf = [];
        for (i += 1; i < lines.length && !/^```/.test(lines[i]); i += 1) buf.push(lines[i]);
        nodes.push(h('pre', null, buf.join('\n')));
        continue;
      }
      const hm = line.match(/^#{1,4}\s+(.*)/);
      const ul = line.match(/^\s*[-*•]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (hm) { flushPara(); flushList(); nodes.push(h('h4', null, inline(hm[1]))); } else if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tagName.toLowerCase() !== tag) { flushList(); list = h(tag); }
        list.append(h('li', null, inline((ul || ol)[1])));
      } else if (!line.trim()) { flushPara(); flushList(); } else { flushList(); para.push(line.trim()); }
    }
    flushPara(); flushList();
    return nodes;
  }

  // ------------------------------------------------------------------ Claude chat drawer
  const chat = { history: [], busy: false };
  const SUGGESTIONS = ['What is running right now?', 'Which tasks are stuck or failing repeatedly?', 'What will merge next?',
    'Summarise the last 24 hours', 'How is the worker machine doing?', 'Which batch needs attention?'];
  try { const saved = JSON.parse(sessionStorage.getItem('ops-chat') || '[]'); if (Array.isArray(saved)) chat.history = saved.slice(-30); } catch (e) { /* storage unavailable */ }
  const saveChat = () => { try { sessionStorage.setItem('ops-chat', JSON.stringify(chat.history.slice(-30))); } catch (e) { /* ignore */ } };

  function renderChat(pending) {
    const log = $('ai-log');
    const items = chat.history.map((m) => (m.role === 'user' ? h('div', { class: 'msg user' }, m.content)
      : h('div', { class: `msg ${m.error ? 'error' : 'assistant'}` }, m.error ? m.content : markdown(m.content),
        m.meta ? h('div', { class: 'meta' }, m.meta) : null)));
    if (!items.length) items.push(h('div', { class: 'msg assistant' }, markdown('Hi — I can answer anything the dashboard knows: batches, tasks and gates, Codex jobs, merges, GitHub/Linear state, worker metrics and history. I link to the evidence so you can click through.')));
    if (pending) items.push(h('div', { class: 'msg assistant typing', 'aria-label': 'Claude is thinking' }, h('i'), h('i'), h('i')));
    log.replaceChildren(...items);
    log.scrollTop = log.scrollHeight;
    mount('ai-suggest', chat.history.length ? null : SUGGESTIONS.map((q) => h('button', { class: 'btn ghost', type: 'button', onclick: () => sendChat(q) }, q)));
  }

  async function sendChat(text) {
    text = (text || '').trim();
    if (!text || chat.busy) return;
    chat.busy = true;
    $('ai-send').disabled = true;
    chat.history.push({ role: 'user', content: text });
    $('ai-input').value = '';
    renderChat(true);
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ops-dash' },
        body: JSON.stringify({ messages: chat.history.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })).slice(-16) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      chat.history.push({ role: 'assistant', content: data.reply || '(no answer)', meta: `${data.model || ''}${(data.tools || []).length ? ` · looked at ${[...new Set(data.tools)].join(', ')}` : ''}` });
    } catch (err) {
      chat.history.push({ role: 'assistant', error: true, content: `Couldn't get an answer: ${err.message}` });
    } finally {
      chat.busy = false;
      $('ai-send').disabled = false;
      saveChat();
      renderChat(false);
    }
  }

  function toggleChat(open) {
    const d = $('ai-drawer');
    const on = open ?? !d.classList.contains('open');
    d.classList.toggle('open', on);
    d.setAttribute('aria-hidden', on ? 'false' : 'true');
    $('ai-fab').setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { renderChat(chat.busy); setTimeout(() => $('ai-input').focus(), 200); }
  }

  function renderAIStatus() {
    const st = S.ai || {};
    $('ai-fab').classList.toggle('hidden', !st.enabled);
    $('ai-status').textContent = st.enabled ? `${st.model} · ${st.budgetExhausted ? 'daily budget reached' : `${st.budgetUsedPct ?? 0}% of daily budget used`}` : 'AI not configured';
  }


  // ------------------------------------------------------------------ insights (rule-based + AI)
  const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
  function allInsights() {
    const ins = S.insights || {};
    const ai = ins.ai || {};
    const list = [...(ins.rules || []), ...(ai.warnings || []).map((x) => ({ ...x, kind: 'warning' })), ...(ai.suggestions || []).map((x) => ({ ...x, kind: 'suggestion' }))];
    list.forEach((x, i) => { x.key = x.id || `ai:${x.kind}:${i}:${x.title}`; });
    return list.sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3) || (a.kind === 'warning' ? -1 : 1));
  }
  const SPARK = () => h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, h('path', { d: 'M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7z' }));

  function insightRow(x, compact) {
    const ev = (x.evidence || []).map((e) => { const href = safeHref(e.link); return href ? h('a', { href, onclick: (ev2) => ev2.stopPropagation() }, e.label) : null; });
    return h('div', { class: `ins sev-${x.severity}`, role: 'button', tabindex: 0, ...activate(() => openModal('insight', { key: x.key })) },
      h('span', { class: 'sev' }, x.severity === 'crit' ? 'crit' : x.severity),
      h('span', { class: 'i-main' }, h('div', { class: 'i-title' }, x.title), h('div', { class: 'i-reason' }, x.reason), ev.length ? h('div', { class: 'i-ev' }, compact ? ev.slice(0, 3) : ev) : null),
      h('span', { class: `src ${x.source === 'ai' ? 'ai' : 'rules'}` }, x.source === 'ai' ? '✦ CLAUDE' : 'RULE', h('div', { class: 'small dim' }, x.kind)));
  }

  function renderInsights() {
    const list = allInsights();
    const ai = (S.insights || {}).ai;
    const st = S.ai || {};
    for (const strip of document.querySelectorAll('.strip[data-area]')) {
      const area = strip.dataset.area;
      const items = list.filter((x) => x.area === area && x.kind === 'warning' && x.severity !== 'info');
      strip.replaceChildren(...items.slice(0, 3).map((x) => insightRow(x, true)),
        ...(items.length > 3 ? [h('button', { class: 'btn ghost ins-more', type: 'button', onclick: () => $('sec-insights').scrollIntoView({ behavior: 'smooth' }) }, `+${items.length - 3} more warnings`)] : []));
    }
    const warnings = list.filter((x) => x.kind === 'warning');
    const sugg = list.filter((x) => x.kind === 'suggestion');
    $('insights-meta').textContent = `${warnings.length} warnings · ${sugg.length} suggestions${ai && ai.generatedAt ? ` · Claude analysis ${ago(ai.generatedAt)}` : st.enabled ? ' · Claude analysis pending' : ''}`;
    $('ai-refresh').classList.toggle('hidden', !st.enabled);
    mount('insights',
      ai && ai.summary ? h('div', { class: 'ai-summary' }, SPARK(), h('div', null, h('div', { class: 'small eyebrow' }, `Claude · ${ai.model || ''} · ${fmtDT(ai.generatedAt)} PKT`), markdown(ai.summary))) : null,
      h('div', { class: 'ins-cols' },
        h('div', null, h('h3', null, `Warnings (${warnings.length})`), warnings.length ? h('div', { class: 'ins-list' }, warnings.map((x) => insightRow(x))) : h('div', { class: 'empty' }, 'Nothing is going the wrong way')),
        h('div', null, h('h3', null, `Suggestions (${sugg.length})`), sugg.length ? h('div', { class: 'ins-list' }, sugg.map((x) => insightRow(x))) : h('div', { class: 'empty' }, 'No suggestions right now'))));
  }

  function relatedInsights(batch, issue) {
    return allInsights().filter((x) => (issue && x.issue === issue) || (!issue && batch && x.batch === batch)
      || (x.evidence || []).some((e) => issue && e.link && decodeURIComponent(e.link).endsWith(`/${issue}`)));
  }

  function modalInsight(k) {
    const x = allInsights().find((i) => i.key === k.key);
    if (!x) { setHead('Insight', 'No longer active', ''); return h('div', { class: 'empty' }, 'This finding is no longer present in the latest data.'); }
    setHead(`${x.source === 'ai' ? 'Claude' : 'Rule'} ${x.kind} · ${x.severity}`, x.title, `${x.area}${x.batch ? ` · ${batchName(x.batch)}` : ''}${x.issue ? ` · ${x.issue}` : ''}`);
    return [h('div', { class: `ins sev-${x.severity}` }, h('span', { class: 'sev' }, x.severity), h('span', { class: 'i-main' }, markdown(x.reason)), h('span', { class: `src ${x.source === 'ai' ? 'ai' : 'rules'}` }, x.source === 'ai' ? '✦ CLAUDE' : 'RULE')),
      h('div', null, h('h3', { class: 'section-title' }, 'Evidence'), h('div', { class: 'chips' }, (x.evidence || []).map((e) => { const href = safeHref(e.link); return href ? h('a', { class: 'chip click', href }, h('i'), e.label) : null; }))),
      x.source === 'ai' ? h('div', { class: 'small muted' }, 'Generated by Claude from the dashboard data. It is advice only — the dashboard cannot take actions.') : h('div', { class: 'small muted' }, 'Deterministic rule evaluated on every refresh.'),
      evidence(x)];
  }

  async function refreshAnalysis() {
    const btn = $('ai-refresh');
    btn.disabled = true;
    try {
      const res = await fetch('/api/ai/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ops-dash' }, body: '{}' });
      const data = await res.json().catch(() => ({}));
      btn.textContent = res.ok ? 'Analysing…' : (data.error || 'Try later');
      setTimeout(() => { btn.textContent = 'Re-analyse'; btn.disabled = false; load(); }, res.ok ? 45000 : 5000);
    } catch (e) { btn.textContent = 'Re-analyse'; btn.disabled = false; }
  }

  // ------------------------------------------------------------------ wiring
  function init() {
    $('bd-close').addEventListener('click', () => selectBatch(ui.batch));
    for (const id of ['f-status', 'f-gate']) $(id).addEventListener('change', renderBatchDetail);
    $('f-search').addEventListener('input', renderBatchDetail);
    $('dlg-close').addEventListener('click', () => $('dlg').close());
    $('dlg-back').addEventListener('click', () => { ui.modal.pop(); renderModal(); });
    $('dlg').addEventListener('close', () => { ui.modal = []; });
    $('dlg').addEventListener('click', (e) => { if (e.target === $('dlg')) $('dlg').close(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (ROUTE_RE.test(href)) { e.preventDefault(); if (route(href)) history.replaceState(null, '', href); }
    });
    window.addEventListener('hashchange', () => { if (ROUTE_RE.test(location.hash)) route(location.hash); });
    $('ai-fab').addEventListener('click', () => toggleChat());
    $('ai-refresh').addEventListener('click', refreshAnalysis);
    $('ai-close').addEventListener('click', () => toggleChat(false));
    $('ai-clear').addEventListener('click', () => { chat.history = []; saveChat(); renderChat(false); });
    $('ai-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('ai-input').value); });
    $('ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('ai-input').value); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('ai-drawer').classList.contains('open') && !$('dlg').open) toggleChat(false); });
    if ('IntersectionObserver' in window) {
      const links = [...document.querySelectorAll('.tabs a')];
      const io = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${en.target.id}`));
      }, { rootMargin: '-40% 0px -55% 0px' });
      document.querySelectorAll('main > .section').forEach((s) => io.observe(s));
    }
    tickClock();
    setInterval(tickClock, 1000);
    load();
    setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
