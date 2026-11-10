/* Campaign Ops dashboard. Vanilla JS, no dependencies, CSP-safe (no inline styles or handlers, DOM built with createElement). */
'use strict';

(() => {
  const REFRESH_MS = 30000;
  const PKT_MS = 5 * 3600 * 1000;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'text', 'title', 'defs', 'linearGradient', 'stop', 'pattern', 'use', 'tspan']);
  const REQUIRED = ['prisma', 'typecheck', 'lint', 'complete_unit', 'host_build', 'docker'];
  const META_GATES = new Set(['merged', 'linear', 'gh', 'final_sha', 'differential']);
  const GATE_ORDER = ['prisma', 'typecheck', 'lint', 'complete_unit', 'host_build', 'docker', 'differential'];
  const GATE_TAIL = ['qa_browser', 'security', 'final_sha', 'merged', 'linear', 'gh'];
  const GATE_LABEL = {
    prisma: 'Prisma', typecheck: 'Types', lint: 'Lint', complete_unit: 'Unit', host_build: 'Build', docker: 'Docker',
    differential: 'Diff', qa_browser: 'QA', security: 'Sec', final_sha: 'Final SHA', merged: 'Merged', linear: 'Linear', gh: 'GitHub',
  };
  const GATE_LONG = {
    prisma: 'Prisma generate', typecheck: 'Typecheck', lint: 'Lint', complete_unit: 'Complete unit', host_build: 'Host build',
    docker: 'Docker build contract', differential: 'Differential vs baseline', qa_browser: 'QA / browser', security: 'Security',
    final_sha: 'Gates on final SHA', merged: 'Merged into develop', linear: 'Linear closed', gh: 'GitHub issue closed',
  };
  const STATUS_META = {
    done: { icon: 'check-circle', label: 'Done' }, merged: { icon: 'merge', label: 'Merged' }, passed: { icon: 'check-circle', label: 'Passed' },
    failed: { icon: 'x-circle', label: 'Failed' }, rejected: { icon: 'prohibit', label: 'Rejected' },
    blocked: { icon: 'prohibit', label: 'Blocked' }, running: { icon: 'circle-notch', label: 'Running' },
    pending_qa: { icon: 'hourglass', label: 'Pending QA / Security' },
    gates: { icon: 'hourglass', label: 'Awaiting gates' }, queued: { icon: 'circle-dashed', label: 'Queued' }, pending: { icon: 'circle-dashed', label: 'Pending' },
  };
  const FILTERS = [['', 'All'], ['running', 'Running'], ['failed', 'Failed'], ['rejected', 'Rejected'], ['pending_qa', 'Pending QA'], ['blocked', 'Blocked'], ['passed', 'Passed'], ['merged', 'Merged'], ['queued', 'Queued']];
  const SERIES = { pass: 'var(--s-pass)', merge: 'var(--s-merge)', codex: 'var(--s-codex)', fail: 'var(--s-fail)' };
  const SERIES_LABEL = { pass: 'Gate passes', merge: 'Merges and closures', codex: 'Codex runs', fail: 'Gate failures' };
  const MODEL_COLORS = ['var(--s-codex)', 'var(--s-pass)', 'var(--s-merge)', 'var(--warn)', 'var(--merged)', 'var(--dim)'];
  const METRICS = {
    cpuPct: { label: 'CPU', unit: '%', max: 100, icon: 'cpu' },
    load1: { label: 'Load (1 min)', unit: '', max: null, icon: 'gauge' },
    memPct: { label: 'Memory', unit: '%', max: 100, icon: 'memory' },
    workspacePct: { label: '/workspace disk', unit: '%', max: 100, thr: 85, icon: 'disk' },
    scratchPct: { label: '/scratch disk', unit: '%', max: 100, thr: 85, icon: 'disk' },
  };

  let S = null;
  let skew = 0;
  let lastFetchOk = 0;
  let fetchError = null;
  const prevNums = new Map();
  const ui = { batch: null, modal: [], evKind: '', evDay: null, evQ: '', evLimit: 120, filter: { q: '', batch: '', status: '' } };
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ DOM helpers
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
        else if ((k === 'fill' || k === 'stroke' || k === 'stop-color') && typeof v === 'string' && v.startsWith('var(')) el.style.setProperty(k, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const icon = (name, cls) => h('svg', { class: `ic ${cls || ''}`, 'aria-hidden': 'true' }, h('use', { href: `/static/icons.svg#i-${name}` }));
  const mount = (id, ...nodes) => { const el = typeof id === 'string' ? $(id) : id; el.replaceChildren(...nodes.flat(Infinity).filter(Boolean)); return el; };
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const nowSec = () => Date.now() / 1000 + skew;
  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pkt = (ts) => new Date(ts * 1000 + PKT_MS);
  const fmtHM = (ts) => { if (!isNum(ts)) return '-'; const d = pkt(ts); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fmtClock = (ts) => { if (!isNum(ts)) return '--:--:--'; const d = pkt(ts); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
  const fmtDT = (ts) => { if (!isNum(ts)) return '-'; const d = pkt(ts); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fmtFull = (ts) => (isNum(ts) ? `${fmtDT(ts)}:${pad(pkt(ts).getUTCSeconds())} PKT` : '-');
  const dayKey = (ts) => { const d = pkt(ts); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const dayLabel = (key) => { const d = new Date(`${key}T00:00:00Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  function fmtDur(sec) {
    if (!isNum(sec)) return '-';
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${pad(sec % 60)}s`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ${pad(Math.floor((sec % 3600) / 60))}m`;
    return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  }
  const ago = (ts) => (isNum(ts) ? (nowSec() - ts < 45 ? 'just now' : `${fmtDur(nowSec() - ts)} ago`) : 'never');
  const fmtNum = (v, d = 0) => (isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '-');
  const fmtGiB = (b) => (isNum(b) ? (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TiB` : `${(b / 1024 ** 3).toFixed(0)} GiB`) : '-');
  const pct = (a, b) => (b ? Math.max(0, Math.min(100, (100 * a) / b)) : 0);
  const batchById = (id) => (S ? S.batches.find((b) => b.id === id) : null);
  const batchName = (id) => { const b = batchById(id); return b ? (b.label || b.id) : (id || ''); };
  const ghLink = (kind, n) => (S && n ? `https://github.com/${S.repo}/${kind}/${encodeURIComponent(n)}` : null);
  const extLink = (kind, n, text) => h('a', { href: ghLink(kind, n), target: '_blank', rel: 'noopener noreferrer', class: 'tag' }, text, icon('arrow-up-right'));
  const sha = (s, n = 7) => (s ? h('span', { class: 'sha' }, String(s).slice(0, n)) : h('span', { class: 'meta' }, '-'));
  const activate = (fn) => ({ role: 'button', tabindex: 0, onclick: fn, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } } });
  const gateName = (k) => GATE_LABEL[k] || k;
  const widthOf = (el, fallback = 600) => Math.max(240, Math.round((el && el.clientWidth) || fallback));

  function countUp(key, value, decimals = 0) {
    const el = h('span', null, isNum(value) ? fmtNum(value, decimals) : '-');
    if (!isNum(value)) return el;
    const from = prevNums.has(key) ? prevNums.get(key) : 0;
    prevNums.set(key, value);
    if (reduceMotion || from === value) return el;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 1100);
      el.textContent = fmtNum(from + (value - from) * (1 - (1 - k) ** 4), decimals);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return el;
  }

  // tooltip
  const tip = () => $('tooltip');
  function showTip(evt, ...nodes) {
    const el = tip();
    el.replaceChildren(...nodes.flat().filter(Boolean));
    el.hidden = false;
    const r = el.getBoundingClientRect();
    let x = evt.clientX + 14; let y = evt.clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - 14;
    el.style.setProperty('left', `${x}px`);
    el.style.setProperty('top', `${y}px`);
  }
  const hideTip = () => { tip().hidden = true; };
  const tipAttrs = (fn) => ({ onmousemove: (e) => showTip(e, fn()), onmouseleave: hideTip });

  // ------------------------------------------------------------------ truth: what state is a task really in
  function failedGates(t) {
    const g = t.gates || {};
    const diffPass = (g.differential || {}).status === 'PASS';
    const out = [];
    for (const [k, v] of Object.entries(g)) {
      if (META_GATES.has(k) || !v) continue;
      if (v.status === 'FAIL' && !(k === 'complete_unit' && diffPass)) out.push(k);
    }
    if ((g.differential || {}).status === 'FAIL') out.push('differential');
    return out;
  }

  function statusOf(t) {
    if (t.verdict && t.verdict.key) return t.verdict;
    const g = t.gates || {};
    const fails = failedGates(t);
    const blocked = Object.entries(g).filter(([k, v]) => !META_GATES.has(k) && v && v.status === 'BLOCKED').map(([k]) => k);
    const onFinal = (g.final_sha || {}).status === 'PASS';
    const passed = !!t.gated && onFinal && !fails.length && !blocked.length;
    if (t.running) return { key: 'running', label: t.currentStep ? `Running ${gateName(t.currentStep)}` : 'Running' };
    if (fails.length) return { key: 'failed', label: `Failed: ${fails.map(gateName).join(', ')}`, gates: fails };
    if (blocked.length || t.phase === 'blocked') return { key: 'blocked', label: blocked.length ? `Blocked: ${blocked.map(gateName).join(', ')}` : 'Blocked', gates: blocked };
    if (passed && t.done) return { key: 'done', label: 'Done' };
    if (passed && t.merged) return { key: 'merged', label: 'Merged' };
    if (passed) return { key: 'passed', label: 'Passed on final SHA' };
    if (t.phase === 'failed') return { key: 'failed', label: t.failedGate ? `Failed: ${gateName(t.failedGate)}` : 'Failed: Codex', gates: t.failedGate ? [t.failedGate] : ['codex'] };
    if (t.phase === 'pending') return { key: 'queued', label: 'Queued' };
    if (t.fixed || (t.runs || []).some((r) => r.kind === 'codex' && r.codexExitCode === 0)) return { key: 'gates', label: 'Awaiting gates' };
    return { key: 'pending', label: 'Pending' };
  }
  function pill(st, extraCls) {
    const m = STATUS_META[st.key] || STATUS_META.pending;
    return h('span', { class: `pill s-${st.key} ${extraCls || ''}`, title: st.label }, icon(m.icon), st.label);
  }
  function stageOf(t, st) {
    if (st.key === 'queued' || st.key === 'pending') return 'codex';
    if (st.key === 'pending_qa' || st.key === 'rejected') return 'qa';
    const runs = t.runs || [];
    const last = runs[runs.length - 1] || {};
    if (st.key === 'running' && last.kind === 'codex' && !last.codexEnd) return 'codex';
    if (st.key === 'failed' && (st.gates || []).includes('codex')) return 'codex';
    const g = t.gates || {};
    const diffPass = (g.differential || {}).status === 'PASS';
    const reqOk = REQUIRED.every((k) => (g[k] || {}).status === 'PASS' || (k === 'complete_unit' && diffPass));
    if (!reqOk || (g.final_sha || {}).status !== 'PASS') return 'gates';
    const qa = ['qa_browser', 'security'].map((k) => (g[k] || {}).status);
    if (qa.includes('FAIL') || qa.includes('RUNNING') || qa.includes('BLOCKED')) return 'qa';
    if (!t.merged) return 'merge';
    if (!t.done) return 'close';
    return 'done';
  }

  // tasks with filter applied; uniq() keeps the latest occurrence of each issue
  function allTasks(opts = {}) {
    const out = [];
    for (const b of S.batches) {
      if (!opts.includeArchive && b.archived) continue;
      for (const t of b.tasks) out.push({ b, t, st: statusOf(t) });
    }
    return out;
  }
  function filterMatch(b, t, st, opts = {}) {
    const f = ui.filter;
    if (f.batch && b.id !== f.batch) return false;
    if (!opts.ignoreStatus && f.status && st.key !== f.status && !(f.status === 'merged' && st.key === 'done')) return false;
    if (f.q) {
      const hay = [t.issue, t.title, t.finalSHA, t.sourceSHA, t.model, t.merge && `#${t.merge.number}`, b.label].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }
  function uniq(list) {
    const best = new Map();
    for (const x of list) { const cur = best.get(x.t.issue); if (!cur || (x.t.last || 0) > (cur.t.last || 0)) best.set(x.t.issue, x); }
    return [...best.values()];
  }
  const scoped = (opts) => uniq(allTasks().filter(({ b, t, st }) => filterMatch(b, t, st, opts)));

  function classifyEvent(e) {
    if (e.kind === 'merge' || e.kind === 'issue') return 'merge';
    if (e.kind === 'codex') return 'codex';
    if (e.level === 'bad') return 'fail';
    if (['step', 'gates', 'review', 'baseline'].includes(e.kind) && e.level === 'ok') return 'pass';
    return null;
  }
  function perDay(days, pred) {
    const keys = [];
    for (let i = days - 1; i >= 0; i -= 1) keys.push(dayKey(nowSec() - i * 86400));
    const m = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const e of S.events || []) { const k = dayKey(e.ts); if (k in m && pred(e)) m[k] += 1; }
    return keys.map((k) => m[k]);
  }

  // ------------------------------------------------------------------ charts
  let gradSeq = 0;
  function sparkline(values, color = 'var(--text-2)', height = 28) {
    const n = values.length;
    const W = 160;
    const svg = h('svg', { class: 'spark', viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => isNum(v));
    if (pts.length < 2) return svg;
    const top = Math.max(...pts.map(([, v]) => v), 1e-9);
    const xy = pts.map(([i, v]) => [(i / (n - 1)) * W, height - 2 - (v / top) * (height - 6)]);
    const id = `sg${(gradSeq += 1)}`;
    svg.append(h('defs', null, h('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, h('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0.28 }), h('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0 }))),
      h('polygon', { class: 'sp-area', fill: `url(#${id})`, points: `${xy[0][0]},${height} ${xy.map((p) => p.join(',')).join(' ')} ${xy[xy.length - 1][0]},${height}` }),
      h('polyline', { class: 'sp-line', stroke: color, points: xy.map((p) => p.join(',')).join(' ') }));
    return svg;
  }

  function areaChart(rows, opts) {
    const { width = 560, height = 150, max = null, thr = null, color = 'var(--blue)', unit = '', label = '' } = opts || {};
    const pts = rows.filter(([t, v]) => isNum(t) && isNum(v));
    const L = 34; const R = 8; const T = 8; const B = 20;
    const svg = h('svg', { class: 'area', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${label} chart` });
    if (pts.length < 2) {
      svg.append(h('text', { class: 'a-lbl', x: width / 2, y: height / 2, 'text-anchor': 'middle' }, 'Collecting history. Check back in a few minutes.'));
      return h('div', { class: 'chart' }, svg);
    }
    const t0 = pts[0][0]; const t1 = pts[pts.length - 1][0];
    const top = Math.max(max ?? 0, thr ?? 0, ...pts.map((p) => p[1]), 1e-9) * (max ? 1 : 1.15);
    const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (width - L - R);
    const y = (v) => T + (1 - v / top) * (height - T - B);
    const id = `ag${(gradSeq += 1)}`;
    svg.append(h('defs', null, h('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, h('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0.32 }), h('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0 }))));
    for (let i = 0; i <= 3; i += 1) {
      const v = (top * i) / 3;
      svg.append(h('line', { class: 'a-grid', x1: L, x2: width - R, y1: y(v), y2: y(v) }),
        h('text', { class: 'a-lbl', x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, v >= 10 ? v.toFixed(0) : v.toFixed(1)));
    }
    const ticks = Math.max(2, Math.min(6, Math.floor(width / 110)));
    for (let i = 0; i <= ticks; i += 1) {
      const t = t0 + ((t1 - t0) * i) / ticks;
      svg.append(h('text', { class: 'a-lbl', x: x(t), y: height - 5, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }, t1 - t0 > 2 * 86400 ? fmtDT(t).split(',')[0] : fmtHM(t)));
    }
    const line = pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    svg.append(h('polygon', { fill: `url(#${id})`, points: `${x(t0)},${height - B} ${line} ${x(t1)},${height - B}` }),
      h('polyline', { class: 'a-line', stroke: color, points: line }));
    if (isNum(thr)) svg.append(h('line', { class: 'a-thr', x1: L, x2: width - R, y1: y(thr), y2: y(thr) }));
    const cross = h('line', { class: 'a-cross', y1: T, y2: height - B, visibility: 'hidden' });
    const dot = h('circle', { class: 'a-dot', r: 4, fill: color, visibility: 'hidden' });
    svg.append(cross, dot, h('rect', {
      x: L, y: T, width: width - L - R, height: height - T - B, fill: 'transparent',
      onmousemove: (e) => {
        const bx = svg.getBoundingClientRect();
        const px = ((e.clientX - bx.left) / bx.width) * width;
        let best = pts[0];
        for (const p of pts) if (Math.abs(x(p[0]) - px) < Math.abs(x(best[0]) - px)) best = p;
        cross.setAttribute('x1', x(best[0])); cross.setAttribute('x2', x(best[0])); cross.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', x(best[0])); dot.setAttribute('cy', y(best[1])); dot.setAttribute('visibility', 'visible');
        showTip(e, h('div', { class: 'tt-h' }, fmtFull(best[0])), h('div', { class: 'tt-row' }, h('span', null, label), h('b', null, `${best[1].toFixed(1)}${unit}`)));
      },
      onmouseleave: () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); },
    }));
    return h('div', { class: 'chart' }, svg);
  }

  function miniBars(values, labels, color, width) {
    const H = 44; const n = values.length; const w = width / n;
    const max = Math.max(1, ...values);
    const svg = h('svg', { width, height: H, viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': 'per day' });
    values.forEach((v, i) => {
      const bh = v ? Math.max(3, (v / max) * (H - 4)) : 2;
      svg.append(h('rect', { x: i * w + 1, y: H - bh, width: Math.max(1, w - 2), height: bh, rx: 2, fill: v ? color : 'var(--track)', ...tipAttrs(() => [h('div', { class: 'tt-h' }, dayLabel(labels[i])), h('b', null, `${v}`)]) }));
    });
    return svg;
  }

  function donut(entries, size = 84) {
    const total = entries.reduce((a, e) => a + e.value, 0);
    const r = size / 2 - 6;
    const svg = h('svg', { class: 'donut', viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'model split' },
      h('circle', { cx: size / 2, cy: size / 2, r, stroke: 'var(--track)' }));
    let off = 0;
    for (const e of entries) {
      const len = total ? (100 * e.value) / total : 0;
      const seg = Math.max(0, len - 1.2);
      svg.append(h('circle', { cx: size / 2, cy: size / 2, r, stroke: e.color, pathLength: 100, 'stroke-dasharray': `${seg} ${100 - seg}`, 'stroke-dashoffset': 25 - off, 'stroke-linecap': 'round' },
        h('title', null, `${e.label}: ${e.value}`)));
      off += len;
    }
    return svg;
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
    $('clock-date').textContent = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, PKT`;
    if (S) renderFreshness();
    const now = nowSec();
    for (const el of document.querySelectorAll('[data-since]')) el.textContent = fmtDur(now - Number(el.dataset.since));
  }
  const since = (ts) => (isNum(ts) ? h('span', { 'data-since': ts }, fmtDur(nowSec() - ts)) : h('span', null, '-'));

  // ------------------------------------------------------------------ render
  function render() {
    const safe = (fn) => { try { fn(); } catch (err) { console.error(fn.name, err); } };
    [renderFreshness, renderFilters, renderBanner, renderOverview, renderDevelop, renderProgress, renderPulse, renderKpiCards, renderSpend, renderRuns, renderPipeline, renderToday, renderInsights, renderLanes, renderCodex, renderGatesNow,
      renderNext, renderBatches, renderBatchDetail, renderActivity, renderMerges, renderEvents, renderWorker, renderAIStatus].forEach(safe);
    if (ui.modal.length && $('dlg').open) safe(renderModal);
  }

  function dataAsOfTs() {
    return (S && (S.dataAsOf || (S.freshness && S.freshness.dataAsOf) || (S.worker && S.worker.collectedAt))) || null;
  }
  function renderFreshness() {
    const el = $('freshness');
    const stamp = $('data-as-of');
    const asOf = S ? dataAsOfTs() : null;
    if (stamp) {
      stamp.textContent = `data as of ${fmtClock(asOf)} PKT`;
      stamp.title = asOf ? `Current-run data as of ${fmtFull(asOf)}` : 'No collector data yet';
      stamp.classList.toggle('stale', !!(S && ((S.freshness && S.freshness.stale) || Object.values(S.sources || {}).some((v) => v && v.stale))));
    }
    if (fetchError && (!S || nowSec() - lastFetchOk > 90)) { el.className = 'live-pill bad'; el.textContent = `Offline: ${fetchError}`; return; }
    if (!S) return;
    const stale = Object.entries(S.sources).filter(([, v]) => v.stale).map(([k]) => k);
    const ages = Object.values(S.sources).map((v) => v.receivedAt).filter(isNum);
    const newest = ages.length ? Math.max(...ages) : null;
    el.className = `live-pill ${stale.length ? 'warn' : 'ok'}`;
    el.textContent = stale.length ? `Stale: ${stale.join(', ')}` : `Live, ${ago(newest)}`;
    el.title = Object.entries(S.sources).map(([k, v]) => `${k}: ${v.receivedAt ? fmtFull(v.receivedAt) : 'never'}`).join('\n');
  }
  function renderFilters() {
    const sel = $('f-batch');
    const want = ['', ...S.batches.map((b) => b.id)].join('|');
    if (sel.dataset.ids !== want) {
      sel.replaceChildren(h('option', { value: '' }, 'All batches'), ...S.batches.map((b) => h('option', { value: b.id }, b.label || b.id)));
      sel.dataset.ids = want;
      sel.value = ui.filter.batch;
    }
    const base = uniq(allTasks().filter(({ b, t, st }) => filterMatch(b, t, st, { ignoreStatus: true })));
    const counts = {};
    for (const x of base) { counts[x.st.key] = (counts[x.st.key] || 0) + 1; }
    counts.merged = (counts.merged || 0) + (counts.done || 0);
    mount('f-status', FILTERS.map(([k, label]) => h('button', {
      type: 'button', class: ui.filter.status === k ? 'on' : '', role: 'radio', 'aria-checked': ui.filter.status === k ? 'true' : 'false',
      onclick: () => { ui.filter.status = k; render(); },
    }, label, h('span', { class: 'n' }, k ? counts[k] || 0 : base.length))));
    const shown = scoped().length;
    $('filter-meta').textContent = ui.filter.q || ui.filter.batch || ui.filter.status ? `${shown} of ${uniq(allTasks()).length} tasks` : '';
  }

  function renderBanner() {
    const alerts = [...(S.alerts || [])].sort((a, b) => (a.level === 'crit' ? 0 : 1) - (b.level === 'crit' ? 0 : 1));
    const staleSrc = Object.entries(S.sources || {}).filter(([, v]) => v && v.stale);
    const asOf = dataAsOfTs();
    const items = [];
    if (staleSrc.length) {
      const names = staleSrc.map(([k]) => k).join(' and ');
      const age = staleSrc[0][1].ageSec;
      const ageTxt = isNum(age) ? `${Math.floor(age / 60)} min old` : 'no data received';
      items.push(h('div', { class: 'banner-item warn stale-banner', role: 'alert' }, icon('warning'),
        `Collector has not updated for more than 3 minutes (${names} ${ageTxt}). Data as of ${fmtClock(asOf)} PKT — numbers may be frozen.`));
    }
    const crit = alerts.filter((a) => a.level === 'crit');
    const warn = alerts.filter((a) => a.level !== 'crit' && !String(a.id || a.key || '').startsWith('stale-'));
    items.push(...crit.map((a) => h('button', { type: 'button', class: 'banner-item', onclick: () => openModal('alert', a) }, icon('octagon'), a.message)));
    if (warn.length) {
      items.push(h('button', { type: 'button', class: 'banner-item warn', onclick: () => openModal('alert', warn[0]) }, icon('warning'), warn[0].message,
        warn.length > 1 ? h('span', { class: 'more' }, `+${warn.length - 1} more`) : null));
    }
    mount('banner', items);
  }


  function renderDevelop() {
    const el = $('develop-lane');
    if (!el) return;
    const d = S.develop || {};
    const gh = S.github || {};
    const sha = d.sha || gh.developSha;
    const short = d.short || (sha ? sha.slice(0, 8) : null);
    const prev = d.previousShort || (d.previousTip ? String(d.previousTip).slice(0, 8) : null);
    const at = d.mergedAt || gh.developMovedAt || gh.developAt;
    const gate = d.deployGate || gh.deployGate || {};
    const gateSt = String(gate.status || '').toUpperCase();
    const pending = !gateSt || gateSt === 'PENDING';
    if ($('develop-meta')) $('develop-meta').textContent = short ? `${short}${at ? ` · ${fmtClock(at)} PKT` : ''}` : 'No develop tip yet';
    mount(el,
      h('div', { class: 'develop-lane' },
        h('div', null,
          h('div', { class: 'dev-sha' }, short || 'unknown'),
          h('div', { class: 'meta' }, at
            ? `develop moved to ${short} at ${fmtClock(at)} PKT${d.method ? ` (${d.method}${prev ? ` from ${prev}` : ''})` : (prev ? ` from ${prev}` : '')}`
            : (short ? `develop tip ${short}` : 'Develop tip not reported yet'))),
        h('div', { class: 'dev-gate' },
          h('span', { class: `badge ${pending ? 'pending warn' : (gateSt === 'PASS' || gateSt === 'CLEAR' ? '' : 'bad')}`,
            title: gate.note || gate.check || '' },
            `Azure deploy gate: ${pending ? 'pending' : gateSt.toLowerCase()}`),
          gate.note ? h('div', { class: 'meta' }, gate.note) : null)));
  }

  function renderOverview() {
    const o = S.overview;
    const asOf = dataAsOfTs();
    const run = o.currentRun ? ` Current run ${o.currentRun}.` : '';
    const dev = (S.develop && S.develop.short) ? ` Develop ${S.develop.short}.` : '';
    $('overview-meta').textContent = `Monitoring Codex runs, machine gates, merges and cost. Data as of ${fmtClock(asOf)} PKT.${run}${dev} ${o.batches} batches, ${fmtNum(o.tasks)} tasks, ${fmtNum(o.codexJobsTotal)} current-run Codex jobs.`;
  }

  // ------------------------------------------------------------------ control room (OpsPulse-style top grid)
  const pctTxt = (v) => (isNum(v) ? `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%` : '-');
  function trendChip(cur, prev, goodWhenUp, neutral) {
    if (!isNum(cur) || !isNum(prev) || prev === 0) return null;
    const d = ((cur - prev) / Math.abs(prev)) * 100;
    if (Math.abs(d) < 0.5) return h('span', { class: 'trend flat' }, '0%');
    const up = d > 0;
    const good = neutral ? null : (up === goodWhenUp);
    return h('span', { class: `trend ${good === false ? 'down' : good === null ? 'flat' : ''}`, title: 'Change vs the previous period' }, icon(up ? 'trend-up' : 'trend-down'), `${Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0)}%`);
  }
  function quantile(arr, q) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))]; }
  function fmtShortDur(sec) { if (!isNum(sec)) return '-'; if (sec < 90) return `${Math.round(sec)}s`; if (sec < 5400) return `${Math.round(sec / 60)}m`; return `${(sec / 3600).toFixed(1)}h`; }

  // thin vertical micro-bars (OpsPulse KPI language); bars: [{v, c, t}] (value, colour, tooltip); hi: index labelled
  function microBars(bars, width, opts = {}) {
    const H = opts.height || 62; const n = Math.max(1, bars.length);
    const svg = h('svg', { class: 'mbars', width, height: H + 16, viewBox: `0 -16 ${width} ${H + 16}`, role: 'img', 'aria-label': opts.label || 'trend' });
    const step = width / n; const bw = Math.max(2, Math.min(opts.barWidth || 3, step * 0.55));
    const max = Math.max(1e-9, ...bars.map((b) => b.v || 0));
    bars.forEach((b, i) => {
      const x = i * step + (step - bw) / 2;
      const bh = b.v ? Math.max(3, (b.v / max) * H) : H * 0.42;
      if (b.dots) {
        // dotted column (latency style): a transparent hit area for the tooltip plus a stack of dots
        svg.append(h('rect', { x: i * step, y: 0, width: step, height: H, fill: 'transparent', ...(b.t ? tipAttrs(() => b.t) : {}) }));
        for (let k = 0; k < b.dots; k += 1) svg.append(h('circle', { cx: x + bw / 2, cy: H - 3 - k * 5, r: 1.7, fill: b.c, 'pointer-events': 'none' }));
        return;
      }
      const attrs = { x, y: H - bh, width: bw, height: bh, rx: bw / 2, fill: b.v ? (b.c || 'var(--green)') : 'var(--tick)' };
      if (b.t) Object.assign(attrs, tipAttrs(() => b.t));
      svg.append(h('rect', attrs));
    });
    if (isNum(opts.hi) && bars[opts.hi]) {
      const b = bars[opts.hi];
      const x = opts.hi * step + step / 2;
      const bh = b.v ? Math.max(3, (b.v / max) * H) : H * 0.42;
      svg.append(h('text', { class: 'lbl', x: Math.min(width - 14, Math.max(14, x)), y: H - bh - 6 }, opts.hiLabel || ''));
    }
    return svg;
  }

  function kpiCard(id, opts) {
    const el = $(id);
    const w = Math.max(160, el.clientWidth - 40);
    el.onclick = opts.onclick || null;
    mount(el,
      h('div', { class: 'kpi-top' }, h('span', null, opts.title), h('span', { class: 'dots', 'aria-hidden': 'true' }, icon('dots'))),
      h('div', { class: 'kpi-val' }, h('b', null, opts.prefix || '', isNum(opts.value) ? countUp(`kc-${id}`, opts.value, opts.decimals || 0) : (opts.value ?? '-')), opts.unit ? h('small', null, opts.unit) : null, opts.trend),
      h('div', { class: 'kpi-sub' }, opts.sub),
      microBars(opts.bars || [], w, { hi: opts.hi, hiLabel: opts.hiLabel, label: opts.title, barWidth: opts.barWidth }));
  }

  function renderProgress() {
    const list = scoped({ ignoreStatus: true });
    const total = list.length;
    const fixed = list.filter((x) => ['passed', 'merged', 'done'].includes(x.st.key)).length;
    const passed = list.filter((x) => ['passed', 'merged', 'done'].includes(x.st.key)).length;
    const merged = list.filter((x) => x.t.merged).length;
    const done = list.filter((x) => x.st.key === 'done').length;
    const p = total ? Math.round((100 * done) / total) : 0;
    $('progress-meta').textContent = `${total} tasks`;
    const row = (label, n, go) => h('button', { type: 'button', class: `check ${total && n === total ? 'done' : ''}`, onclick: go },
      icon(total && n === total ? 'check-circle' : 'circle'), label, h('span', { class: 'n' }, `${n}/${total}`));
    mount('progress', h('div', { class: 'meta' }, 'Tasks through the full pipeline: gated on the final SHA, merged and closed.'),
      h('div', { class: 'pc-bar' }, h('div', { class: 'track' }, h('i', { style: { width: `${p}%` } })), h('b', null, `${p}%`)),
      h('div', { class: 'well' },
        row('Real fixes (passed on final SHA)', fixed, () => openModal('list', { status: 'passed', title: 'Real fixes' })),
        row('Gates passed on final SHA', passed, () => openModal('list', { status: 'passed', title: 'Passed on final SHA' })),
        row('Merged into develop', merged, () => openModal('list', { status: 'merged', title: 'Merged into develop' })),
        row('Linear and GitHub closed', done, () => openModal('list', { status: 'done', title: 'Done' }))),
      h('div', { class: 'mini-stats two' }, [['running', 'Running', 'circle-notch'], ['failed', 'Failed', 'x-circle'], ['pending_qa', 'Pending QA', 'hourglass'], ['rejected', 'Rejected', 'prohibit'], ['queued', 'Queued', 'circle-dashed']].map(([k, label, ic]) => {
        const v = list.filter((x) => x.st.key === k || (k === 'queued' && x.st.key === 'pending')).length;
        return h('button', { type: 'button', class: `mini ${k === 'failed' && v ? 'bad' : ''}`, onclick: () => { ui.filter.status = k; render(); $('sec-batches').scrollIntoView({ behavior: 'smooth' }); } },
          h('span', null, icon(ic), label), h('b', null, countUp(`pm-${k}`, v)));
      })));
  }

  function renderPulse() {
    const list = scoped({ ignoreStatus: true });
    const passed = list.filter((x) => ['passed', 'merged', 'done'].includes(x.st.key)).length;
    const failed = list.filter((x) => x.st.key === 'failed').length;
    const blocked = list.filter((x) => x.st.key === 'blocked').length;
    const denom = passed + failed + blocked;
    const rate = denom ? (100 * passed) / denom : null;
    $('pulse-meta').textContent = `${denom} judged`;
    // segmented arc: passed, failed, blocked (gaps between segments, round caps)
    const segs = [[passed, 'var(--green)'], [failed, 'var(--crit)'], [blocked, 'var(--orange)']].filter((x) => x[0] > 0);
    const arc = 'M 22 112 A 88 88 0 0 1 198 112';
    const svg = h('svg', { viewBox: '0 0 220 124', role: 'img', 'aria-label': `Gate pass rate ${pctTxt(rate)}` },
      h('path', { d: arc, fill: 'none', stroke: 'var(--track)', 'stroke-width': 20, 'stroke-linecap': 'round', pathLength: 100 }));
    const gap = segs.length > 1 ? 6 : 0;
    let off = 0;
    for (const [v, c] of segs) {
      const len = Math.max(0, (100 * v) / Math.max(1, denom) - gap);
      svg.append(h('path', { d: arc, fill: 'none', stroke: c, 'stroke-width': 20, 'stroke-linecap': 'round', pathLength: 100, 'stroke-dasharray': `${len} 200`, 'stroke-dashoffset': -off },
        h('title', null, `${v} tasks`)));
      off += len + gap;
    }
    const tasksWith = (pred) => list.filter((x) => pred(x.t.gates || {}));
    const gateState = (k) => { const s = list.map((x) => ((x.t.gates || {})[k] || {}).status); return s.includes('FAIL') ? 'fail' : s.includes('PASS') ? 'pass' : 'none'; };
    const diffFail = tasksWith((g) => (g.differential || {}).status === 'FAIL').length;
    const ks = S.worker.killSwitch || {};
    const guardFlags = allInsights().filter((x) => /^rule:(guards|tests-drop):/.test(x.key) && (!ui.filter.batch || x.batch === ui.filter.batch)).length;
    const pol = (label, cls, text, go) => h('button', { type: 'button', class: 'policy', onclick: go }, h('span', null, label), h('span', { class: `badge ${cls}` }, text));
    const sec = gateState('security'); const qa = gateState('qa_browser');
    mount('pulse',
      h('div', { class: 'pulse-gauge' }, svg, h('div', { class: 'pulse-center' }, h('div', { class: 'lbl' }, 'Gate pass rate'), h('div', { class: 'val' }, pctTxt(rate)))),
      h('div', { class: 'well' },
        pol('Required gates on final SHA', failed ? 'bad' : passed ? '' : 'idle', failed ? `${failed} failing` : `${passed} passing`, () => openModal('list', { status: failed ? 'failed' : 'passed', title: failed ? 'Failed' : 'Passed on final SHA' })),
        pol('Differential vs baseline', diffFail ? 'bad' : '', diffFail ? `${diffFail} with new failures` : 'Clean', () => openModal('list', { status: 'failed', title: 'Failed' })),
        pol('Security gate', sec === 'fail' ? 'bad' : sec === 'pass' ? '' : 'idle', sec === 'fail' ? 'Failing' : sec === 'pass' ? 'Passing' : 'Not run', () => openModal('list', { status: 'failed', title: 'Failed' })),
        pol('QA / browser', qa === 'fail' ? 'bad' : qa === 'pass' ? '' : 'idle', qa === 'fail' ? 'Failing' : qa === 'pass' ? 'Passing' : 'Not run', () => openModal('list', { status: 'failed', title: 'Failed' })),
        pol('Tests and guards', guardFlags ? 'warn' : '', guardFlags ? `${guardFlags} flagged` : 'Untouched', () => $('sec-attention').scrollIntoView({ behavior: 'smooth' })),
        pol('Egress kill-switch', ks.pass === true ? '' : ks.pass === false ? 'bad' : 'idle', ks.pass === true ? 'Active' : ks.pass === false ? 'FAIL' : 'Unknown', () => openModal('killswitch', {}))));
  }

  function renderKpiCards() {
    const now = nowSec();
    const ev = S.events || [];
    const inScope = (e) => !ui.filter.batch || !e.batch || e.batch === ui.filter.batch;
    // 1. Codex jobs: starts per hour, last 24 h
    const starts = ev.filter((e) => inScope(e) && e.kind === 'codex' && /started/i.test(e.text));
    const fails = ev.filter((e) => inScope(e) && e.kind === 'codex' && e.level === 'bad');
    const hours = [];
    for (let i = 23; i >= 0; i -= 1) {
      const t0 = now - (i + 1) * 3600; const t1 = now - i * 3600;
      const v = starts.filter((e) => e.ts >= t0 && e.ts < t1).length;
      const f = fails.filter((e) => e.ts >= t0 && e.ts < t1).length;
      hours.push({ v, c: f ? 'var(--crit)' : 'var(--green)', t: [h('div', { class: 'tt-h' }, `${fmtHM(t0)} to ${fmtHM(t1)}`), h('div', null, `${v} Codex starts${f ? `, ${f} failed` : ''}`)] });
    }
    const last24 = starts.filter((e) => e.ts >= now - 86400).length;
    const prev24 = starts.filter((e) => e.ts < now - 86400 && e.ts >= now - 172800).length;
    const hiC = hours.reduce((m, b, i) => (b.v > hours[m].v ? i : m), 0);
    const c = S.codex || {};
    kpiCard('kpi-1', { title: 'Codex jobs', value: S.overview.codexJobsTotal, trend: trendChip(last24, prev24, true, true),
      sub: `${c.activeCount ?? 0} running of ${c.cap || 50} slots. ${last24} started in 24 h`, bars: hours, hi: hours[hiC].v ? hiC : null, hiLabel: `${hours[hiC].v}/h`, onclick: () => $('sec-live').scrollIntoView({ behavior: 'smooth' }) });
    // 2. Spend: daily cost
    const daily = ((S.box.machine || {}).daily || []).slice(-30);
    const costBars = daily.map((d) => ({ v: d.costUsd, c: 'var(--green)', t: [h('div', { class: 'tt-h' }, dayLabel(d.day)), h('div', null, `$${fmtNum(d.costUsd, 2)}, ${fmtNum(d.hours, 1)} machine hours`)] }));
    const wk = daily.slice(-7).reduce((a, d) => a + d.costUsd, 0); const pwk = daily.slice(-14, -7).reduce((a, d) => a + d.costUsd, 0);
    kpiCard('kpi-2', { title: 'Spend', prefix: '$', value: S.overview.machineCostUsd, decimals: 0, trend: daily.length >= 14 ? trendChip(wk, pwk, false, true) : null,
      sub: daily.length ? `$${fmtNum(wk, 0)} in the last 7 days` : 'Daily cost appears after the ops-box collector update', bars: costBars, hi: costBars.length ? costBars.length - 1 : null,
      hiLabel: daily.length ? `$${fmtNum(daily[daily.length - 1].costUsd, 0)}` : '', onclick: () => openModal('workers', {}) });
    // 3. Gate pass rate: step results per day, 14 days (green passes, red failures)
    const steps = ev.filter((e) => inScope(e) && e.kind === 'step' && (e.level === 'ok' || e.level === 'bad'));
    const rateOf = (a, b) => { const xs = steps.filter((e) => e.ts >= a && e.ts < b); const p = xs.filter((e) => e.level === 'ok').length; return xs.length ? { r: (100 * p) / xs.length, p, f: xs.length - p } : null; };
    const r7 = rateOf(now - 7 * 86400, now + 1); const rp = rateOf(now - 14 * 86400, now - 7 * 86400);
    const dayBarsArr = [];
    for (let i = 13; i >= 0; i -= 1) {
      const t0 = now - (i + 1) * 86400; const t1 = now - i * 86400; const r = rateOf(t0, t1);
      dayBarsArr.push({ v: r ? r.r : 0, c: r && r.f ? 'var(--crit)' : 'var(--green)', t: [h('div', { class: 'tt-h' }, dayLabel(dayKey(t1 - 1))), h('div', null, r ? `${pctTxt(r.r)} passed (${r.p} passed, ${r.f} failed)` : 'No gate results')] });
    }
    kpiCard('kpi-3', { title: 'Gate pass rate', value: r7 ? pctTxt(r7.r) : '-', trend: r7 && rp ? trendChip(r7.r, rp.r, true) : null,
      sub: r7 ? `${r7.p} passed, ${r7.f} failed step results in 7 days` : 'No gate results in 7 days', bars: dayBarsArr, hi: dayBarsArr.length - 1, hiLabel: r7 ? pctTxt(dayBarsArr[dayBarsArr.length - 1].v) : '',
      onclick: () => openModal('list', { status: 'failed', title: 'Failed' }) });
    // 4. P95 gate time: step durations, dotted columns coloured by result
    const durs = [];
    for (const { b, t } of allTasks()) {
      if (ui.filter.batch && b.id !== ui.filter.batch) continue;
      for (const r of t.runs || []) for (const s of r.steps || []) if (isNum(s.start) && isNum(s.end)) durs.push({ d: s.end - s.start, end: s.end, st: s.status, name: s.name, issue: t.issue });
    }
    durs.sort((a, b2) => a.end - b2.end);
    const d24 = durs.filter((x) => x.end >= now - 86400).map((x) => x.d); const dPrev = durs.filter((x) => x.end < now - 86400 && x.end >= now - 172800).map((x) => x.d);
    const all = durs.map((x) => x.d);
    const p95 = quantile(d24.length ? d24 : all, 0.95); const p95p = quantile(dPrev, 0.95);
    const recent = durs.slice(-40);
    const maxD = Math.max(1, ...recent.map((x) => x.d));
    const latBars = recent.map((x) => ({ v: 0, dots: Math.max(1, Math.round((x.d / maxD) * 11)), c: x.st === 'FAIL' ? 'var(--crit)' : x.d >= (p95 || Infinity) ? 'var(--warn)' : 'var(--green)',
      t: [h('div', { class: 'tt-h' }, `${x.issue} ${x.name}`), h('div', null, `${fmtDur(x.d)}, ${x.st.toLowerCase()}`)] }));
    kpiCard('kpi-4', { title: 'P95 gate step time', value: fmtShortDur(p95), trend: isNum(p95) && isNum(p95p) ? trendChip(p95, p95p, false) : null,
      sub: `${durs.length} timed gate steps. Median ${fmtShortDur(quantile(all, 0.5))}`, bars: latBars, barWidth: 3.2 });
  }

  function renderSpend() {
    const o = S.overview;
    const daily = ((S.box.machine || {}).daily || []);
    const last7 = daily.slice(-7);
    const avg = last7.length ? last7.reduce((a, d) => a + d.costUsd, 0) / last7.length : null;
    const proj = isNum(avg) ? avg * 30 : null;
    const wk = last7.reduce((a, d) => a + d.costUsd, 0); const pwk = daily.slice(-14, -7).reduce((a, d) => a + d.costUsd, 0);
    const c = S.codex || {};
    const cap = c.cap || 50; const running = Math.min(cap, c.activeCount ?? (c.active || []).length);
    const queued = scoped({ ignoreStatus: true }).filter((x) => ['queued', 'pending'].includes(x.st.key)).length;
    const free = Math.max(0, cap - running);
    const u = S.worker.usage || {};
    const up = u.weeklyPct;
    const uCls = u.stopActive || (isNum(up) && up >= S.limits.usageStop) ? 'bad' : isNum(up) && up >= 80 ? '' : 'ok';
    const part = (cls, n, pctLabel, count, grow) => h('div', { class: `seg-part ${cls}`, style: { 'flex-grow': String(Math.max(grow, 0.0001)), 'flex-basis': '0' } },
      h('span', { class: 'pctl' }, pctLabel), Array.from({ length: Math.max(1, count) }, () => h('i')));
    mount('spend',
      h('div', { class: 'card-head' }, h('h3', null, '30-day spend forecast'), h('span', { class: 'meta' }, `Spot cap $${S.limits.spotCap.toFixed(2)}/h`)),
      h('div', { class: 'spend-top' },
        h('div', null, h('div', { class: 'big-money' }, isNum(proj) ? ['$', countUp('proj', proj, 0)] : (isNum(o.machineCostUsd) ? ['$', countUp('spend', o.machineCostUsd, 0)] : '-')),
          h('div', { class: 'kpi-val' }, daily.length >= 14 ? trendChip(wk, pwk, false, true) : null,
            h('span', { class: 'meta' }, isNum(proj) ? `Projected spend for the next 30 days at the last 7-day rate. $${fmtNum(o.machineCostUsd, 0)} spent so far` : `$${fmtNum(o.machineCostUsd, 2)} spent so far. Projection needs daily cost data`)))),
      h('div', { class: 'capbar', role: 'img', 'aria-label': `Codex slots: ${free} free, ${running} running, ${queued} queued` },
        part('ticks', free, `${Math.round((100 * free) / cap)}%`, Math.min(free, 40), free),
        running ? part('solid', running, `${Math.round((100 * running) / cap)}%`, 1, running) : null,
        queued ? part('blocks', queued, `${queued} queued`, Math.min(queued, 8), Math.max(queued, cap * 0.12)) : null),
      h('div', { class: 'cap-legend' }, h('span', null, h('i', { style: { background: 'var(--blue)' } }), `Free Codex slots ${free}`),
        h('span', null, h('i', { style: { background: 'var(--orange)' } }), `Running ${running}`), h('span', null, h('i', { style: { background: 'var(--green)' } }), `Queued ${queued}`)),
      h('div', { class: `confidence ${uCls}`, ...activate(() => openModal('usage', {})) }, icon(uCls === 'ok' ? 'check-circle' : 'warning'),
        h('span', null, `Weekly usage${u.stopActive ? ', stop marker ACTIVE' : `, stop line ${S.limits.usageStop}%`}`), h('b', null, isNum(up) ? `${Math.round(up)}%` : 'Unknown')));
  }

  function renderRuns() {
    const now = nowSec();
    const rows = [];
    for (const { b, t } of allTasks()) {
      if (ui.filter.batch && b.id !== ui.filter.batch) continue;
      if (ui.filter.q && !`${t.issue} ${t.title || ''}`.toLowerCase().includes(ui.filter.q)) continue;
      for (const r of t.runs || []) {
        const start = r.codexStart ?? r.start;
        if (!isNum(start)) continue;
        const live = r.norm === 'RUNNING' || (/RUNNING|VERIFYING/i.test(r.status || '') && !r.stale);
        const end = r.end ?? (live ? now : r.last);
        const ok = r.kind === 'codex' ? r.codexExitCode === 0 : r.norm === 'PASS' || (r.steps || []).length && (r.steps || []).every((s) => s.status === 'PASS');
        const failSteps = (r.steps || []).filter((s) => s.status === 'FAIL');
        const diffPass = ((t.gates || {}).differential || {}).status === 'PASS';
        const baselineOnly = failSteps.length > 0 && diffPass && failSteps.every((s) => s.gate === 'complete_unit');
        const failedRun = !baselineOnly && (r.norm === 'FAIL' || (r.kind === 'codex' && isNum(r.codexExitCode) && r.codexExitCode !== 0) || failSteps.length > 0);
        const st = live ? ['run', 'Live'] : failedRun ? ['bad', `Failed${failSteps.length ? `: ${failSteps.map((x) => gateName(x.gate)).join(', ')}` : ''}`]
          : baselineOnly ? ['warn', 'Baseline fails'] : r.norm === 'BLOCKED' ? ['warn', 'Blocked'] : ok ? ['', 'Passed'] : ['idle', 'Ended'];
        rows.push({ b, t, r, start, last: Math.max(r.last || 0, end || 0), dur: isNum(end) ? end - start : null, st, live });
      }
    }
    rows.sort((a, c) => (c.live - a.live) || (c.last - a.last));
    const shown = rows.slice(0, 50);
    $('runs-meta').textContent = `Last ${Math.min(50, rows.length)}`;
    mount('runs', shown.length ? h('div', { class: 'runs-wrap' }, h('table', { class: 'runs-table' },
      h('thead', null, h('tr', null, ['Name', 'Run', 'Time', 'Duration', 'Status'].map((x) => h('th', null, x)))),
      h('tbody', null, shown.map((x) => h('tr', { ...activate(() => openModal('task', { batch: x.b.id, issue: x.t.issue })) },
        h('td', { class: 'nm', title: x.t.title || '' }, h('b', null, x.t.issue), x.t.title ? h('span', null, ` ${x.t.title}`) : null),
        h('td', { class: 'meta' }, `${x.r.kind} ${x.r.run}`),
        h('td', null, ago(x.start)),
        h('td', null, x.live ? since(x.start) : fmtShortDur(x.dur)),
        h('td', null, h('span', { class: `badge ${x.st[0]}` }, x.st[1]))))))) : h('div', { class: 'empty' }, 'No runs yet'));
  }

  function renderPipeline() {
    const list = scoped({ ignoreStatus: true });
    const STAGES = [['codex', 'Codex', 'robot', 'Coding the fix'], ['gates', 'Gates', 'flask', 'Required gates, final SHA'], ['qa', 'QA & security', 'shield', 'Browser and security'],
      ['merge', 'Merge', 'merge', 'Into develop'], ['close', 'Close', 'kanban', 'Linear and GitHub'], ['done', 'Done', 'check-circle', 'All checks complete']];
    const at = Object.fromEntries(STAGES.map(([k]) => [k, []]));
    for (const x of list) at[stageOf(x.t, x.st)].push(x);
    const order = STAGES.map(([k]) => k);
    mount('pipeline', STAGES.map(([k, name, ic, sub], i) => {
      const xs = at[k];
      const running = xs.filter((x) => x.st.key === 'running').length;
      const failed = xs.filter((x) => x.st.key === 'failed').length;
      const blocked = xs.filter((x) => x.st.key === 'blocked').length;
      const queued = xs.filter((x) => ['queued', 'pending'].includes(x.st.key)).length;
      const beyond = list.filter((x) => order.indexOf(stageOf(x.t, x.st)) > i).length;
      const parts = [[running, 'var(--run)'], [failed, 'var(--crit)'], [blocked, 'var(--warn)'], [xs.length - running - failed - blocked, 'var(--pend)']].filter((p) => p[0] > 0);
      return h('button', { type: 'button', class: `stage ${running ? 'live' : ''} ${failed ? 'has-fail' : ''}`, onclick: () => openModal('list', { pipeline: k, title: `${name}: tasks at this stage` }) },
        i < STAGES.length - 1 ? h('span', { class: `wire ${running ? 'flow' : ''}`, 'aria-hidden': 'true' }) : null,
        h('div', { class: 'stage-top' }, h('span', { class: 'node' }, icon(ic)), h('div', null, h('div', { class: 'stage-name' }, name), h('div', { class: 'stage-sub' }, sub))),
        h('div', { class: 'stage-count', title: k === 'done' ? `${xs.length} tasks done` : `${xs.length} tasks at this stage, ${beyond} further along` }, countUp(`p-${k}`, xs.length), h('small', null, xs.length === 1 ? 'task' : 'tasks')),
        h('div', { class: 'stage-bar' }, parts.map(([v, c]) => h('i', { style: { 'flex-grow': String(v), background: c } }))),
        h('div', { class: 'stage-chips' },
          running ? h('span', { class: 'pill s-running' }, icon('circle-notch'), `${running} running`) : null,
          failed ? h('span', { class: 'pill s-failed' }, icon('x-circle'), `${failed} failed`) : null,
          blocked ? h('span', { class: 'pill s-blocked' }, icon('prohibit'), `${blocked} blocked`) : null,
          queued ? h('span', { class: 'pill s-queued' }, icon('circle-dashed'), `${queued} queued`) : null,
          xs.filter((x) => x.st.key === 'pending_qa').length ? h('span', { class: 'pill s-pending_qa' }, icon('hourglass'), `${xs.filter((x) => x.st.key === 'pending_qa').length} pending QA`) : null,
          xs.filter((x) => x.st.key === 'rejected').length ? h('span', { class: 'pill s-rejected' }, icon('prohibit'), `${xs.filter((x) => x.st.key === 'rejected').length} rejected`) : null));
    }));
  }

  function renderToday() {
    const today = dayKey(nowSec());
    const ev = (S.events || []).filter((e) => dayKey(e.ts) === today && (!ui.filter.batch || !e.batch || e.batch === ui.filter.batch));
    const n = (f) => ev.filter(f).length;
    const tile = (ic, label, v, cls) => h('div', { class: `mini ${cls || ''}` }, h('span', null, icon(ic), label), h('b', null, countUp(`today-${label}`, v)));
    mount('today', h('div', { class: 'mini-head' }, `Today, ${dayLabel(today)}`),
      h('div', { class: 'mini-stats' },
        tile('robot', 'Codex finished', n((e) => e.kind === 'codex' && /finished/i.test(e.text))),
        tile('check-circle', 'Gate passes', n((e) => classifyEvent(e) === 'pass')),
        tile('x-circle', 'Gate failures', n((e) => classifyEvent(e) === 'fail'), n((e) => classifyEvent(e) === 'fail') ? 'bad' : ''),
        tile('merge', 'Merges', n((e) => e.kind === 'merge'))));
  }

  // ------------------------------------------------------------------ insights and toasts
  const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
  function hashStr(s) { let x = 0; for (let i = 0; i < s.length; i += 1) x = ((x << 5) - x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36); }
  function allInsights() {
    const ins = S.insights || {};
    const ai = ins.ai || {};
    const list = [...(ins.rules || []), ...(ai.warnings || []).map((x) => ({ ...x, kind: 'warning' })), ...(ai.suggestions || []).map((x) => ({ ...x, kind: 'suggestion' }))];
    list.forEach((x) => { x.key = x.id || `ai:${x.kind}:${hashStr(`${x.title}|${x.issue || ''}|${x.batch || ''}`)}`; });
    return list.sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3) || (a.kind === 'warning' ? -1 : 1));
  }
  const SEV_ICON = { crit: 'octagon', warn: 'warning', info: 'info' };
  function insightCard(x, compact) {
    const ev = (x.evidence || []).map((e) => { const href = safeHref(e.link); return href ? h('a', { class: 'tag', href, onclick: (ev2) => ev2.stopPropagation() }, icon('link'), e.label) : null; });
    return h('div', { class: `ins sev-${x.severity}`, ...activate(() => openModal('insight', { key: x.key })) },
      icon(SEV_ICON[x.severity] || 'info', 'sev-ic'),
      h('div', null, h('div', { class: 'i-title' }, x.title), h('div', { class: 'i-reason' }, x.reason), ev.length ? h('div', { class: 'i-ev' }, compact ? ev.slice(0, 3) : ev) : null),
      h('span', { class: `src ${x.source === 'ai' ? 'ai' : ''}` }, x.source === 'ai' ? [icon('sparkle'), 'Claude'] : 'Rule'));
  }
  function renderInsights() {
    const list = allInsights().filter((x) => !ui.filter.batch || !x.batch || x.batch === ui.filter.batch);
    const ai = (S.insights || {}).ai;
    const st = S.ai || {};
    const warnings = list.filter((x) => x.kind === 'warning');
    const sugg = list.filter((x) => x.kind === 'suggestion');
    $('attn-label').textContent = warnings.length ? `Needs attention (${warnings.length})` : 'Needs attention';
    $('insights-meta').textContent = `${warnings.length} warnings, ${sugg.length} suggestions${ai && ai.generatedAt ? `. Claude analysed ${ago(ai.generatedAt)}` : st.enabled ? '. Claude analysis pending' : ''}`;
    $('ai-refresh').classList.toggle('hidden', !st.enabled);
    mount('insights',
      ai && ai.summary ? h('div', { class: 'ai-summary' }, icon('sparkle'), h('div', null, h('div', { class: 'meta' }, `Claude summary, ${fmtDT(ai.generatedAt)} PKT`), h('div', null, markdown(ai.summary)))) : null,
      !list.length ? h('div', { class: 'empty-ok' }, icon('check-circle'), 'Nothing needs attention right now.') : h('div', { class: 'ins-grid' },
        h('div', { class: 'ins-col' }, h('h3', null, `Warnings (${warnings.length})`), warnings.length ? h('div', { class: 'ins-list' }, warnings.slice(0, 8).map((x) => insightCard(x))) : h('div', { class: 'empty-ok' }, icon('check-circle'), 'No warnings')),
        h('div', { class: 'ins-col' }, h('h3', null, `Suggestions (${sugg.length})`), sugg.length ? h('div', { class: 'ins-list' }, sugg.slice(0, 8).map((x) => insightCard(x))) : h('div', { class: 'empty-ok' }, icon('check-circle'), 'No suggestions'))));
    toastNew(list.filter((x) => x.severity !== 'info' && x.kind === 'warning'));
  }
  const seen = (() => { try { return new Set(JSON.parse(sessionStorage.getItem('ops-seen') || '[]')); } catch (e) { return new Set(); } })();
  let toastsPrimed = false;
  function toastNew(items) {
    // first load: what is already on screen is not "new"; only critical findings get a toast
    if (!toastsPrimed) { for (const x of items) if (x.severity !== 'crit') seen.add(x.key); toastsPrimed = true; }
    const room = Math.max(0, 3 - $('toasts').children.length);
    const fresh = items.filter((x) => !seen.has(x.key)).slice(0, room);
    for (const x of fresh) {
      seen.add(x.key);
      let t = null;
      const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 300); };
      const ic = icon(SEV_ICON[x.severity], 'sev-ic');
      ic.style.setProperty('color', x.severity === 'crit' ? 'var(--crit-ink)' : 'var(--warn)');
      t = h('div', { class: 'toast', ...activate(() => { openModal('insight', { key: x.key }); dismiss(); }) },
        ic, h('div', null, h('div', { class: 't1' }, x.title), h('div', { class: 't2' }, x.reason)),
        h('button', { class: 'btn btn-icon btn-ghost toast-x', type: 'button', 'aria-label': 'Dismiss', onclick: (e) => { e.stopPropagation(); dismiss(); } }, icon('x')));
      $('toasts').append(t);
      setTimeout(dismiss, 9000);
    }
    try { sessionStorage.setItem('ops-seen', JSON.stringify([...seen].slice(-300))); } catch (e) { /* storage unavailable */ }
  }

  // ------------------------------------------------------------------ live swimlanes: past 12h, now, next
  function renderLanes() {
    const host = $('lanes');
    const W = widthOf(host, 1000);
    const now = nowSec();
    const past = 12 * 3600;
    const L = 108; const R = 10; const TOP = 26; const ROW = 40;
    const lanes = ['Codex', 'Gates', 'Merge & close'];
    const H = TOP + lanes.length * ROW + 6;
    const nowX = L + (W - L - R) * 0.8;
    const x = (t) => L + ((t - (now - past)) / past) * (nowX - L);
    const laneY = (i) => TOP + i * ROW;
    const svg = h('svg', { class: 'lanes-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity in the past 12 hours, running now and queued next' },
      h('defs', null, h('pattern', { id: 'future-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, h('line', { class: 'ln-hatch', x1: 0, y1: 0, x2: 0, y2: 6 }))));
    lanes.forEach((name, i) => {
      svg.append(h('rect', { class: 'ln-row', x: L, y: laneY(i) + 4, width: W - L - R, height: ROW - 8, rx: 8 }),
        h('text', { class: 'ln-label', x: 0, y: laneY(i) + ROW / 2 + 4 }, name));
    });
    svg.append(h('rect', { class: 'ln-future', x: nowX, y: TOP, width: W - R - nowX, height: lanes.length * ROW, rx: 8 }));
    for (let hh = 0; hh <= 12; hh += 2) {
      const t = now - past + hh * 3600;
      const tx = x(t);
      svg.append(h('line', { class: 'ln-grid', x1: tx, x2: tx, y1: TOP, y2: H - 6 }));
      if (hh < 12) svg.append(h('text', { class: 'ln-tick', x: tx, y: 14, 'text-anchor': hh === 0 ? 'start' : 'middle' }, fmtHM(t)));
    }
    svg.append(h('line', { class: 'ln-now', x1: nowX, x2: nowX, y1: 18, y2: H - 4 }), h('text', { class: 'ln-now-lbl', x: nowX, y: 14, 'text-anchor': 'middle' }, `Now ${fmtHM(now)}`));
    svg.append(h('text', { class: 'ln-tick', x: W - R, y: 14, 'text-anchor': 'end' }, 'Next'));

    const inScope = (bid) => !ui.filter.batch || !bid || bid === ui.filter.batch;
    const laneOf = (e) => (e.kind === 'codex' ? 0 : (e.kind === 'merge' || e.kind === 'issue') ? 2 : ['step', 'gates', 'review', 'baseline', 'state'].includes(e.kind) ? 1 : -1);
    const colorOf = (e) => (e.level === 'bad' ? 'var(--crit)' : e.kind === 'merge' ? 'var(--merged)' : e.kind === 'issue' ? 'var(--s-pass)' : e.kind === 'codex' ? 'var(--run)' : e.level === 'ok' ? 'var(--good)' : 'var(--dim)');
    const evs = (S.events || []).filter((e) => e.ts >= now - past && e.ts <= now && laneOf(e) >= 0 && inScope(e.batch)).slice(0, 500);
    evs.forEach((e, idx) => {
      const li = laneOf(e);
      const jitter = ((idx * 7) % 5) - 2;
      svg.append(h('circle', { class: 'mk', cx: x(e.ts), cy: laneY(li) + ROW / 2 + jitter * 3, r: e.kind === 'merge' ? 5 : 3.5, class: 'mk mk-ring', fill: colorOf(e),
        onclick: () => openEvent(e), ...tipAttrs(() => [h('div', { class: 'tt-h' }, `${fmtHM(e.ts)} PKT`), h('div', null, e.issue ? h('b', null, `${e.issue} `) : null, e.text), e.batch ? h('div', { class: 'meta' }, batchName(e.batch)) : null]) }));
    });
    const spans = [
      ...((S.codex || {}).active || []).filter((j) => inScope(j.batch)).map((j) => ({ lane: 0, start: j.start, label: `${j.issue} ${j.status || ''}`, sub: `${j.model || ''}${j.step ? `, step ${j.step}` : ''}`, go: () => openModal('task', { batch: j.batch, issue: j.issue }) })),
      ...((S.now || {}).gates || []).filter((g) => inScope(g.batch)).map((g) => ({ lane: 1, start: g.start, label: `${g.issue} ${g.step || g.kind}`, sub: `${g.run}, ${g.done} of ${g.total} steps`, go: () => openModal('task', { batch: g.batch, issue: g.issue }) })),
    ];
    const perLane = [0, 0, 0];
    for (const sp of spans) {
      const k = perLane[sp.lane]++;
      if (k > 5) continue;
      const sx = Math.max(L, x(isNum(sp.start) ? sp.start : now - 600));
      const sy = laneY(sp.lane) + 8 + k * 4.5;
      svg.append(h('rect', { class: 'span-glow', x: sx, y: sy, width: Math.max(3, nowX - sx), height: 3.5, rx: 2 }),
        h('rect', { class: 'span-run mk', x: sx, y: sy, width: Math.max(3, nowX - sx), height: 3.5, rx: 2, onclick: sp.go,
          ...tipAttrs(() => [h('div', { class: 'tt-h' }, 'Running now'), h('b', null, sp.label), h('div', { class: 'meta' }, `${sp.sub}. For ${fmtDur(now - (sp.start || now))}`)]) }));
    }
    const scopedT = scoped({ ignoreStatus: true });
    const queued = scopedT.filter((x2) => ['queued', 'pending'].includes(x2.st.key));
    const awaiting = scopedT.filter((x2) => x2.st.key === 'gates');
    const readyMerge = scopedT.filter((x2) => ['passed', 'merged'].includes(x2.st.key));
    const fw = W - R - nowX;
    [[0, queued, 'queued'], [1, awaiting, 'awaiting gates'], [2, readyMerge, 'to merge or close']].forEach(([li, xs, word]) => {
      const cy = laneY(li) + ROW / 2;
      const n = Math.min(xs.length, Math.max(0, Math.floor((fw - 110) / 14)));
      for (let k = 0; k < n; k += 1) {
        const it = xs[k];
        svg.append(h('rect', { class: 'ghost mk', x: nowX + 10 + k * 14, y: cy - 5, width: 10, height: 10, rx: 3, onclick: () => openModal('task', { batch: it.b.id, issue: it.t.issue }),
          ...tipAttrs(() => [h('div', { class: 'tt-h' }, `Next: ${word}`), h('b', null, it.t.issue), it.t.title ? h('div', null, it.t.title) : null]) }));
      }
      svg.append(h('text', { class: 'ghost-txt', x: W - R - 6, y: cy + 4, 'text-anchor': 'end' }, xs.length ? `${xs.length} ${word}` : 'none'));
    });
    mount(host, svg);
    mount('lane-legend', [['var(--run)', 'Codex'], ['var(--good)', 'Gate passed'], ['var(--crit)', 'Failed'], ['var(--merged)', 'Merged'], ['var(--s-pass)', 'Issue closed']].map(([c, l]) => h('span', null, h('i', { style: { background: c } }), l)));
    $('live-meta').textContent = `${spans.length} running, ${queued.length} queued`;
  }

  function renderCodex() {
    const c = S.codex || {};
    const active = (c.active || []).filter((j) => !ui.filter.batch || j.batch === ui.filter.batch).filter((j) => !ui.filter.q || `${j.issue} ${j.model}`.toLowerCase().includes(ui.filter.q));
    const cap = c.cap || 50;
    const count = c.activeCount ?? (c.active || []).length;
    let byModel = Object.entries(c.byModel || {});
    if (!byModel.length) byModel = Object.entries((S.worker.codexProcs || {}).byModel || {});
    const entries = byModel.sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value, color: MODEL_COLORS[i % MODEL_COLORS.length] }));
    $('codex-meta').textContent = `${fmtNum(S.overview.codexJobsTotal)} jobs all-time`;
    mount('codex',
      h('div', { class: 'codex-top' }, donut(entries),
        h('div', null, h('div', { class: 'cap-num' }, countUp('c-active', count), h('small', null, `of ${cap} concurrent`)),
          h('div', { class: 'meter' }, h('i', { class: count >= cap ? 'warn' : '', style: { width: `${pct(count, cap)}%` } })),
          h('div', { class: 'legend', style: { 'margin-top': '10px' } }, entries.length ? entries.map((e) => h('span', null, h('i', { style: { background: e.color } }), `${e.label} ${e.value}`)) : h('span', null, 'No active models')))),
      active.length ? h('div', { class: 'scroll' }, active.map((j) => {
        const t = (batchById(j.batch)?.tasks || []).find((x) => x.issue === j.issue);
        const steps = t ? ((t.runs || []).find((r) => r.run === j.run && r.kind === 'codex')?.steps || []) : [];
        return h('button', { class: 'item', type: 'button', onclick: () => openModal('task', { batch: j.batch, issue: j.issue }) },
          h('span', { class: 'live-dot' }),
          h('span', null,
            h('div', { class: 'i-title' }, j.issue, ' ', t && t.title ? h('span', { class: 't2' }, t.title) : null),
            h('div', { class: 'i-sub' }, `${j.model || 'model unknown'}${j.effort ? `, ${j.effort}` : ''}. ${j.step ? `Step ${gateName(j.step)}` : 'Writing code'}. ${batchName(j.batch)}`),
            steps.length ? h('div', { class: 'steps' }, steps.map((s) => h('i', { class: s.status, title: `${s.name}: ${s.status}` }))) : null),
          h('span', { class: 'i-side' }, since(j.start)));
      })) : h('div', { class: 'empty' }, 'No Codex jobs running'));
  }

  function renderGatesNow() {
    const g = ((S.now || {}).gates || []).filter((r) => !ui.filter.batch || r.batch === ui.filter.batch);
    $('gates-meta').textContent = `${g.length} running`;
    mount('gates-now', g.length ? h('div', { class: 'scroll' }, g.map((r) => {
      const t = (batchById(r.batch)?.tasks || []).find((x) => x.issue === r.issue);
      const steps = t ? ((t.runs || []).find((x) => x.run === r.run)?.steps || []) : [];
      return h('button', { class: 'item', type: 'button', onclick: () => openModal('task', { batch: r.batch, issue: r.issue }) },
        h('span', { class: 'live-dot' }),
        h('span', null, h('div', { class: 'i-title' }, r.issue, ' ', h('span', { class: 't2' }, gateName(r.gate || r.step) || r.kind)),
          h('div', { class: 'i-sub' }, `${r.run}, ${r.done} of ${r.total} steps passed`),
          steps.length ? h('div', { class: 'steps' }, steps.map((s) => h('i', { class: s.status, title: `${s.name}: ${s.status}` }))) : null),
        h('span', { class: 'i-side' }, since(r.start)));
    })) : h('div', { class: 'empty' }, 'No gates running right now'));
  }

  function renderNext() {
    const list = scoped({ ignoreStatus: true });
    const queued = list.filter((x) => ['queued', 'pending'].includes(x.st.key));
    const up = S.next.upcoming || {};
    const keys = (S.next.pipeline || []).filter((k) => (up[k] || []).some((x) => !ui.filter.batch || x.batch === ui.filter.batch));
    $('next-meta').textContent = `${queued.length} queued`;
    const maxN = Math.max(1, ...keys.map((k) => up[k].length));
    mount('next',
      h('div', { class: 'subhead' }, 'Waiting on'),
      keys.length ? keys.map((k) => {
        const xs = up[k].filter((x) => !ui.filter.batch || x.batch === ui.filter.batch);
        const bad = xs.filter((x) => ['FAIL', 'BLOCKED'].includes(x.status)).length;
        return h('button', { type: 'button', class: 'item', onclick: () => openModal('list', { gate: k, title: `Waiting on ${GATE_LONG[k] || k}` }) },
          icon(k === 'merged' ? 'merge' : (k === 'gh' || k === 'linear') ? 'kanban' : 'flask'),
          h('span', null, h('div', { class: 'i-title' }, GATE_LONG[k] || k),
            h('div', { class: 'meter' }, h('i', { class: bad ? 'bad' : 'neutral', style: { width: `${pct(xs.length, maxN)}%` } }))),
          h('span', { class: 'i-side' }, h('b', null, xs.length), bad ? h('div', { class: 'bad-ink' }, `${bad} failing`) : null));
      }) : h('div', { class: 'empty' }, 'Nothing waiting'),
      h('div', { class: 'subhead' }, 'Queue'),
      queued.length ? queued.slice(0, 8).map((x, i) => h('button', { type: 'button', class: 'item', onclick: () => openModal('task', { batch: x.b.id, issue: x.t.issue }) },
        h('span', { class: 'tag' }, `${i + 1}`), h('span', null, h('div', { class: 'i-title' }, x.t.issue, x.t.title ? h('span', { class: 't2' }, ` ${x.t.title}`) : null), h('div', { class: 'i-sub' }, batchName(x.b.id))),
        pill(x.st))) : h('div', { class: 'empty' }, 'Queue is empty'));
  }

  // ------------------------------------------------------------------ batches
  const SEGS = [['done', 'var(--good)', 'Done'], ['merged', 'var(--merged)', 'Merged'], ['passed', 'var(--s-pass)', 'Passed'], ['running', 'var(--run)', 'Running'], ['gates', 'var(--dim)', 'Awaiting gates'],
    ['failed', 'var(--crit)', 'Failed'], ['blocked', 'var(--warn)', 'Blocked'], ['queued', 'var(--pend)', 'Queued'], ['pending', 'var(--track)', 'Pending']];
  function batchRow(b) {
    const ts = b.tasks.map((t) => statusOf(t).key);
    const n = ts.length;
    const cnt = Object.fromEntries(SEGS.map(([k]) => [k, ts.filter((s) => s === k).length]));
    const segs = SEGS.filter(([k]) => cnt[k]);
    return h('div', { class: `batch ${ui.batch === b.id ? 'selected' : ''}`, 'aria-pressed': ui.batch === b.id ? 'true' : 'false', ...activate(() => selectBatch(b.id)) },
      h('div', null, h('div', { class: 'b-name' }, b.label || b.id), h('div', { class: 'b-sub' }, `${n} tasks. Started ${fmtDT(b.start)}. Last activity ${ago(b.last)}.`), h('div', { class: 'b-id' }, b.id)),
      h('div', null, h('div', { class: 'stackbar', role: 'img', 'aria-label': segs.map(([k, , l]) => `${cnt[k]} ${l}`).join(', ') },
        segs.map(([k, c, l]) => h('i', { style: { 'flex-grow': String(cnt[k]), background: c }, ...tipAttrs(() => [h('b', null, `${cnt[k]} ${l}`)]) }))),
      h('div', { class: 'b-legend' }, segs.map(([k, c, l]) => h('span', null, h('i', { style: { background: c } }), `${cnt[k]} ${l}`)))),
      h('div', { class: 'b-right' },
        b.active ? h('span', { class: 'pill s-running' }, icon('circle-notch'), `${b.active} active`) : h('span', { class: 'pill s-pending' }, icon('circle-dashed'), 'Idle'),
        h('div', { class: 'chips' }, (b.runs || []).slice(0, 4).map((r) => h('button', { type: 'button', class: 'tag', title: `${r.tasks} tasks`, onclick: (e) => { e.stopPropagation(); openModal('run', { batch: b.id, run: r.name }); } }, r.name)),
          b.attemptDirs ? h('span', { class: 'tag', title: 'Superseded attempt directories' }, `${b.attemptDirs} attempts`) : null)));
  }
  function renderBatches() {
    const list = S.batches.filter((b) => !ui.filter.batch || b.id === ui.filter.batch);
    const archived = list.filter((b) => b.archived);
    const current = list.filter((b) => !b.historical && !b.archived);
    const hist = list.filter((b) => b.historical && !b.archived);
    $('batches-meta').textContent = `${S.batches.length} discovered automatically. ${current.length} current, ${hist.length} historical, ${archived.length} archived.`;
    const wasOpen = document.querySelector('details.hist')?.open;
    const wasArchOpen = document.querySelector('details.archive')?.open;
    mount('batches', current.length ? current.map(batchRow) : h('div', { class: 'empty' }, 'No current batches'),
      hist.length ? h('details', { class: 'hist', open: wasOpen || hist.some((b) => b.id === ui.batch) }, h('summary', null, icon('caret-right'), `Historical batches (${hist.length})`), h('div', { class: 'batch-list' }, hist.map(batchRow))) : null,
      archived.length ? h('details', { class: 'hist archive', open: wasArchOpen || archived.some((b) => b.id === ui.batch) }, h('summary', null, icon('caret-right'), `Archive (${archived.length})`), h('div', { class: 'batch-list' }, archived.map(batchRow))) : null);
  }
  function selectBatch(id, forceOpen) {
    ui.batch = ui.batch === id && !forceOpen ? null : id;
    if ($('dlg').open) $('dlg').close();
    renderBatches();
    renderBatchDetail();
    if (ui.batch) $('batch-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function gateColumns(tasks) {
    const seenK = new Set();
    for (const t of tasks) for (const k of Object.keys(t.gates || {})) seenK.add(k);
    const extra = [...seenK].filter((k) => !GATE_ORDER.includes(k) && !GATE_TAIL.includes(k)).sort();
    return [...GATE_ORDER, ...extra, ...GATE_TAIL.filter((k) => k !== 'final_sha')];
  }
  function gateTitle(key, g) {
    if (!g) return `${GATE_LONG[key] || key}: not run yet`;
    const bits = [`${GATE_LONG[key] || key}: ${g.status}`];
    if (g.raw && g.raw !== g.status) bits.push(`raw ${g.raw}`);
    if (g.run) bits.push(`run ${g.run}`);
    if (g.sha) bits.push(`sha ${g.sha}`);
    if (isNum(g.dur)) bits.push(`took ${fmtDur(g.dur)}`);
    if (isNum(g.passed) || isNum(g.failed)) bits.push(`tests ${g.passed ?? '?'} passed, ${g.failed ?? '?'} failed`);
    if (g.newFailures) bits.push(`${g.newFailures.length} new failures vs baseline, ${g.baselineFailures || 0} pre-existing`);
    if (g.note) bits.push(g.note);
    if (g.state) bits.push(`state ${g.state}`);
    if (g.pr) bits.push(`PR #${g.pr}`);
    return bits.join('\n');
  }
  const GATE_ICON = { PASS: 'check', FAIL: 'x', RUNNING: 'circle-notch', BLOCKED: 'prohibit', BASE: 'warning', SKIP: null, PENDING: null };
  function gateCell(t, key) {
    const g = (t.gates || {})[key];
    let s = g ? g.status : 'PENDING';
    let title = gateTitle(key, g);
    if (key === 'complete_unit' && s === 'FAIL' && ((t.gates || {}).differential || {}).status === 'PASS') { s = 'BASE'; title += '\nOnly failures already present on the baseline'; }
    return h('span', { class: `g ${s}`, title, 'aria-label': `${GATE_LONG[key] || key}: ${s}` }, GATE_ICON[s] ? icon(GATE_ICON[s]) : null);
  }
  function renderBatchDetail() {
    const panel = $('batch-detail');
    const b = S && batchById(ui.batch);
    if (!b) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    $('bd-title').textContent = b.label || b.id;
    $('bd-sub').textContent = `${b.id}. Started ${fmtDT(b.start)} PKT. Last activity ${ago(b.last)}.`;
    mount('bd-ins', allInsights().filter((x) => x.batch === b.id && !x.issue).map((x) => insightCard(x, true)));
    const base = b.baseline;
    mount('bd-summary',
      base ? h('button', { type: 'button', class: 'tag', onclick: () => openModal('run', { batch: b.id, run: base.run }) }, icon('flask'),
        base.complete
          ? (base.numPassedTests != null
              ? `Baseline ${base.baseSHA || ''}: ${base.numPassedTests} pass / ${base.numFailedTests ?? '?'} fail`
              : `Baseline ${base.baseSHA || ''}: ${base.numFailedTests ?? 0} failing tests (pass count not recorded)`)
          : `Current baseline ${base.baseSHA || ''}: ${base.incompleteReason || 'incomplete'}`) : h('span', { class: 'tag' }, 'No baseline in this batch'),
      b.previousBaseline ? h('span', { class: 'tag' }, `Previous ${b.previousBaseline.baseSHA || ''}: ${b.previousBaseline.numPassedTests ?? '?'} pass / ${b.previousBaseline.numFailedTests ?? '?'} fail`) : null,
      (b.policies || []).map((p) => h('span', { class: 'tag', title: 'Merge gate policy present' }, icon('shield'), p)),
      [...(b.ledgers || []), ...(b.files || [])].map((l) => h('button', { type: 'button', class: 'tag', onclick: () => openModal('file', { batch: b.id, file: l }) }, icon('list'), `${l.run ? `${l.run}/` : ''}${l.file}`)));
    const cols = gateColumns(b.tasks);
    const rows = b.tasks.map((t) => ({ t, st: statusOf(t) })).filter(({ t, st }) => filterMatch(b, t, st));
    const head = h('thead', null, h('tr', null, h('th', null, 'Issue'), h('th', null, 'Title'), h('th', null, 'Status'),
      cols.map((k) => h('th', { class: 'gate', title: GATE_LONG[k] || k }, GATE_LABEL[k] || k)), h('th', null, 'Final SHA'), h('th', null, 'Last')));
    const body = h('tbody', null, rows.length ? rows.map(({ t, st }) => h('tr', { class: 'click', ...activate(() => openModal('task', { batch: b.id, issue: t.issue })) },
      h('td', null, h('b', null, t.issue)),
      h('td', { class: 'title-cell', title: t.title || '' }, t.title || h('span', { class: 'meta' }, 'No title yet')),
      h('td', null, pill(st)),
      cols.map((k) => h('td', { class: 'gate' }, gateCell(t, k))),
      h('td', null, sha(t.finalSHA), (t.gates.final_sha || {}).status === 'PASS' ? null : h('span', { class: 'meta', title: (t.gates.final_sha || {}).note || 'Gates not all passed on this SHA' }, ' unverified')),
      h('td', { class: 'meta' }, ago(t.last)))) : h('tr', null, h('td', { class: 'empty', colspan: cols.length + 5 }, 'No tasks match the filters')));
    $('matrix').replaceChildren(head, body);
  }

  // ------------------------------------------------------------------ history
  function renderActivity() {
    const host = $('activity');
    const W = widthOf(host, 1000);
    const days = 14;
    const keys = [];
    for (let i = days - 1; i >= 0; i -= 1) keys.push(dayKey(nowSec() - i * 86400));
    const cats = ['pass', 'merge', 'codex', 'fail'];
    const data = Object.fromEntries(keys.map((k) => [k, { pass: 0, merge: 0, codex: 0, fail: 0 }]));
    for (const e of S.events || []) {
      if (ui.filter.batch && e.batch && e.batch !== ui.filter.batch) continue;
      const k = dayKey(e.ts); const c = classifyEvent(e);
      if (data[k] && c) data[k][c] += 1;
    }
    const totals = keys.map((k) => cats.reduce((a, c) => a + data[k][c], 0));
    const max = Math.max(4, ...totals);
    const H = 200; const L = 30; const B = 22; const T = 14;
    const colW = (W - L) / days;
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const svg = h('svg', { class: 'activity', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity per day, last 14 days' });
    for (let i = 0; i <= 3; i += 1) {
      const v = Math.round((max * i) / 3);
      svg.append(h('line', { class: 'a-grid', x1: L, x2: W, y1: y(v), y2: y(v) }), h('text', { class: 'a-lbl', x: L - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, v));
    }
    keys.forEach((k, i) => {
      const g = h('g', { class: `a-col ${ui.evDay === k ? 'sel' : ''}`, ...activate(() => { ui.evDay = ui.evDay === k ? null : k; ui.evLimit = 120; renderActivity(); renderEvents(); }),
        ...tipAttrs(() => [h('div', { class: 'tt-h' }, dayLabel(k)), ...[...cats].reverse().map((c) => h('div', { class: 'tt-row' }, h('span', null, h('i', { style: { background: SERIES[c] } }), SERIES_LABEL[c]), h('b', null, data[k][c])))]) },
      h('rect', { class: 'a-hit', x: L + i * colW, y: 0, width: colW, height: H - B + 4, rx: 6 }));
      let acc = 0;
      const bw = Math.min(28, colW * 0.56);
      const bx = L + i * colW + (colW - bw) / 2;
      cats.forEach((c) => {
        const v = data[k][c];
        if (!v) return;
        const y0 = y(acc); const y1 = y(acc + v);
        g.append(h('rect', { x: bx, y: y1 + 1, width: bw, height: Math.max(1, y0 - y1 - 2), rx: 3, fill: SERIES[c] }));
        acc += v;
      });
      if (totals[i]) g.append(h('text', { class: 'a-val', x: bx + bw / 2, y: y(acc) - 5 }, totals[i]));
      if (colW > 42 || i % 2 === days % 2) g.append(h('text', { class: 'a-lbl', x: bx + bw / 2, y: H - 6 }, dayLabel(k).slice(4)));
      svg.append(g);
    });
    mount(host, h('div', { class: 'legend legend-pad' }, [...cats].reverse().map((c) => h('span', null, h('i', { style: { background: SERIES[c] } }), SERIES_LABEL[c])),
      ui.evDay ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.evDay = null; renderActivity(); renderEvents(); } }, icon('x'), `Clear ${dayLabel(ui.evDay)}`) : null), svg);
    $('history-meta').textContent = `${(S.events || []).length} events retained. ${fmtNum(S.overview.mergedLast30d)} merges in 30 days.`;
  }

  function renderMerges() {
    const merged = S.github.merged || [];
    const closed = S.github.closedIssues || [];
    const keys = []; for (let i = 29; i >= 0; i -= 1) keys.push(dayKey(nowSec() - i * 86400));
    const count = (arr, f) => keys.map((k) => arr.filter((x) => isNum(x[f]) && dayKey(x[f]) === k).length);
    const devAt = S.github.developMovedAt || S.github.developAt;
    $('merges-meta').textContent = `${merged.length} in 30 days${S.github.developSha ? `. develop at ${S.github.developSha.slice(0, 8)}` : ''}${devAt ? ` · moved ${fmtClock(devAt)} PKT` : ''}`;
    $('issues-meta').textContent = `${closed.length} with DEV references in 30 days`;
    const wM = widthOf($('merges'), 520); const wI = widthOf($('issues'), 520);
    const mergeLabel = (p) => p.number ? `#${p.number} ` : (p.kind === 'fast-forward' ? 'fast-forward ' : '');
    mount('merges', miniBars(count(merged, 'mergedAt'), keys, 'var(--merged)', wM),
      merged.length ? h('div', { class: 'scroll' }, merged.map((p) => h('button', { class: 'item', type: 'button', onclick: p.number ? () => openModal('merge', { number: p.number }) : null },
        icon('merge'), h('span', null, h('div', { class: 'i-title' }, mergeLabel(p), h('span', { class: 't2' }, p.title)), h('div', { class: 'i-sub' }, `${fmtDT(p.mergedAt)} PKT. `, sha(p.sha), (p.issues || []).length ? `. ${p.issues.join(', ')}` : '')),
        h('span', { class: 'i-side' }, ago(p.mergedAt))))) : h('div', { class: 'empty' }, 'No merges reported'));
    mount('issues', miniBars(count(closed, 'closedAt'), keys, 'var(--s-pass)', wI),
      closed.length ? h('div', { class: 'scroll' }, closed.map((i) => h('button', { class: 'item', type: 'button', onclick: () => openModal('ghissue', { number: i.number }) },
        icon('check-circle'), h('span', null, h('div', { class: 'i-title' }, `#${i.number} `, h('span', { class: 't2' }, i.title)), h('div', { class: 'i-sub' }, `${fmtDT(i.closedAt)} PKT. ${(i.issues || []).join(', ')}`)),
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
    const q = (ui.evQ || ui.filter.q).toLowerCase();
    const list = all.filter((e) => (!ui.evKind || e.kind === ui.evKind) && (!ui.evDay || dayKey(e.ts) === ui.evDay)
      && (!ui.filter.batch || !e.batch || e.batch === ui.filter.batch)
      && (!q || [e.text, e.issue, e.batch, e.run].filter(Boolean).join(' ').toLowerCase().includes(q)));
    const shown = list.slice(0, ui.evLimit);
    $('events-meta').textContent = `${list.length} of ${all.length} events${ui.evDay ? `, ${dayLabel(ui.evDay)}` : ''}`;
    const groups = [];
    for (const e of shown) {
      const k = dayKey(e.ts);
      if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, items: [] });
      groups[groups.length - 1].items.push(e);
    }
    const tools = h('div', { class: 'seg' }, ['', ...kinds].map((k) => h('button', { type: 'button', class: ui.evKind === k ? 'on' : '', onclick: () => { ui.evKind = k; ui.evLimit = 120; renderEvents(); } }, k ? k[0].toUpperCase() + k.slice(1) : 'All')));
    const container = $('events');
    const prevScroll = container.querySelector('.tl-wrap')?.scrollTop || 0;
    const wrap = h('div', { class: 'tl-wrap' }, groups.length ? groups.map((g) => [h('div', { class: 'tl-day' }, dayLabel(g.k), h('span', null, `${g.items.length} events`)),
      h('div', { class: 'tl' }, g.items.map((e) => h('button', { type: 'button', class: `tl-item ev-${e.level || ''} k-${e.kind}`, onclick: () => openEvent(e) },
        h('span', { class: 't' }, fmtHM(e.ts)),
        h('span', { class: 'x' }, h('span', { class: 'kind' }, e.kind), e.issue ? h('b', null, `${e.issue} `) : null, e.text),
        h('span', { class: 'side' }, e.batch ? batchName(e.batch) : ''))))]) : h('div', { class: 'empty' }, 'No events match'));
    mount(container, h('div', { class: 'tl-tools' }, tools), wrap,
      list.length > ui.evLimit ? h('button', { class: 'btn btn-ghost more-btn', type: 'button', onclick: () => { ui.evLimit += 200; renderEvents(); } }, `Load ${Math.min(200, list.length - ui.evLimit)} older`) : null);
    wrap.scrollTop = prevScroll;
  }

  // ------------------------------------------------------------------ machine
  function historyRows(field) {
    const hist = S.worker.history;
    if (!hist || !hist.recent) return [];
    const idx = hist.fields.indexOf(field);
    return idx < 0 ? [] : hist.recent.map((r) => [r[0], r[idx]]);
  }
  function renderWorker() {
    const host = $('worker');
    const sys = S.worker.system || {};
    const workers = S.box.workers || [];
    const w = workers.find((x) => x.primary) || workers[0] || {};
    const cores = sys.cores || 1;
    const load = sys.load || [];
    const mem = sys.mem || {};
    const disks = sys.disks || {};
    const ks = S.worker.killSwitch || {};
    const cap = S.limits.spotCap;
    const spot = w.spotPrice;
    $('worker-meta').textContent = S.worker.collectedAt ? `Collected ${ago(S.worker.collectedAt)}` : 'No worker data yet';
    const cols = window.innerWidth > 1100 ? 3 : window.innerWidth > 700 ? 2 : 1;
    const cardW = Math.max(220, Math.floor((widthOf(host, 1200) - 14 * (cols - 1)) / cols) - 32);
    const metric = (field, value, unit, sub, color, opts = {}) => h('div', { class: 'card metric', ...activate(() => openModal('metric', { field })) },
      h('div', { class: 'm-top' }, h('div', { class: 'm-label' }, icon(METRICS[field].icon), METRICS[field].label), h('span', { class: 'meta' }, 'Last hour')),
      h('div', { class: 'm-value' }, value, unit ? h('small', null, unit) : null), h('div', { class: 'm-sub' }, sub),
      areaChart(historyRows(field), { width: cardW, height: 120, max: opts.max, thr: opts.thr, color, unit: unit === '%' ? '%' : '', label: METRICS[field].label }));
    const psi = sys.psi || {};
    const psiTxt = ['cpu', 'memory', 'io'].map((r) => (psi[r] && psi[r].some ? `${r} ${psi[r].some.avg10.toFixed(1)}%` : null)).filter(Boolean).join(', ') || 'n/a';
    const diskRow = (path) => {
      const d = disks[path];
      if (!d) return h('div', { class: 'disk' }, h('div', { class: 'd-top' }, h('span', null, path), h('span', { class: 'meta' }, 'Not mounted')));
      const lvl = d.pct >= S.limits.diskAlert ? 'bad' : d.pct >= 75 ? 'warn' : '';
      const head = path === '/workspace' ? d.freeBytes - S.limits.reserveBytes : null;
      return h('div', { class: 'disk', ...activate(() => openModal('metric', { field: path === '/workspace' ? 'workspacePct' : 'scratchPct' })) },
        h('div', { class: 'd-top' }, h('span', null, path), h('b', null, `${Math.round(d.pct)}%`)),
        h('div', { class: 'd-bar' }, h('i', { class: lvl, style: { width: `${d.pct}%` } }), h('b', { style: { left: `${S.limits.diskAlert}%` } })),
        h('div', { class: 'd-sub' }, `${fmtGiB(d.freeBytes)} free of ${fmtGiB(d.totalBytes)}`, isNum(head) ? `. ${head >= 0 ? `${fmtGiB(head)} above` : `${fmtGiB(-head)} below`} the 200 GiB reserve` : ''));
    };
    const svc = S.worker.services;
    mount(host, h('div', { class: 'machine-grid' },
      metric('cpuPct', isNum(sys.cpuPct) ? Math.round(sys.cpuPct) : '-', '%', `${cores} cores. PSI ${psiTxt}`, 'var(--blue)', { max: 100 }),
      metric('load1', isNum(load[0]) ? load[0].toFixed(2) : '-', '', isNum(load[1]) ? `5 min ${load[1].toFixed(2)}, 15 min ${load[2].toFixed(2)}. Alert above ${(0.9 * cores).toFixed(1)}` : '', 'var(--green)', { thr: 0.9 * cores }),
      metric('memPct', isNum(mem.pct) ? Math.round(mem.pct) : '-', '%', `${fmtGiB(mem.usedBytes)} of ${fmtGiB(mem.totalBytes)} used`, 'var(--orange)', { max: 100 }),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, icon('disk'), 'Disks')), diskRow('/workspace'), diskRow('/scratch')),
      h('div', { class: 'card', ...activate(() => openModal('workers', {})) }, h('div', { class: 'card-head' }, h('h3', null, icon('cloud'), 'Instance'), w.state ? pill({ key: w.state === 'running' ? 'passed' : 'blocked', label: `${w.state}${w.lifecycle ? `, ${w.lifecycle}` : ''}` }) : null),
        h('dl', { class: 'kv' }, kv('Instance', w.instanceId || '-'), kv('Type', w.instanceType || '-'), kv('Zone', w.az || '-'), kv('Uptime', isNum(sys.uptimeSec) ? fmtDur(sys.uptimeSec) : '-')),
        h('div', { class: 'disk' }, h('div', { class: 'd-top' }, h('span', null, 'Spot price per hour'), h('b', null, isNum(spot) ? `$${spot.toFixed(4)}` : 'Unknown')),
          h('div', { class: 'd-bar' }, h('i', { class: isNum(spot) && spot > cap ? 'bad' : '', style: { width: `${isNum(spot) ? pct(spot, cap * 1.25) : 0}%` } }), h('b', { style: { left: `${pct(cap, cap * 1.25)}%` } })),
          h('div', { class: 'd-sub' }, `Cap $${cap.toFixed(2)}${w.spotRequestState ? `. Request ${w.spotRequestState}` : ''}`))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, icon('plugs'), 'Services & egress'),
        h('button', { type: 'button', class: `pill ${ks.pass === true ? 's-passed' : ks.pass === false ? 's-failed' : 's-pending'}`, onclick: () => openModal('killswitch', {}) }, icon(ks.pass === false ? 'x-circle' : 'lock'), `Kill-switch ${ks.pass === true ? 'pass' : ks.pass === false ? 'FAIL' : 'unknown'}`)),
        h('div', { class: 'chips' }, svc === null || svc === undefined ? h('span', { class: 'meta' }, 'systemd not available') : svc.length ? svc.map((s) => h('button', {
          type: 'button', class: `svc ${s.active === 'active' ? 'ok' : s.active === 'failed' ? 'bad' : s.active === 'activating' ? 'run' : ''}`, title: `${s.active}/${s.sub}`, onclick: () => openModal('service', { unit: s.unit }),
        }, h('i'), s.unit)) : h('span', { class: 'meta' }, 'No matching units')),
        h('div', { class: 'meta svc-note' }, `${(S.worker.codexProcs || {}).total ?? '-'} Codex processes on the worker. Egress checked ${ks.checkedAt ? `at ${fmtHM(ks.checkedAt)} PKT` : 'never'}.`))));
  }

  // ------------------------------------------------------------------ modal stack
  function openModal(kind, key) {
    const dlg = $('dlg');
    if (!dlg.open) ui.modal = [];
    ui.modal.push({ kind, key });
    hideTip();
    renderModal();
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
  }
  function setHead(kicker, title, sub) {
    $('dlg-kicker').textContent = kicker;
    $('dlg-title').replaceChildren(...[title].flat());
    $('dlg-sub').textContent = sub || '';
    $('dlg-back').classList.toggle('hidden', ui.modal.length < 2);
  }
  const evidence = (obj, label = 'Raw evidence (sanitised JSON)') => h('details', { class: 'evidence' }, h('summary', null, label), h('pre', { class: 'json' }, JSON.stringify(obj, null, 2)));
  const kv = (k, v) => h('div', null, h('dt', null, k), h('dd', null, v ?? '-'));
  const sec = (title, ...kids) => h('div', { class: 'd-sec' }, h('h4', null, title), ...kids);
  const taskItem = (b, t) => { const st = statusOf(t); return h('button', { class: 'item', type: 'button', onclick: () => openModal('task', { batch: b.id, issue: t.issue }) },
    pill(st), h('span', null, h('div', { class: 'i-title' }, t.issue, t.title ? h('span', { class: 't2' }, ` ${t.title}`) : null),
      h('div', { class: 'i-sub' }, `${b.label || b.id}${t.finalSHA ? `. Final ${t.finalSHA.slice(0, 7)}` : ''}${t.nextGate ? `. Next: ${GATE_LONG[t.nextGate] || t.nextGate}` : ''}`)),
    h('span', { class: 'i-side' }, ago(t.last))); };
  const findTask = (issue) => allTasks().filter(({ t }) => t.issue === issue).sort((a, c) => (c.t.last || 0) - (a.t.last || 0))[0];

  function renderModal() {
    const top = ui.modal[ui.modal.length - 1];
    if (!top) return;
    const R = { task: modalTask, merge: modalMerge, ghissue: modalGhIssue, run: modalRun, metric: modalMetric, list: modalList, service: modalService, alert: modalAlert,
      killswitch: modalKillswitch, usage: modalUsage, workers: modalWorkers, file: modalFile, event: modalEvent, insight: modalInsight }[top.kind];
    mount('dlg-body', R ? R(top.key) : evidence(top));
  }

  function modalList(k) {
    let items = [];
    if (k.stage === 'all') items = scoped({ ignoreStatus: true });
    else if (k.status) items = scoped({ ignoreStatus: true }).filter((x) => (k.status === 'passed' ? ['passed', 'merged', 'done'].includes(x.st.key) : k.status === 'merged' ? x.t.merged : x.st.key === k.status));
    else if (k.pipeline) items = scoped({ ignoreStatus: true }).filter((x) => stageOf(x.t, x.st) === k.pipeline);
    else if (k.gate) items = ((S.next.upcoming || {})[k.gate] || []).map((x) => { const b = batchById(x.batch); const t = b && b.tasks.find((y) => y.issue === x.issue); return t ? { b, t } : null; }).filter(Boolean);
    setHead('Tasks', k.title, `${items.length} tasks`);
    return items.length ? h('div', null, items.map(({ b, t }) => taskItem(b, t))) : h('div', { class: 'empty' }, 'No tasks');
  }

  function gantt(runs, now, width) {
    const spans = runs.map((r) => {
      const start = r.start ?? r.codexStart;
      const running = r.norm === 'RUNNING' || /RUNNING|VERIFYING/i.test(r.status || '');
      const end = r.end ?? (running ? now : r.last) ?? start;
      return { r, start, end };
    }).filter((s) => isNum(s.start));
    if (!spans.length) return h('div', { class: 'empty' }, 'No timing information yet');
    const t0 = Math.min(...spans.map((s) => s.start));
    const t1 = Math.max(t0 + 60, ...spans.map((s) => s.end || s.start));
    const W = width; const L = 140; const rowH = 32; const H = 26 + spans.length * rowH;
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - 12);
    const svg = h('svg', { class: 'gantt', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Run timeline' });
    for (let i = 0; i <= 4; i += 1) {
      const t = t0 + ((t1 - t0) * i) / 4;
      svg.append(h('line', { class: 'g-grid', x1: x(t), x2: x(t), y1: 18, y2: H - 4 }), h('text', { class: 'g-tick', x: x(t), y: 13, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, fmtHM(t)));
    }
    spans.forEach(({ r, start, end }, i) => {
      const yy = 22 + i * rowH;
      svg.append(h('text', { class: 'g-lbl', x: 10, y: yy + 16 }, `${r.kind} ${r.run}`.slice(0, 22)),
        h('rect', { class: 'g-span', x: x(start), y: yy + 2, width: Math.max(3, x(end) - x(start)), height: 22, rx: 5, ...tipAttrs(() => [h('div', { class: 'tt-h' }, r.run), h('div', null, r.status || ''), h('div', { class: 'meta' }, `${fmtDT(start)} to ${fmtDT(end)}, ${fmtDur(end - start)}`)]) }));
      if (isNum(r.codexStart)) {
        const ce = r.codexEnd ?? (r.norm === 'RUNNING' ? now : r.codexStart);
        svg.append(h('rect', { class: 'f-RUNNING', x: x(r.codexStart), y: yy + 6, width: Math.max(2, x(ce) - x(r.codexStart)), height: 5, rx: 2, opacity: 0.85, ...tipAttrs(() => [h('b', null, 'Codex'), ` ${fmtDur(ce - r.codexStart)}`]) }));
      }
      for (const s of r.steps || []) {
        if (!isNum(s.start)) continue;
        const se = s.end ?? (s.status === 'RUNNING' ? now : s.start);
        svg.append(h('rect', { class: `f-${s.status}`, x: x(s.start), y: yy + 14, width: Math.max(2, x(se) - x(s.start)), height: 7, rx: 2, ...tipAttrs(() => [h('b', null, s.name), ` ${s.status}, ${fmtDur(se - s.start)}`]) }));
      }
    });
    return svg;
  }

  function verdictBox(t, st) {
    const fs = (t.gates || {}).final_sha || {};
    if (st.key === 'failed') return h('div', { class: 'verdict bad' }, icon('x-circle'), h('div', null, h('b', null, 'FAILED'), ` on ${(st.gates || []).map((g) => GATE_LONG[g] || g).join(', ')}. `, t.finalSHA ? ['Final SHA ', sha(t.finalSHA, 10), '.'] : 'No final SHA yet.'));
    if (['passed', 'merged', 'done'].includes(st.key)) {
      return h('div', { class: 'verdict good' }, icon('check-circle'), h('div', null, h('b', null, st.key === 'done' ? 'DONE' : st.key === 'merged' ? 'MERGED' : 'PASSED'), '. Every required gate passed on final SHA ', sha(fs.sha || t.finalSHA, 10),
        t.merge ? ['. Merged via ', h('a', { href: `#pr=${t.merge.number}` }, `PR #${t.merge.number}`), t.merge.sha ? [' as ', sha(t.merge.sha)] : null, '.'] : '. Not merged yet.'));
    }
    return h('div', { class: 'verdict' }, icon(STATUS_META[st.key].icon), h('div', null, h('b', null, st.label), fs.note ? `. ${fs.note}` : '', '. Shown as passed only once every required gate passes on the exact final SHA.'));
  }

  function modalTask(k) {
    const b = batchById(k.batch);
    const t = b && b.tasks.find((x) => x.issue === k.issue);
    if (!t) { setHead('Task', k.issue, 'Not present in the latest data'); return h('div', { class: 'empty' }, 'Task no longer present in the latest data'); }
    const now = nowSec();
    const st = statusOf(t);
    setHead(b.label || b.id, [t.issue, ' ', pill(st)], t.title || 'No title from Linear yet');
    const cols = gateColumns([t]);
    const diff = t.gates.differential || {};
    const unitFiles = (t.gates.complete_unit || {}).failedFiles || [];
    const newSet = new Set(diff.newFailures || []);
    const pre = unitFiles.filter((f) => !newSet.has(f));
    const runs = [...(t.runs || [])].sort((a, c) => (a.start || a.last || 0) - (c.start || c.last || 0));
    const others = allTasks().filter(({ b: ob, t: ot }) => ot.issue === t.issue && ob.id !== b.id);
    const rel = relatedInsights(b.id, t.issue);
    const linear = t.linearClosed === null ? 'Not configured' : t.linear ? `${t.linear.state}${t.linearClosed ? ', closed' : ''}` : 'Unknown';
    const w = Math.min(1080, window.innerWidth - 24) - 42;
    const mm = t.mergeMismatch;
    return [
      verdictBox(t, st),
      mm ? h('div', { class: 'verdict' }, icon('warning'), h('div', null, h('b', null, `PR #${mm.number} not counted as this task's merge. `), `${mm.reason}. `,
        h('a', { href: `#pr=${mm.number}` }, 'Open PR detail'))) : null,
      rel.length ? h('div', { class: 'stack-sm' }, rel.map((x) => insightCard(x, true))) : null,
      h('dl', { class: 'kv' },
        kv('Batch', h('a', { href: `#batch=${encodeURIComponent(b.id)}` }, b.label || b.id)), kv('Source SHA', sha(t.sourceSHA, 10)), kv('Final SHA', sha(t.finalSHA, 10)),
        kv('Model', t.model ? `${t.model}${t.effort ? `, ${t.effort}` : ''}` : '-'), kv('Changed files', isNum(t.changedFiles) ? String(t.changedFiles) : '-'),
        kv('Next step', t.nextGate ? GATE_LONG[t.nextGate] || t.nextGate : 'Complete'),
        kv('Merge PR', t.merge ? h('a', { href: `#pr=${t.merge.number}` }, `#${t.merge.number}`) : 'Not merged'), kv('Merged at', t.merge ? fmtFull(t.merge.mergedAt) : '-'),
        kv('GitHub issue', t.ghIssue ? h('a', { href: `#issue=${t.ghIssue.number}` }, `#${t.ghIssue.number} closed`) : 'Open or not found'), kv('Linear', linear)),
      sec('Gates', h('div', { class: 'chips' }, cols.map((key) => h('span', { class: 'tag', title: gateTitle(key, t.gates[key]) }, gateCell(t, key), GATE_LONG[key] || key)),
        h('span', { class: 'tag', title: gateTitle('final_sha', t.gates.final_sha) }, gateCell(t, 'final_sha'), 'Final SHA ', sha((t.gates.final_sha || {}).sha)))),
      sec('Timeline', gantt(runs, now, w)),
      h('div', { class: 'cols2' },
        sec(`New unit failures vs baseline (${(diff.newFailures || []).length})`, diff.note ? h('div', { class: 'meta' }, diff.note) : null,
          (diff.newFailures || []).length ? h('ul', { class: 'files new' }, diff.newFailures.map((f) => h('li', { title: f }, f))) : h('div', { class: 'meta' }, diff.status === 'PASS' ? 'None. Differential passes.' : `Differential ${String(diff.status || 'pending').toLowerCase()}`)),
        sec(`Already failing on baseline (${pre.length})`, pre.length ? h('ul', { class: 'files base' }, pre.map((f) => h('li', { title: f }, f))) : h('div', { class: 'meta' }, 'None'))),
      sec(`Runs (${runs.length})`, h('div', { class: 'stack-sm' }, [...runs].reverse().map((r) => runCard(b, r, now)))),
      others.length ? sec('Same issue in other batches', others.map(({ b: ob, t: ot }) => taskItem(ob, ot))) : null,
      evidence(t),
    ];
  }

  function runCard(b, r, now) {
    return h('div', { class: 'run-card' },
      h('header', null, h('a', { href: `#run=${encodeURIComponent(b.id)}/${encodeURIComponent(r.run)}` }, h('b', null, r.run)), h('span', { class: 'tag' }, r.kind),
        h('span', { class: `g ${r.norm}` }, GATE_ICON[r.norm] ? icon(GATE_ICON[r.norm]) : null), h('span', { class: 'meta' }, r.status || ''),
        h('span', { class: 'meta' }, `${fmtDT(r.start)} to ${r.end ? fmtDT(r.end) : r.norm === 'RUNNING' ? 'now' : fmtDT(r.last)}`),
        r.model ? h('span', { class: 'tag' }, `${r.model}${r.effort ? `, ${r.effort}` : ''}`) : null,
        isNum(r.codexExitCode) ? pill({ key: r.codexExitCode === 0 ? 'passed' : 'failed', label: `Codex exit ${r.codexExitCode}` }) : null,
        r.newSourceSHA ? h('span', { class: 'tag' }, 'New SHA ', sha(r.newSourceSHA)) : r.sourceSHA ? h('span', { class: 'tag' }, 'At ', sha(r.sourceSHA)) : null,
        r.stale ? pill({ key: 'blocked', label: 'Stale ledger' }) : null),
      (r.steps || []).length || (r.subGates || []).length ? h('table', null,
        h('thead', null, h('tr', null, ['Step', 'Gate', 'Status', 'Started', 'Duration', 'Tests', 'Exit'].map((x) => h('th', null, x)))),
        h('tbody', null, [...(r.steps || []), ...(r.subGates || [])].map((s) => h('tr', null,
          h('td', null, s.name), h('td', { class: 'meta' }, GATE_LABEL[s.gate] || s.gate), h('td', null, h('span', { class: `g ${s.status}` }, GATE_ICON[s.status] ? icon(GATE_ICON[s.status]) : null)),
          h('td', { class: 'meta' }, isNum(s.start) ? fmtHM(s.start) : '-'),
          h('td', null, isNum(s.start) ? fmtDur((s.end ?? (s.status === 'RUNNING' ? now : s.start)) - s.start) : '-'),
          h('td', null, isNum(s.passed) || isNum(s.failed) ? `${s.passed ?? '?'} passed, ${s.failed ?? '?'} failed` : '-'),
          h('td', null, isNum(s.exit) ? String(s.exit) : '-'))))) : h('div', { class: 'meta' }, 'No step details'),
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
    setHead(`Run in ${b.label || b.id}`, k.run, run ? `${run.kind}, ${run.tasks} tasks, ${run.active || 0} active` : '');
    return [
      run ? h('dl', { class: 'kv' }, kv('Kind', run.kind), kv('Started', fmtFull(run.start)), kv('Last activity', fmtFull(run.last)), kv('Active', String(run.active || 0)), kv('Cap', run.cap ? String(run.cap) : '-'),
        kv('Statuses', Object.entries(run.counts || {}).map(([s, n]) => `${s} ${n}`).join(', ') || '-')) : null,
      base ? sec('Baseline', h('dl', { class: 'kv' }, kv('Base SHA', sha(base.baseSHA, 10)), kv('Status', base.status), kv('Failed tests', fmtNum(base.numFailedTests)), kv('Passed tests', fmtNum(base.numPassedTests)), kv('Failed files', fmtNum(base.failedFileCount))),
        h('ul', { class: 'files base' }, (base.failedFiles || []).map((f) => h('li', { title: f }, f)))) : null,
      ledgers.length ? sec('Ledgers', ledgers.map((l) => evidence(l, `${l.file}, ${isNum(l.at) ? fmtFull(l.at) : ''}`))) : null,
      sec(`Tasks in this run (${tasks.length})`, tasks.length ? tasks.map((t) => taskItem(b, t)) : h('div', { class: 'empty' }, 'No tasks')),
      evidence({ run, baseline: base }),
    ];
  }

  function modalMerge(k) {
    const pr = (S.github.merged || []).find((p) => p.number === k.number);
    if (!pr) { setHead('Merge', `#${k.number}`, ''); return h('div', { class: 'empty' }, 'PR not in the last 30 days of data'); }
    setHead('Merged into develop', `PR #${pr.number}`, pr.title);
    const linked = (pr.issues || []).map(findTask).filter(Boolean);
    return [h('dl', { class: 'kv' }, kv('Merged at', fmtFull(pr.mergedAt)), kv('Merge commit', sha(pr.sha, 10)), kv('Head SHA', sha(pr.headSha, 10)), kv('Issues', (pr.issues || []).join(', ') || '-'), kv('GitHub', extLink('pull', pr.number, `PR #${pr.number}`))),
      sec(`Campaign tasks (${linked.length})`, linked.length ? linked.map(({ b, t }) => taskItem(b, t)) : h('div', { class: 'empty' }, 'No matching campaign task')), evidence(pr)];
  }
  function modalGhIssue(k) {
    const it = (S.github.closedIssues || []).find((i) => i.number === k.number);
    if (!it) { setHead('Issue', `#${k.number}`, ''); return h('div', { class: 'empty' }, 'Issue not in the last 30 days of data'); }
    setHead('GitHub issue closed', `#${it.number}`, it.title);
    const linked = (it.issues || []).map(findTask).filter(Boolean);
    return [h('dl', { class: 'kv' }, kv('Closed at', fmtFull(it.closedAt)), kv('Reason', it.stateReason || '-'), kv('References', (it.issues || []).join(', ')), kv('GitHub', extLink('issues', it.number, `Issue #${it.number}`))),
      sec(`Campaign tasks (${linked.length})`, linked.length ? linked.map(({ b, t }) => taskItem(b, t)) : h('div', { class: 'empty' }, 'No matching campaign task')), evidence(it)];
  }
  function modalMetric(k) {
    const m = METRICS[k.field] || { label: k.field, unit: '' };
    const hist = S.worker.history || {};
    const idx = (hist.fields || []).indexOf(k.field);
    const cores = (S.worker.system || {}).cores || 1;
    const thr = k.field === 'load1' ? 0.9 * cores : m.thr;
    const recent = idx < 0 ? [] : (hist.recent || []).map((r) => [r[0], r[idx]]);
    const hourly = idx < 0 ? [] : (hist.hourly || []).map((r) => [r[0], r[idx]]);
    const vals = recent.map((r) => r[1]).filter(isNum);
    const w = Math.min(1080, window.innerWidth - 24) - 42;
    setHead('Worker metric', m.label, `${vals.length} samples in the last hour, one per minute`);
    const st = vals.length ? { min: Math.min(...vals), max: Math.max(...vals), avg: vals.reduce((a, v) => a + v, 0) / vals.length } : null;
    return [h('dl', { class: 'kv' }, kv('Latest', vals.length ? `${vals[vals.length - 1].toFixed(1)}${m.unit}` : '-'), kv('Min, avg, max (1 h)', st ? `${st.min.toFixed(1)}, ${st.avg.toFixed(1)}, ${st.max.toFixed(1)}${m.unit}` : '-'),
      kv('Alert line', isNum(thr) ? `${thr.toFixed(1)}${m.unit}` : 'None')),
    sec('Last hour', areaChart(recent, { width: w, height: 220, max: m.max, thr, color: 'var(--blue)', unit: m.unit, label: m.label })),
    sec('Last 7 days, hourly average', areaChart(hourly, { width: w, height: 220, max: m.max, thr, color: 'var(--green)', unit: m.unit, label: m.label })),
    evidence({ system: S.worker.system })];
  }
  function modalService(k) {
    const s = (S.worker.services || []).find((x) => x.unit === k.unit) || {};
    setHead('systemd unit', k.unit, `${s.active || '?'} / ${s.sub || '?'}`);
    return [h('dl', { class: 'kv' }, kv('ActiveState', s.active), kv('SubState', s.sub), kv('Result', s.result)), h('div', { class: 'meta' }, 'Read with systemctl show. The dashboard never starts or stops units.'), evidence(s)];
  }
  function modalAlert(a) {
    setHead(a.level === 'crit' ? 'Critical alert' : 'Warning', a.message, a.code);
    const go = a.code.startsWith('disk') || a.code === 'reserve' ? () => openModal('metric', { field: a.code.includes('scratch') ? 'scratchPct' : 'workspacePct' })
      : a.code === 'load' ? () => openModal('metric', { field: 'load1' }) : a.code === 'killswitch' ? () => openModal('killswitch', {})
        : a.code.startsWith('usage') ? () => openModal('usage', {}) : a.code.startsWith('spot') ? () => openModal('workers', {})
          : a.code.startsWith('unit-') ? () => openModal('service', { unit: a.code.slice(5) }) : null;
    return [go ? h('button', { class: 'btn', type: 'button', onclick: go }, 'Open related detail', icon('arrow-right')) : null, evidence(a)];
  }
  function modalKillswitch() {
    const ks = S.worker.killSwitch || {};
    setHead('Egress kill-switch', `Kill-switch ${ks.pass === true ? 'pass' : ks.pass === false ? 'FAIL' : 'unknown'}`, ks.detail || '');
    return [h('dl', { class: 'kv' }, kv('Result', ks.pass === true ? 'Pass' : ks.pass === false ? 'FAIL' : 'Unknown'), kv('Checked', fmtFull(ks.checkedAt)), kv('Detail', ks.detail)),
      h('div', { class: 'meta' }, 'Checked every 5 minutes with a read-only tailscale status inside the codex-home namespace. Only pass or fail is reported, never an address.'), evidence(ks)];
  }
  function modalUsage() {
    const u = S.worker.usage || {};
    setHead('Weekly usage', isNum(u.weeklyPct) ? `${u.weeklyPct}%` : 'Unknown', u.stopActive ? 'Usage stop marker active' : 'Stop marker clear');
    return [h('dl', { class: 'kv' }, kv('Weekly usage', isNum(u.weeklyPct) ? `${u.weeklyPct}%` : 'Unknown'), kv('Stop line', `${S.limits.usageStop}%`), kv('Stop marker', u.stopActive ? 'ACTIVE' : 'Clear'),
      kv('Stop since', fmtFull(u.stopSince)), kv('Last cleared', fmtFull(u.clearedAt)), kv('Note', u.note)), evidence(u)];
  }
  function modalWorkers() {
    const ws = S.box.workers || [];
    const m = S.box.machine || {};
    setHead('EC2 workers', `${ws.length} worker${ws.length === 1 ? '' : 's'}`, `Region ${S.box.region || '-'}`);
    return [h('dl', { class: 'kv' }, kv('Machine hours, all time', fmtNum(m.hours, 1)), kv('Spot cost, all time', isNum(m.costUsd) ? `$${fmtNum(m.costUsd, 2)}` : '-'), kv('Tracking since', fmtFull(m.since))),
      ws.map((w) => h('div', { class: 'run-card' }, h('header', null, h('b', null, w.name || w.instanceId), h('span', { class: 'tag' }, w.state || '?'), w.primary ? h('span', { class: 'tag' }, 'primary') : null),
        h('dl', { class: 'kv' }, kv('Instance', w.instanceId), kv('Type', w.instanceType), kv('Zone', w.az), kv('Lifecycle', w.lifecycle), kv('Launched', fmtFull(w.launchTime)),
          kv('Spot price', isNum(w.spotPrice) ? `$${w.spotPrice.toFixed(4)}/h` : '-'), kv('Spot request', w.spotRequestState ? `${w.spotRequestState} (${w.spotRequestStatus || '?'})` : '-')))),
      evidence(S.box)];
  }
  function modalFile(k) {
    setHead(`Campaign file in ${batchName(k.batch)}`, k.file.file, isNum(k.file.mtime) ? `Modified ${fmtFull(k.file.mtime)}` : '');
    return [k.file.counts ? h('div', { class: 'chips' }, Object.entries(k.file.counts).map(([s, n]) => h('span', { class: 'tag' }, `${s} ${n}`))) : null, evidence(k.file, 'Summary (sanitised)')];
  }
  function modalEvent(e) {
    setHead(`Event, ${e.kind || ''}`, e.text, fmtFull(e.ts));
    return [e.batch && batchById(e.batch) ? h('button', { class: 'btn', type: 'button', onclick: () => selectBatch(e.batch, true) }, `Open ${batchName(e.batch)}`, icon('arrow-right')) : null, evidence(e)];
  }
  function relatedInsights(batch, issue) {
    const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
    return allInsights().filter((x) => (issue && x.issue === issue) || (x.evidence || []).some((e) => issue && e.link && dec(e.link).endsWith(`/${issue}`)));
  }
  function modalInsight(k) {
    const x = allInsights().find((i) => i.key === k.key);
    if (!x) { setHead('Insight', 'No longer active', ''); return h('div', { class: 'empty' }, 'This finding is no longer present in the latest data.'); }
    setHead(`${x.source === 'ai' ? 'Claude' : 'Rule'} ${x.kind}, ${x.severity}`, x.title, [x.batch ? batchName(x.batch) : '', x.issue || ''].filter(Boolean).join(', '));
    return [h('div', { class: `ins sev-${x.severity}` }, icon(SEV_ICON[x.severity] || 'info', 'sev-ic'), h('div', null, markdown(x.reason)), h('span', { class: `src ${x.source === 'ai' ? 'ai' : ''}` }, x.source === 'ai' ? 'Claude' : 'Rule')),
      sec('Evidence', h('div', { class: 'chips' }, (x.evidence || []).map((e) => { const href = safeHref(e.link); return href ? h('a', { class: 'tag', href }, icon('link'), e.label) : null; }))),
      h('div', { class: 'meta' }, x.source === 'ai' ? 'Generated by Claude from the dashboard data. Advice only. The dashboard cannot take actions.' : 'Deterministic rule, evaluated on every refresh.'),
      evidence(x)];
  }

  // ------------------------------------------------------------------ deep links
  const ROUTE_RE = /^#((task|run|batch|pr|issue|metric)=[\w%.\-/]+|usage|workers)$/;
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

  // ------------------------------------------------------------------ safe markdown (DOM only)
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
        else out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, m[4]));
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

  // ------------------------------------------------------------------ Claude chat
  const chat = { history: [], busy: false };
  const SUGGESTIONS = ['What is running right now?', 'Which tasks failed and on which gate?', 'What merges next?', 'Summarise the last 24 hours', 'How is the worker doing?'];
  try { const saved = JSON.parse(sessionStorage.getItem('ops-chat') || '[]'); if (Array.isArray(saved)) chat.history = saved.slice(-30); } catch (e) { /* storage unavailable */ }
  const saveChat = () => { try { sessionStorage.setItem('ops-chat', JSON.stringify(chat.history.slice(-30))); } catch (e) { /* ignore */ } };
  function renderChat(pending) {
    const log = $('ai-log');
    const items = chat.history.map((m) => (m.role === 'user' ? h('div', { class: 'msg user' }, m.content)
      : h('div', { class: `msg ${m.error ? 'error' : 'assistant'}` }, m.error ? m.content : markdown(m.content),
        m.meta ? h('div', { class: 'meta' }, icon('sparkle'), m.meta) : null)));
    if (!items.length) items.push(h('div', { class: 'msg assistant' }, markdown('Ask anything the dashboard knows: tasks and gates, Codex jobs, merges, GitHub and Linear state, the worker and history. Answers link to the evidence.')));
    if (pending) items.push(h('div', { class: 'msg assistant typing', 'aria-label': 'Claude is thinking' }, h('i'), h('i'), h('i')));
    log.replaceChildren(...items);
    log.scrollTop = log.scrollHeight;
    mount('ai-suggest', chat.history.length ? null : SUGGESTIONS.map((q) => h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => sendChat(q) }, q)));
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
      const res = await fetch('/api/ai/chat', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ops-dash' },
        body: JSON.stringify({ messages: chat.history.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })).slice(-16) }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      chat.history.push({ role: 'assistant', content: data.reply || '(no answer)', meta: `${data.model || ''}${(data.tools || []).length ? `, looked at ${[...new Set(data.tools)].join(', ')}` : ''}` });
    } catch (err) {
      chat.history.push({ role: 'assistant', error: true, content: `Could not get an answer: ${err.message}` });
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
    $('ai-open').setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { renderChat(chat.busy); setTimeout(() => $('ai-input').focus(), 220); }
  }
  function renderAIStatus() {
    const st = S.ai || {};
    $('ai-open').classList.toggle('hidden', !st.enabled);
    $('ai-open-2').classList.toggle('hidden', !st.enabled);
    $('ai-status').textContent = st.enabled ? `${st.model}. Analysis ${st.analysisConfig || st.model}. ${st.budgetExhausted ? 'Daily budget reached' : `${st.budgetUsedPct ?? 0}% of daily budget used`}` : 'AI not configured';
  }
  async function refreshAnalysis() {
    const btn = $('ai-refresh');
    const label = btn.lastChild;
    btn.disabled = true;
    try {
      const res = await fetch('/api/ai/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ops-dash' }, body: '{}' });
      label.textContent = res.ok ? 'Analysing' : 'Try later';
      setTimeout(() => { label.textContent = 'Re-analyse'; btn.disabled = false; load(); }, res.ok ? 45000 : 5000);
    } catch (e) { btn.disabled = false; }
  }

  // ------------------------------------------------------------------ global search
  function renderSearch() {
    const q = ui.filter.q;
    const box = $('q-results');
    if (!q) { box.classList.add('hidden'); return; }
    const res = [];
    for (const { b, t, st } of uniq(allTasks())) {
      const hay = [t.issue, t.title, t.finalSHA, t.sourceSHA].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(q)) res.push(h('button', { type: 'button', class: 'q-item', onmousedown: (e) => { e.preventDefault(); openModal('task', { batch: b.id, issue: t.issue }); } }, h('b', null, t.issue), h('span', { class: 't' }, t.title || batchName(b.id)), pill(st)));
    }
    for (const p of (S.github.merged || [])) if (`#${p.number} ${p.title} ${p.sha}`.toLowerCase().includes(q)) res.push(h('button', { type: 'button', class: 'q-item', onmousedown: (e) => { e.preventDefault(); openModal('merge', { number: p.number }); } }, icon('merge'), h('span', { class: 't' }, `#${p.number} ${p.title}`), sha(p.sha)));
    box.replaceChildren(...(res.length ? res.slice(0, 10) : [h('div', { class: 'empty' }, 'No matches')]));
    box.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ wiring
  function init() {
    let qTimer = null;
    $('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { ui.filter.q = $('q').value.trim().toLowerCase(); if (S) { render(); renderSearch(); } }, 120); });
    $('q').addEventListener('focus', () => S && renderSearch());
    $('q').addEventListener('blur', () => setTimeout(() => $('q-results').classList.add('hidden'), 120));
    $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = $('q-results').querySelector('.q-item'); if (first) first.dispatchEvent(new MouseEvent('mousedown')); } if (e.key === 'Escape') { $('q').value = ''; ui.filter.q = ''; render(); $('q').blur(); } });
    $('f-batch').addEventListener('change', () => { ui.filter.batch = $('f-batch').value; render(); });
    const applyTheme = (t) => {
      document.documentElement.dataset.theme = t;
      $('theme').querySelector('use').setAttribute('href', `/static/icons.svg#i-${t === 'dark' ? 'sun-dim' : 'moon'}`);
      $('theme').setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    };
    let theme = 'light';
    try { theme = localStorage.getItem('ops-theme') || 'light'; } catch (e) { /* storage unavailable */ }
    applyTheme(theme);
    $('theme').addEventListener('click', () => {
      theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(theme);
      try { localStorage.setItem('ops-theme', theme); } catch (e) { /* ignore */ }
      if (S) render();
    });
    $('ai-open-2').addEventListener('click', () => toggleChat(true));
    $('bd-close').addEventListener('click', () => selectBatch(ui.batch));
    $('dlg-close').addEventListener('click', () => $('dlg').close());
    $('dlg-back').addEventListener('click', () => { ui.modal.pop(); renderModal(); });
    $('dlg').addEventListener('close', () => { ui.modal = []; hideTip(); });
    $('dlg').addEventListener('click', (e) => { if (e.target === $('dlg')) $('dlg').close(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (ROUTE_RE.test(href)) { e.preventDefault(); if (route(href)) history.replaceState(null, '', href); }
    });
    window.addEventListener('hashchange', () => { if (ROUTE_RE.test(location.hash)) route(location.hash); });
    let rT = null;
    window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => S && render(), 150); });
    $('ai-open').addEventListener('click', () => toggleChat());
    $('ai-close').addEventListener('click', () => toggleChat(false));
    $('ai-clear').addEventListener('click', () => { chat.history = []; saveChat(); renderChat(false); });
    $('ai-refresh').addEventListener('click', refreshAnalysis);
    $('ai-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('ai-input').value); });
    $('ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('ai-input').value); } });
    $('ai-input').addEventListener('input', () => { const t = $('ai-input'); t.style.setProperty('height', 'auto'); t.style.setProperty('height', `${Math.min(160, t.scrollHeight)}px`); });
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (e.key === 'Escape' && $('ai-drawer').classList.contains('open') && !$('dlg').open) toggleChat(false);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); $('q').focus(); }
      if ((e.key === 'k' || e.key === 'K') && S && S.ai && S.ai.enabled) { e.preventDefault(); toggleChat(); }
    });
    if ('IntersectionObserver' in window) {
      const links = [...document.querySelectorAll('.navpill a')];
      const io = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${en.target.id}`));
      }, { rootMargin: '-35% 0px -60% 0px' });
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
