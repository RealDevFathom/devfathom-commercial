import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  classifyHealthResponse,
  detectRevenueBlocking,
  duplicateRequests,
  sanitizeDiagnostic,
  sanitizeUrl,
  summarize,
  type HealthAssessment,
  type HealthDatabaseStatus,
  type HealthGateStatus,
  type HealthServiceStatus,
  type NumericSummary,
  type SanitizedRequest,
} from './core';

type JsonRecord = Record<string, unknown>;

interface ManagedProcess {
  label: string;
  child: ChildProcess;
  stop: () => Promise<void>;
}

interface HttpSample {
  ttfbMs: number;
  totalMs: number;
  status: number;
}

interface EndpointMeasurement {
  cold: NumericSummary;
  warm: NumericSummary;
  coldTotal: NumericSummary;
  warmTotal: NumericSummary;
  statuses: number[];
}

interface HealthSample extends HttpSample {
  assessment: HealthAssessment;
}

interface HealthMeasurement extends EndpointMeasurement {
  serviceStatus: HealthServiceStatus | 'mixed';
  databaseStatus: HealthDatabaseStatus | 'mixed';
  observations: {
    cold: HealthAssessment;
    warm: HealthAssessment[];
  };
  healthGate: {
    status: HealthGateStatus;
    reason: string;
  };
  databaseBenchmark:
    | {
        status: 'measured';
        measurement: EndpointMeasurement;
        description: string;
      }
    | {
        status: 'skipped' | 'failed';
        reason: string;
      };
}

interface RequestTrace extends SanitizedRequest {
  requestId: string;
  startTimestamp: number;
  responseTimestamp?: number;
  endTimestamp?: number;
}

interface BrowserDiagnostic {
  level: string;
  message: string;
}

interface DashboardSample {
  navigation: 'client' | 'reload';
  firstVisibleMs: number;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  requestCount: number;
  apiRequestCount: number;
  duplicateRequests: ReturnType<typeof duplicateRequests>;
  requests: SanitizedRequest[];
  revenueChart: ReturnType<typeof detectRevenueBlocking>;
}

interface FrontendTarget {
  label: string;
  runtime: 'nuxt-development' | 'optimized-nitro-preview' | 'remote-production';
  url: string;
  startupMs: number | null;
  buildMs?: number;
}

const env = process.env;
const warmSamples = positiveInteger(env.PERF_WARM_SAMPLES, 5);
const timeoutMs = positiveInteger(env.PERF_TIMEOUT_MS, 60_000);
const mode = env.PERF_MODE === 'remote' ? 'remote' : 'local';
const outputRoot = resolve(env.PERF_OUTPUT_DIR || '.perf');
const runName = new Date().toISOString().replace(/[:.]/g, '-');
const runDirectory = join(outputRoot, `run-${runName}`);
const credentials =
  env.PERF_TEST_EMAIL && env.PERF_TEST_PASSWORD
    ? {
        email: env.PERF_TEST_EMAIL,
        password: env.PERF_TEST_PASSWORD,
        totp: env.PERF_TEST_TOTP || '',
      }
    : null;
const diagnosticSecrets = credentials
  ? [credentials.email, credentials.password, credentials.totp].filter(Boolean)
  : [];
const managedProcesses: ManagedProcess[] = [];

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function log(message: string): void {
  process.stdout.write(`${sanitizeDiagnostic(message, diagnosticSecrets)}\n`);
}

function endpointUrl(baseUrl: string, pathname: string): string {
  return new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`).toString();
}

function urlPath(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl;
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local port.'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForPort(port: number, processToWatch?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processToWatch?.exitCode !== null) {
      throw new Error(`Process exited before port ${port} became ready.`);
    }
    const available = await new Promise<boolean>((resolveReady) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolveReady(true);
      });
      socket.once('error', () => resolveReady(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolveReady(false);
      });
    });
    if (available) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for local port ${port}.`);
}

function startManaged(
  label: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): ManagedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || env,
    detached: true,
    stdio: 'ignore',
  });

  const managed: ManagedProcess = {
    label,
    child,
    stop: async () => {
      if (!child.pid || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        return;
      }
      const stopped = await Promise.race([
        new Promise<boolean>((resolveStopped) => child.once('exit', () => resolveStopped(true))),
        delay(3_000).then(() => false),
      ]);
      if (!stopped) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The process exited between the timeout and the signal.
        }
      }
    },
  };
  managedProcesses.push(managed);
  return managed;
}

async function runChecked(
  label: string,
  command: string,
  args: string[],
  childEnv: NodeJS.ProcessEnv = env
): Promise<number> {
  log(`${label}...`);
  const startedAt = performance.now();
  const child = spawn(command, args, { cwd: process.cwd(), env: childEnv, stdio: 'ignore' });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}.`);
  return performance.now() - startedAt;
}

async function timedFetch(url: string, init?: RequestInit): Promise<HttpSample> {
  const startedAt = performance.now();
  const response = await fetch(url, { redirect: 'manual', ...init });
  const headersAt = performance.now();
  await response.arrayBuffer();
  const completedAt = performance.now();
  return {
    ttfbMs: headersAt - startedAt,
    totalMs: completedAt - startedAt,
    status: response.status,
  };
}

function createEndpointMeasurement(cold: HttpSample, warm: HttpSample[]): EndpointMeasurement {
  return {
    cold: summarize([cold.ttfbMs]),
    warm: summarize(warm.map((sample) => sample.ttfbMs)),
    coldTotal: summarize([cold.totalMs]),
    warmTotal: summarize(warm.map((sample) => sample.totalMs)),
    statuses: [cold.status, ...warm.map((sample) => sample.status)],
  };
}

async function measureEndpoint(
  url: string,
  initFactory?: () => RequestInit
): Promise<EndpointMeasurement> {
  const cold = await timedFetch(url, initFactory?.());
  const warm: HttpSample[] = [];
  for (let index = 0; index < warmSamples; index += 1) {
    warm.push(await timedFetch(url, initFactory?.()));
  }
  return createEndpointMeasurement(cold, warm);
}

async function timedHealthFetch(url: string): Promise<HealthSample> {
  const startedAt = performance.now();
  const response = await fetch(url, { redirect: 'manual' });
  const headersAt = performance.now();
  const body = await response.text();
  const completedAt = performance.now();
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }
  return {
    ttfbMs: headersAt - startedAt,
    totalMs: completedAt - startedAt,
    status: response.status,
    assessment: classifyHealthResponse(response.status, payload, mode),
  };
}

function consistentStatus<T extends string>(values: T[]): T | 'mixed' {
  return values.every((value) => value === values[0]) ? values[0]! : 'mixed';
}

async function measureHealthEndpoint(url: string): Promise<HealthMeasurement> {
  const cold = await timedHealthFetch(url);
  const warm: HealthSample[] = [];
  for (let index = 0; index < warmSamples; index += 1) {
    warm.push(await timedHealthFetch(url));
  }
  const measurement = createEndpointMeasurement(cold, warm);
  const assessments = [cold.assessment, ...warm.map((sample) => sample.assessment)];
  const serviceStatus = consistentStatus(assessments.map((item) => item.serviceStatus));
  const databaseStatus = consistentStatus(assessments.map((item) => item.databaseStatus));
  const healthGateStatus: HealthGateStatus = assessments.some(
    (item) => item.healthGateStatus === 'failed'
  )
    ? 'failed'
    : assessments.some((item) => item.healthGateStatus === 'warning')
      ? 'warning'
      : 'passed';
  const gateReason =
    assessments.find((item) => item.healthGateStatus === healthGateStatus)?.message ||
    'Health gate classification unavailable.';
  const databaseAssessmentFailed = assessments.some(
    (item) => item.databaseBenchmarkStatus === 'failed'
  );
  const databaseConnected = assessments.every(
    (item) => item.databaseBenchmarkStatus === 'eligible' && item.databaseStatus === 'connected'
  );

  return {
    ...measurement,
    serviceStatus,
    databaseStatus,
    observations: {
      cold: cold.assessment,
      warm: warm.map((sample) => sample.assessment),
    },
    healthGate: { status: healthGateStatus, reason: gateReason },
    databaseBenchmark: databaseConnected
      ? {
          status: 'measured',
          measurement,
          description: '/health latency includes the database SELECT 1 connectivity probe.',
        }
      : databaseAssessmentFailed
        ? { status: 'failed', reason: gateReason }
        : {
            status: 'skipped',
            reason: `Database status is ${databaseStatus}; no connected-database latency is reported.`,
          },
  };
}

class CdpClient {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: JsonRecord) => void; reject: (error: Error) => void }
  >();
  private listeners = new Map<string, Set<(params: JsonRecord) => void>>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: JsonRecord;
        result?: JsonRecord;
        error?: { message?: string };
      };
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(new Error(message.error.message || 'CDP command failed.'));
        else pending.resolve(message.result || {});
        return;
      }
      if (!message.method) return;
      for (const listener of this.listeners.get(message.method) || []) {
        try {
          listener(message.params || {});
        } catch {
          // A diagnostic listener must not interrupt the benchmark.
        }
      }
    });
  }

  static async connect(webSocketUrl: string): Promise<CdpClient> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome.')), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Chrome DevTools connection failed.'));
      });
    });
    return new CdpClient(socket);
  }

  send(method: string, params: JsonRecord = {}): Promise<JsonRecord> {
    const id = this.nextId++;
    return new Promise((resolveCommand, reject) => {
      this.pending.set(id, { resolve: resolveCommand, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: JsonRecord) => void): void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(listener);
  }

  close(): void {
    this.socket.close();
  }
}

class BrowserRecorder {
  readonly requests: RequestTrace[] = [];
  readonly diagnostics: BrowserDiagnostic[] = [];
  private active = new Map<string, RequestTrace>();
  private sequence = 0;

  constructor(
    private client: CdpClient,
    private secrets: string[]
  ) {
    client.on('Network.requestWillBeSent', (params) => this.requestStarted(params));
    client.on('Network.responseReceived', (params) => this.responseReceived(params));
    client.on('Network.loadingFinished', (params) => this.requestFinished(params));
    client.on('Network.loadingFailed', (params) => this.requestFailed(params));
    client.on('Runtime.consoleAPICalled', (params) => this.consoleCalled(params));
    client.on('Runtime.exceptionThrown', (params) => this.exceptionThrown(params));
    client.on('Log.entryAdded', (params) => this.logEntry(params));
  }

  private requestStarted(params: JsonRecord): void {
    const requestId = String(params.requestId || '');
    const request = (params.request || {}) as JsonRecord;
    const previous = this.active.get(requestId);
    if (previous) previous.endTimestamp = Number(params.timestamp || previous.startTimestamp);
    const trace: RequestTrace = {
      requestId,
      method: String(request.method || 'GET').toUpperCase(),
      url: sanitizeUrl(String(request.url || '')),
      resourceType: String(params.type || 'Other'),
      startTimestamp: Number(params.timestamp || 0),
    };
    this.sequence += 1;
    this.requests.push(trace);
    this.active.set(requestId, trace);
  }

  private responseReceived(params: JsonRecord): void {
    const trace = this.active.get(String(params.requestId || ''));
    if (!trace) return;
    const response = (params.response || {}) as JsonRecord;
    trace.status = Number(response.status || 0);
    trace.responseTimestamp = Number(params.timestamp || 0);
  }

  private requestFinished(params: JsonRecord): void {
    const trace = this.active.get(String(params.requestId || ''));
    if (!trace) return;
    trace.endTimestamp = Number(
      params.timestamp || trace.responseTimestamp || trace.startTimestamp
    );
    trace.durationMs = (trace.endTimestamp - trace.startTimestamp) * 1_000;
    this.active.delete(trace.requestId);
  }

  private requestFailed(params: JsonRecord): void {
    const trace = this.active.get(String(params.requestId || ''));
    if (!trace) return;
    trace.failed = true;
    trace.endTimestamp = Number(params.timestamp || trace.startTimestamp);
    trace.durationMs = (trace.endTimestamp - trace.startTimestamp) * 1_000;
    this.active.delete(trace.requestId);
  }

  private addDiagnostic(level: string, message: string): void {
    const sanitized = sanitizeDiagnostic(message, this.secrets);
    if (!sanitized) return;
    if (this.diagnostics.some((entry) => entry.level === level && entry.message === sanitized))
      return;
    this.diagnostics.push({ level, message: sanitized });
  }

  private consoleCalled(params: JsonRecord): void {
    const level = String(params.type || 'log');
    const args = Array.isArray(params.args) ? (params.args as JsonRecord[]) : [];
    const message = args
      .map((argument) =>
        typeof argument.value === 'string'
          ? argument.value
          : argument.subtype === 'error' && typeof argument.description === 'string'
            ? argument.description
            : ''
      )
      .filter(Boolean)
      .join(' ');
    if (
      level === 'error' ||
      level === 'warning' ||
      /hydrat|mismatch|server rendered/i.test(message)
    ) {
      this.addDiagnostic(level, message);
    }
  }

  private exceptionThrown(params: JsonRecord): void {
    const details = (params.exceptionDetails || {}) as JsonRecord;
    const exception = (details.exception || {}) as JsonRecord;
    this.addDiagnostic(
      'exception',
      String(exception.description || details.exceptionText || details.text || 'Browser exception')
    );
  }

  private logEntry(params: JsonRecord): void {
    const entry = (params.entry || {}) as JsonRecord;
    const level = String(entry.level || 'log');
    if (level === 'error' || level === 'warning') {
      this.addDiagnostic(level, String(entry.text || 'Browser log entry'));
    }
  }

  tracesSince(index: number, startedAt: number): RequestTrace[] {
    return this.requests
      .slice(index)
      .filter((request) => request.startTimestamp >= startedAt)
      .filter(
        (request) => !['/api/auth/login', '/api/auth/login/verify'].includes(urlPath(request.url))
      );
  }

  dashboardStartSince(index: number, fallback: number): number {
    return (
      this.requests
        .slice(index)
        .find(
          (request) => !['/api/auth/login', '/api/auth/login/verify'].includes(urlPath(request.url))
        )?.startTimestamp || fallback
    );
  }

  latestRequest(pathname: string): RequestTrace | undefined {
    return [...this.requests].reverse().find((request) => urlPath(request.url) === pathname);
  }
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const exception = response.exceptionDetails as JsonRecord | undefined;
  if (exception) throw new Error('Browser evaluation failed.');
  return ((response.result as JsonRecord | undefined)?.value ?? null) as T;
}

async function monotonicTimestamp(client: CdpClient): Promise<number> {
  const response = await client.send('Performance.getMetrics');
  const metrics = (response.metrics || []) as JsonRecord[];
  const timestamp = metrics.find((metric) => metric.name === 'Timestamp')?.value;
  if (typeof timestamp !== 'number')
    throw new Error('Chrome did not expose a monotonic timestamp.');
  return timestamp;
}

async function waitForBrowserValue<T>(
  client: CdpClient,
  expression: string,
  accept: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate<T>(client, expression);
      if (accept(value)) return value;
    } catch {
      // Navigation can briefly invalidate the JavaScript execution context.
    }
    await delay(40);
  }
  throw new Error('Timed out waiting for the browser page state.');
}

function chromeExecutable(): string {
  const candidates = [
    env.PERF_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error('Chrome was not found. Set PERF_CHROME_PATH to a Chrome or Chromium binary.');
  }
  return executable;
}

async function connectChrome(port: number): Promise<CdpClient> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pages = (await fetch(`${endpoint}/json/list`).then((response) => response.json())) as {
        type?: string;
        webSocketDebuggerUrl?: string;
      }[];
      let page = pages.find((candidate) => candidate.type === 'page');
      if (!page?.webSocketDebuggerUrl) {
        page = (await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' }).then(
          (response) => response.json()
        )) as { type?: string; webSocketDebuggerUrl?: string };
      }
      if (page.webSocketDebuggerUrl) return await CdpClient.connect(page.webSocketDebuggerUrl);
    } catch {
      await delay(100);
    }
  }
  throw new Error('Timed out starting Chrome.');
}

async function submitLogin(
  client: CdpClient,
  email: string,
  password: string,
  totp: string
): Promise<'dashboard' | 'two-factor-missing' | 'failed'> {
  const documentResult = await client.send('Runtime.evaluate', {
    expression: 'document',
    returnByValue: false,
  });
  const objectId = (documentResult.result as JsonRecord | undefined)?.objectId;
  if (typeof objectId !== 'string') throw new Error('Could not access the login document.');
  await client.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function (email, password) {
      const setValue = (selector, value) => {
        const input = this.querySelector(selector);
        if (!input) throw new Error('Login field unavailable');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue('#email', email);
      setValue('#password', password);
      this.querySelector('form')?.requestSubmit();
    }`,
    arguments: [{ value: email }, { value: password }],
    awaitPromise: true,
  });

  const stateExpression = `(() => ({
    path: location.pathname,
    twoFactor: Boolean(document.querySelector('#totp')),
    alert: Boolean(document.querySelector('[role="alert"]')),
    loading: Boolean(document.querySelector('button[disabled]'))
  }))()`;
  const state = await waitForBrowserValue<{
    path: string;
    twoFactor: boolean;
    alert: boolean;
    loading: boolean;
  }>(
    client,
    stateExpression,
    (value) => value.path === '/dashboard' || value.twoFactor || (value.alert && !value.loading)
  );

  if (state.path === '/dashboard') return 'dashboard';
  if (!state.twoFactor) return 'failed';
  if (!totp) return 'two-factor-missing';

  const secondDocument = await client.send('Runtime.evaluate', {
    expression: 'document',
    returnByValue: false,
  });
  const secondObjectId = (secondDocument.result as JsonRecord | undefined)?.objectId;
  if (typeof secondObjectId !== 'string')
    throw new Error('Could not access the verification form.');
  await client.send('Runtime.callFunctionOn', {
    objectId: secondObjectId,
    functionDeclaration: `function (code) {
      const input = this.querySelector('#totp');
      if (!input) throw new Error('Verification field unavailable');
      input.value = code;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      this.querySelector('form')?.requestSubmit();
    }`,
    arguments: [{ value: totp }],
    awaitPromise: true,
  });
  const verified = await waitForBrowserValue<{ path: string; alert: boolean; loading: boolean }>(
    client,
    `(() => ({
      path: location.pathname,
      alert: Boolean(document.querySelector('[role="alert"]')),
      loading: Boolean(document.querySelector('button[disabled]'))
    }))()`,
    (value) => value.path === '/dashboard' || (value.alert && !value.loading)
  );
  return verified.path === '/dashboard' ? 'dashboard' : 'failed';
}

const dashboardStateExpression = `(() => {
  const grid = document.querySelector('.studio-kpi-grid');
  const loading = document.body?.innerText.includes('Loading your operating view') || false;
  return {
    path: location.pathname,
    visible: !loading && Boolean(grid && grid.children.length),
    failed: Boolean(document.querySelector('.studio-toast-error')) && !loading,
    now: performance.now(),
    dcl: performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd || 0,
    load: performance.getEntriesByType('navigation')[0]?.loadEventEnd || 0
  };
})()`;

async function collectDashboardSample(
  client: CdpClient,
  recorder: BrowserRecorder,
  startIndex: number,
  startedAt: number,
  navigation: 'client' | 'reload'
): Promise<DashboardSample> {
  const visible = await waitForBrowserValue<{
    path: string;
    visible: boolean;
    failed: boolean;
    now: number;
    dcl: number;
    load: number;
  }>(
    client,
    dashboardStateExpression,
    (value) => value.path === '/dashboard' && (value.visible || value.failed)
  );
  if (visible.failed && !visible.visible)
    throw new Error('The dashboard displayed its error state.');
  const visibleTimestamp = await monotonicTimestamp(client);
  const measurementStartedAt =
    navigation === 'client' ? recorder.dashboardStartSince(startIndex, startedAt) : startedAt;
  const firstVisibleMs = (visibleTimestamp - measurementStartedAt) * 1_000;
  await delay(500);

  const traces = recorder.tracesSince(startIndex, measurementStartedAt);
  const requests: SanitizedRequest[] = traces.map((trace) => ({
    method: trace.method,
    url: trace.url,
    resourceType: trace.resourceType,
    status: trace.status,
    durationMs:
      trace.durationMs === undefined ? undefined : Math.round(trace.durationMs * 100) / 100,
    failed: trace.failed,
  }));
  const apiTraces = traces.filter((trace) => urlPath(trace.url).startsWith('/api/'));
  const revenue = apiTraces.find((trace) => urlPath(trace.url) === '/api/dashboard/revenue-chart');
  const revenueFinishedMs = revenue?.endTimestamp
    ? (revenue.endTimestamp - measurementStartedAt) * 1_000
    : null;

  return {
    navigation,
    firstVisibleMs: Math.round(firstVisibleMs * 100) / 100,
    domContentLoadedMs:
      navigation === 'reload' && visible.dcl ? Math.round(visible.dcl * 100) / 100 : null,
    loadMs: navigation === 'reload' && visible.load ? Math.round(visible.load * 100) / 100 : null,
    requestCount: requests.length,
    apiRequestCount: apiTraces.length,
    duplicateRequests: duplicateRequests(requests),
    requests,
    revenueChart: detectRevenueBlocking(
      firstVisibleMs,
      revenueFinishedMs,
      Boolean(revenue),
      Boolean(revenue?.failed)
    ),
  };
}

async function retainAuthenticationCookie(
  client: CdpClient,
  recorder: BrowserRecorder,
  targetUrl: string
): Promise<boolean> {
  const cookiesResponse = await client.send('Network.getAllCookies');
  const cookies = (cookiesResponse.cookies || []) as JsonRecord[];
  if (cookies.some((cookie) => cookie.name === 'df_access_token')) return true;

  const authRequest =
    recorder.latestRequest('/api/auth/login/verify') || recorder.latestRequest('/api/auth/login');
  if (!authRequest || authRequest.status !== 200 || !authRequest.endTimestamp) return false;
  try {
    const response = await client.send('Network.getResponseBody', {
      requestId: authRequest.requestId,
    });
    const parsed = JSON.parse(String(response.body || '{}')) as { access_token?: unknown };
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) return false;
    const origin = new URL(targetUrl).origin;
    const result = await client.send('Network.setCookie', {
      name: 'df_access_token',
      value: parsed.access_token,
      url: origin,
      path: '/',
      secure: origin.startsWith('https:'),
      sameSite: 'Lax',
    });
    return result.success === true;
  } catch {
    return false;
  }
}

function aggregateApiLatency(samples: DashboardSample[]): JsonRecord[] {
  const durations = new Map<string, number[]>();
  for (const sample of samples) {
    for (const request of sample.requests) {
      if (!urlPath(request.url).startsWith('/api/') || request.durationMs === undefined) continue;
      const key = `${request.method} ${urlPath(request.url)}`;
      const values = durations.get(key) || [];
      values.push(request.durationMs);
      durations.set(key, values);
    }
  }
  return [...durations.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([request, values]) => ({ request, ...summarize(values) }));
}

async function runBrowserBenchmark(target: FrontendTarget): Promise<JsonRecord> {
  const debugPort = await getFreePort();
  const profileDirectory = join(runDirectory, `chrome-${target.label}`);
  await mkdir(profileDirectory, { recursive: true });
  const chrome = startManaged('chrome', chromeExecutable(), [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    '--window-size=1440,900',
    'about:blank',
  ]);
  const client = await connectChrome(debugPort);
  const recorder = new BrowserRecorder(client, diagnosticSecrets);
  await Promise.all([
    client.send('Page.enable'),
    client.send('Network.enable'),
    client.send('Runtime.enable'),
    client.send('Log.enable'),
    client.send('Performance.enable'),
  ]);

  const diagnosticStart = recorder.diagnostics.length;
  try {
    await client.send('Page.navigate', { url: endpointUrl(target.url, '/login?next=/dashboard') });
    await waitForBrowserValue<boolean>(
      client,
      `Boolean(document.querySelector('#email') && document.querySelector('#password'))`,
      Boolean
    );

    if (!credentials) {
      await delay(250);
      const diagnostics = recorder.diagnostics.slice(diagnosticStart);
      return {
        status: 'skipped',
        reason: 'PERF_TEST_EMAIL and PERF_TEST_PASSWORD were not both supplied.',
        consoleErrors: diagnostics.filter(
          (entry) => entry.level === 'error' || entry.level === 'exception'
        ),
        hydrationErrors: diagnostics.filter((entry) =>
          /hydrat|mismatch|server rendered/i.test(entry.message)
        ),
      };
    }

    const coldStartIndex = recorder.requests.length;
    const coldStartedAt = await monotonicTimestamp(client);
    const loginResult = await submitLogin(
      client,
      credentials.email,
      credentials.password,
      credentials.totp
    );
    if (loginResult === 'two-factor-missing') {
      return {
        status: 'skipped',
        reason: 'The account requires two-factor authentication; set PERF_TEST_TOTP for this run.',
        consoleErrors: [],
        hydrationErrors: [],
      };
    }
    if (loginResult === 'failed') {
      return {
        status: 'failed',
        reason: 'The browser login did not reach the dashboard.',
        consoleErrors: [],
        hydrationErrors: [],
      };
    }

    const cold = await collectDashboardSample(
      client,
      recorder,
      coldStartIndex,
      coldStartedAt,
      'client'
    );
    const cookieRetained = await retainAuthenticationCookie(client, recorder, target.url);
    const warm: DashboardSample[] = [];
    let warmSkipReason: string | null = null;
    if (!cookieRetained) {
      warmSkipReason = 'Chrome did not retain an authentication cookie for page reloads.';
    } else {
      for (let index = 0; index < warmSamples; index += 1) {
        const startIndex = recorder.requests.length;
        const startedAt = await monotonicTimestamp(client);
        await client.send('Page.navigate', {
          url: endpointUrl(target.url, `/dashboard?__perf_sample=${index + 1}`),
        });
        warm.push(await collectDashboardSample(client, recorder, startIndex, startedAt, 'reload'));
      }
    }

    if (env.PERF_SCREENSHOTS === '1') {
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
      if (typeof screenshot.data === 'string') {
        await writeFile(
          join(runDirectory, `${target.label}-dashboard.png`),
          screenshot.data,
          'base64'
        );
      }
    }

    const diagnostics = recorder.diagnostics.slice(diagnosticStart);
    const allSamples = [cold, ...warm];
    await writeFile(
      join(runDirectory, `${target.label}-network-trace.json`),
      `${JSON.stringify(
        allSamples.map((sample) => sample.requests),
        null,
        2
      )}\n`,
      'utf8'
    );
    return {
      status: 'measured',
      cold,
      warm: warm.length
        ? {
            samples: warm.length,
            firstVisible: summarize(warm.map((sample) => sample.firstVisibleMs)),
            domContentLoaded: summarize(
              warm.flatMap((sample) =>
                sample.domContentLoadedMs === null ? [] : [sample.domContentLoadedMs]
              )
            ),
            load: summarize(
              warm.flatMap((sample) => (sample.loadMs === null ? [] : [sample.loadMs]))
            ),
            requestCount: summarize(warm.map((sample) => sample.requestCount)),
            apiRequestCount: summarize(warm.map((sample) => sample.apiRequestCount)),
            duplicateRequests: warm.map((sample, index) => ({
              sample: index + 1,
              requests: sample.duplicateRequests,
            })),
            revenueChart: warm.map((sample) => sample.revenueChart),
          }
        : { status: 'skipped', reason: warmSkipReason },
      apiLatency: {
        cold: aggregateApiLatency([cold]),
        warm: aggregateApiLatency(warm),
      },
      consoleErrors: diagnostics.filter(
        (entry) => entry.level === 'error' || entry.level === 'exception'
      ),
      hydrationErrors: diagnostics.filter((entry) =>
        /hydrat|mismatch|server rendered/i.test(entry.message)
      ),
    };
  } finally {
    client.close();
    await chrome.stop();
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

function metricLine(label: string, measurement: EndpointMeasurement): string {
  const cold = measurement.cold.valuesMs[0];
  const warm = measurement.warm;
  return `${label}: cold ${cold?.toFixed(2) ?? 'n/a'} ms; warm p50 ${warm.p50Ms?.toFixed(2) ?? 'n/a'} ms, p95 ${warm.p95Ms?.toFixed(2) ?? 'n/a'} ms`;
}

function renderMarkdown(report: JsonRecord): string {
  const backend = report.backend as JsonRecord;
  const health = backend.health as HealthMeasurement;
  const authentication = backend.authentication as JsonRecord;
  const frontends = report.frontends as JsonRecord[];
  const lines = [
    '# Performance smoke report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Commit: \`${(report.git as JsonRecord).commit}\``,
    `- Mode: \`${(report.configuration as JsonRecord).mode}\``,
    `- Warm samples: ${(report.configuration as JsonRecord).warmSamples}`,
    '',
    '## FastAPI',
    '',
    `- Service status: \`${health.serviceStatus}\``,
    `- Database status: \`${health.databaseStatus}\``,
    `- Health gate: **${health.healthGate.status}** — ${health.healthGate.reason}`,
    `- ${metricLine('/health endpoint TTFB', health)}`,
    `- Connected-database benchmark: ${
      health.databaseBenchmark.status === 'measured'
        ? metricLine('/health database probe TTFB', health.databaseBenchmark.measurement)
        : `${health.databaseBenchmark.status} — ${health.databaseBenchmark.reason}`
    }`,
    `- Authentication: ${authentication.status === 'skipped' ? authentication.reason : metricLine('/api/auth/login TTFB', authentication.measurement as EndpointMeasurement)}`,
    '',
    '## Frontends',
    '',
  ];
  for (const frontend of frontends) {
    lines.push(`### ${frontend.label}`, '');
    lines.push(`- Runtime: \`${frontend.runtime}\``);
    if (typeof frontend.startupMs === 'number')
      lines.push(`- Startup: ${frontend.startupMs.toFixed(2)} ms`);
    lines.push(`- ${metricLine('/login HTML TTFB', frontend.loginHtml as EndpointMeasurement)}`);
    const dashboard = frontend.dashboard as JsonRecord;
    if (dashboard.status !== 'measured') {
      lines.push(`- Dashboard: ${dashboard.status} — ${dashboard.reason}`);
    } else {
      const cold = dashboard.cold as DashboardSample;
      const warm = dashboard.warm as JsonRecord;
      lines.push(`- Dashboard cold first visible: ${cold.firstVisibleMs.toFixed(2)} ms`);
      if (warm.firstVisible) {
        const firstVisible = warm.firstVisible as NumericSummary;
        lines.push(
          `- Dashboard warm first visible: p50 ${firstVisible.p50Ms?.toFixed(2) ?? 'n/a'} ms, p95 ${firstVisible.p95Ms?.toFixed(2) ?? 'n/a'} ms`
        );
      } else {
        lines.push(`- Dashboard warm: skipped — ${warm.reason}`);
      }
      lines.push(
        `- Cold request count: ${cold.requestCount} (${cold.apiRequestCount} API); revenue chart: ${cold.revenueChart.status}`,
        `- Console errors: ${(dashboard.consoleErrors as unknown[]).length}; hydration errors: ${(dashboard.hydrationErrors as unknown[]).length}`
      );
    }
    lines.push('');
  }
  lines.push(
    'Cold means the first observation in the stated process/browser lifecycle. Warm percentiles use subsequent samples in that same lifecycle.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

async function benchmarkFrontend(target: FrontendTarget): Promise<JsonRecord> {
  log(`Benchmarking ${target.label} (${target.runtime})`);
  const loginHtml = await measureEndpoint(endpointUrl(target.url, '/login'));
  const dashboard = await runBrowserBenchmark(target);
  return {
    label: target.label,
    runtime: target.runtime,
    origin: sanitizeUrl(target.url),
    startupMs: target.startupMs,
    ...(target.buildMs === undefined ? {} : { buildMs: target.buildMs }),
    loginHtml,
    dashboard,
  };
}

async function main(): Promise<void> {
  await mkdir(runDirectory, { recursive: true });
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const gitBranch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' });
  const expectedBase = 'fa1538f76a05f9a90a7766e975e1e0a2871642e9';
  if (gitCommit.trim() !== expectedBase && env.PERF_ALLOW_DIFFERENT_COMMIT !== '1') {
    log(`Note: benchmarking commit ${gitCommit.trim()} (base was ${expectedBase}).`);
  }

  let apiUrl = env.PERF_API_URL?.replace(/\/$/, '') || '';
  let backendProcess: ManagedProcess | null = null;
  if (mode === 'local' && !apiUrl) {
    const apiPort = await getFreePort();
    apiUrl = `http://127.0.0.1:${apiPort}`;
    const python = env.PERF_PYTHON || resolve('.venv/bin/python');
    if (!existsSync(python)) {
      throw new Error(
        'Python environment not found. Run `bun run api:install` or set PERF_PYTHON.'
      );
    }
    backendProcess = startManaged(
      'fastapi',
      python,
      ['-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', String(apiPort)],
      { env }
    );
    await waitForPort(apiPort, backendProcess.child);
  }
  if (!apiUrl) throw new Error('PERF_API_URL is required in remote mode.');

  log('Benchmarking FastAPI /health');
  const health = await measureHealthEndpoint(endpointUrl(apiUrl, '/health'));
  const authentication: JsonRecord = credentials
    ? {
        status: 'measured',
        measurement: await measureEndpoint(endpointUrl(apiUrl, '/api/auth/login'), () => ({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: credentials.email, password: credentials.password }),
        })),
      }
    : {
        status: 'skipped',
        reason: 'PERF_TEST_EMAIL and PERF_TEST_PASSWORD were not both supplied.',
      };

  const frontends: JsonRecord[] = [];
  if (mode === 'remote') {
    const remoteUrl = env.PERF_NITRO_URL?.replace(/\/$/, '');
    if (!remoteUrl) throw new Error('PERF_NITRO_URL is required in remote mode.');
    frontends.push(
      await benchmarkFrontend({
        label: env.PERF_TARGET_LABEL || 'remote-production',
        runtime: 'remote-production',
        url: remoteUrl,
        startupMs: null,
      })
    );
  } else {
    const devPort = await getFreePort();
    const previewPort = await getFreePort();
    const corsOrigins = `http://127.0.0.1:${devPort},http://127.0.0.1:${previewPort}`;
    if (backendProcess) {
      await backendProcess.stop();
      const python = env.PERF_PYTHON || resolve('.venv/bin/python');
      backendProcess = startManaged(
        'fastapi',
        python,
        [
          '-m',
          'uvicorn',
          'backend.app.main:app',
          '--host',
          '127.0.0.1',
          '--port',
          new URL(apiUrl).port,
        ],
        { env: { ...env, CORS_ORIGINS: corsOrigins } }
      );
      await waitForPort(Number(new URL(apiUrl).port), backendProcess.child);
    }

    const frontendEnv = { ...env, NUXT_PUBLIC_API_BASE: apiUrl };
    const devStartedAt = performance.now();
    const dev = startManaged(
      'nuxt-development',
      resolve('node_modules/.bin/nuxt'),
      ['dev', '--host', '127.0.0.1', '--port', String(devPort)],
      { env: frontendEnv }
    );
    await waitForPort(devPort, dev.child);
    const devStartupMs = performance.now() - devStartedAt;
    frontends.push(
      await benchmarkFrontend({
        label: 'nuxt-development',
        runtime: 'nuxt-development',
        url: `http://127.0.0.1:${devPort}`,
        startupMs: devStartupMs,
      })
    );
    await dev.stop();

    const buildMs =
      env.PERF_SKIP_BUILD === '1'
        ? 0
        : await runChecked('Building optimized Nitro output', 'bun', ['run', 'build'], frontendEnv);
    if (!existsSync(resolve('.output/server/index.mjs'))) {
      throw new Error('Optimized Nitro output is missing; run without PERF_SKIP_BUILD.');
    }
    const previewStartedAt = performance.now();
    const preview = startManaged(
      'optimized-nitro-preview',
      env.PERF_NODE || 'node',
      [resolve('.output/server/index.mjs')],
      {
        env: {
          ...frontendEnv,
          HOST: '127.0.0.1',
          PORT: String(previewPort),
          NITRO_HOST: '127.0.0.1',
          NITRO_PORT: String(previewPort),
        },
      }
    );
    await waitForPort(previewPort, preview.child);
    const previewStartupMs = performance.now() - previewStartedAt;
    frontends.push(
      await benchmarkFrontend({
        label: 'optimized-nitro-preview',
        runtime: 'optimized-nitro-preview',
        url: `http://127.0.0.1:${previewPort}`,
        startupMs: previewStartupMs,
        buildMs,
      })
    );
    await preview.stop();
  }

  const report: JsonRecord = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    git: { commit: gitCommit.trim(), branch: gitBranch.trim() },
    configuration: {
      mode,
      warmSamples,
      credentialsSupplied: Boolean(credentials),
      screenshotsEnabled: env.PERF_SCREENSHOTS === '1',
    },
    backend: {
      origin: sanitizeUrl(apiUrl),
      health,
      authentication,
    },
    frontends,
  };
  await writeFile(
    join(runDirectory, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );
  await writeFile(join(runDirectory, 'report.md'), renderMarkdown(report), 'utf8');
  await writeFile(join(outputRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(outputRoot, 'latest.md'), renderMarkdown(report), 'utf8');

  log('Performance smoke complete.');
  log(
    `FastAPI health: service=${health.serviceStatus}; database=${health.databaseStatus}; gate=${health.healthGate.status}`
  );
  log(metricLine('FastAPI /health endpoint', health));
  if (health.databaseBenchmark.status === 'measured') {
    log(metricLine('FastAPI connected-database probe', health.databaseBenchmark.measurement));
  } else {
    log(
      `FastAPI connected-database probe: ${health.databaseBenchmark.status} — ${health.databaseBenchmark.reason}`
    );
  }
  for (const frontend of frontends) {
    log(metricLine(`${frontend.label} /login`, frontend.loginHtml as EndpointMeasurement));
    const dashboard = frontend.dashboard as JsonRecord;
    if (dashboard.status !== 'measured') log(`${frontend.label} dashboard: ${dashboard.status}`);
  }
  log(`Report: ${join('.perf', basename(runDirectory), 'report.md')}`);
  if (health.healthGate.status === 'failed') process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `Performance smoke failed: ${sanitizeDiagnostic(message, diagnosticSecrets)}\n`
  );
  process.exitCode = 1;
} finally {
  for (const managed of [...managedProcesses].reverse()) await managed.stop();
}
