import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
type CorsMode = 'cors' | 'no-cors' | 'same-origin';
type CredentialsMode = 'omit' | 'same-origin' | 'include';

type HeaderRow = {
  id: string;
  name: string;
  value: string;
};

type TestDraft = {
  url: string;
  method: HttpMethod;
  mode: CorsMode;
  credentials: CredentialsMode;
  contentType: string;
  body: string;
  timeoutMs: number;
  headers: HeaderRow[];
  allowedOrigins: string[];
  blockedOrigins: string[];
};

type SavedCase = TestDraft & {
  id: string;
  name: string;
  savedAt: string;
};

type TestResult = {
  id: string;
  label: string;
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'opaque';
  browserResult: string;
  statusCode?: number;
  statusText?: string;
  responseType?: ResponseType;
  responseUrl?: string;
  headers: Array<[string, string]>;
  bodyPreview?: string;
  error?: string;
  warnings: string[];
  diagnostics: string[];
  report: string;
};

type Scenario = {
  id: string;
  title: string;
  description: string;
  overrides: Partial<TestDraft>;
};

const STORAGE_KEY = 'cors-test-lab-cases-v1';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MODES: CorsMode[] = ['cors', 'no-cors', 'same-origin'];
const CREDENTIALS: CredentialsMode[] = ['omit', 'same-origin', 'include'];
const CONTENT_TYPES = [
  { label: 'None', value: '' },
  { label: 'JSON', value: 'application/json' },
  { label: 'Text', value: 'text/plain' },
  { label: 'Form URL encoded', value: 'application/x-www-form-urlencoded' },
  { label: 'Multipart form', value: 'multipart/form-data' },
];

const defaultDraft: TestDraft = {
  url: '',
  method: 'GET',
  mode: 'cors',
  credentials: 'omit',
  contentType: '',
  body: '',
  timeoutMs: 12000,
  headers: [{ id: crypto.randomUUID(), name: '', value: '' }],
  allowedOrigins: [],
  blockedOrigins: [],
};

const scenarios: Scenario[] = [
  {
    id: 'simple-get',
    title: 'Simple GET',
    description: 'Checks the common no-preflight read path.',
    overrides: { method: 'GET', mode: 'cors', credentials: 'omit', body: '', contentType: '' },
  },
  {
    id: 'json-post',
    title: 'JSON POST',
    description: 'Forces a preflight through application/json.',
    overrides: {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      contentType: 'application/json',
      body: '{\n  "cors": true\n}',
    },
  },
  {
    id: 'credentials',
    title: 'Credentials',
    description: 'Tests cookies/auth across origins.',
    overrides: { method: 'GET', mode: 'cors', credentials: 'include', body: '', contentType: '' },
  },
  {
    id: 'custom-header',
    title: 'Custom header',
    description: 'Validates Access-Control-Allow-Headers.',
    overrides: {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      body: '',
      contentType: '',
      headers: [{ id: crypto.randomUUID(), name: 'X-CORS-Test', value: '1' }],
    },
  },
  {
    id: 'delete',
    title: 'DELETE',
    description: 'Validates allowed non-simple methods.',
    overrides: { method: 'DELETE', mode: 'cors', credentials: 'omit', body: '', contentType: '' },
  },
  {
    id: 'opaque',
    title: 'No-CORS probe',
    description: 'Confirms the browser can send but not read.',
    overrides: { method: 'GET', mode: 'no-cors', credentials: 'omit', body: '', contentType: '' },
  },
];

const forbiddenHeaders = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

function isForbiddenHeader(name: string) {
  const lower = name.toLowerCase();
  return forbiddenHeaders.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-');
}

function isSimpleContentType(value: string) {
  const normalized = value.split(';')[0].trim().toLowerCase();
  return ['', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].includes(normalized);
}

function isSafelistedHeader(name: string, value: string) {
  const lower = name.toLowerCase();
  if (['accept', 'accept-language', 'content-language'].includes(lower)) {
    return true;
  }
  if (lower === 'content-type') {
    return isSimpleContentType(value);
  }
  return false;
}

function expectsPreflight(draft: TestDraft, appliedHeaders: Array<[string, string]>) {
  const simpleMethod = ['GET', 'HEAD', 'POST'].includes(draft.method);
  const hasNonSimpleHeader = appliedHeaders.some(([name, value]) => !isSafelistedHeader(name, value));
  const hasNonSimpleContentType = draft.contentType ? !isSimpleContentType(draft.contentType) : false;
  return draft.mode === 'cors' && (!simpleMethod || hasNonSimpleHeader || hasNonSimpleContentType);
}

function buildHeaders(draft: TestDraft) {
  const warnings: string[] = [];
  const applied: Array<[string, string]> = [];
  const names = new Set<string>();

  draft.headers.forEach((header) => {
    const name = header.name.trim();
    const value = header.value.trim();
    if (!name || !value) {
      return;
    }
    if (isForbiddenHeader(name)) {
      if (name.toLowerCase() === 'origin') {
        warnings.push('The Origin header was skipped. Browser JavaScript cannot spoof Origin; it always uses the page origin.');
      } else {
        warnings.push(`Browser-managed header "${name}" was skipped because Fetch cannot set it.`);
      }
      return;
    }
    names.add(name.toLowerCase());
    applied.push([name, value]);
  });

  const canHaveBody = !['GET', 'HEAD'].includes(draft.method);
  if (canHaveBody && draft.contentType && draft.body.trim() && !names.has('content-type')) {
    applied.push(['Content-Type', draft.contentType]);
  }

  return { applied, warnings };
}

function parseTargetUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function getOriginLabel() {
  if (window.location.origin === 'null') {
    return 'local file or sandboxed origin';
  }
  return window.location.origin;
}

function cleanOriginList(origins: unknown) {
  if (!Array.isArray(origins)) {
    return [];
  }
  return origins
    .filter((origin): origin is string => typeof origin === 'string')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function originLines(origins: string[]) {
  return origins.join('\n');
}

function parseOriginLines(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function originKey(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return value.trim();
  }
}

function uniqueOriginKeys(origins: string[]) {
  return new Set(origins.map(originKey).filter(Boolean));
}

function formatOriginList(origins: string[]) {
  return origins.length ? origins.map((origin) => `  - ${origin}`).join('\n') : '  (none)';
}

function makeDiagnostics(
  draft: TestDraft,
  result: Pick<TestResult, 'status' | 'responseType' | 'statusCode' | 'error'>,
  appliedHeaders: Array<[string, string]>,
) {
  const diagnostics: string[] = [];
  const target = parseTargetUrl(draft.url);
  const preflight = expectsPreflight(draft, appliedHeaders);
  const currentOrigin = getOriginLabel();
  const currentOriginKey = originKey(window.location.origin);
  const allowedOriginKeys = uniqueOriginKeys(draft.allowedOrigins);
  const blockedOriginKeys = uniqueOriginKeys(draft.blockedOrigins);
  const expectsCurrentAllowed = allowedOriginKeys.has(currentOriginKey);
  const expectsCurrentBlocked = blockedOriginKeys.has(currentOriginKey);

  if (!target) {
    diagnostics.push('The URL is not valid. Use an absolute http:// or https:// API URL.');
    return diagnostics;
  }

  if (window.location.protocol === 'https:' && target.protocol === 'http:') {
    diagnostics.push('This is mixed content: an HTTPS page cannot safely call an HTTP API in modern browsers.');
  }

  if (draft.mode === 'same-origin' && target.origin !== window.location.origin) {
    diagnostics.push('same-origin mode rejects cross-origin URLs before a CORS exchange can complete.');
  }

  if (draft.mode === 'no-cors') {
    diagnostics.push('no-cors mode creates an opaque response. The request may be sent, but status, headers, and body are intentionally hidden.');
  }

  if (draft.credentials === 'include') {
    diagnostics.push('Credentialed CORS requires a specific Access-Control-Allow-Origin value and Access-Control-Allow-Credentials: true. Wildcard origins are not allowed.');
  }

  if (draft.allowedOrigins.length || draft.blockedOrigins.length) {
    diagnostics.push(`Domain policy expectations are recorded for this case, but this browser run only tests the actual page origin: ${currentOrigin}.`);
  }

  if (expectsCurrentAllowed && expectsCurrentBlocked) {
    diagnostics.push('The current page origin is listed as both expected allowed and expected blocked. Clean up the policy lists before using this case as evidence.');
  } else if (expectsCurrentAllowed) {
    diagnostics.push('The current page origin is listed as expected allowed for this API.');
  } else if (expectsCurrentBlocked) {
    diagnostics.push('The current page origin is listed as expected blocked for this API.');
  }

  if (preflight) {
    diagnostics.push('This request should trigger a browser preflight because it uses a non-simple method, header, or content type.');
  } else if (draft.mode === 'cors') {
    diagnostics.push('This request is shaped like a simple CORS request and may avoid preflight.');
  }

  if (result.status === 'failed') {
    diagnostics.push('The browser blocked or failed the fetch before JavaScript could read the response. Common causes are missing CORS headers, failed preflight, TLS/DNS/network failure, blocked redirect, or mixed content.');
    if (preflight) {
      diagnostics.push('Check that OPTIONS responds with the requested method and headers in Access-Control-Allow-Methods and Access-Control-Allow-Headers.');
    }
    if (expectsCurrentAllowed && !expectsCurrentBlocked) {
      diagnostics.push('Policy mismatch: this origin is expected allowed, but the browser test failed.');
    }
  }

  if (result.status === 'passed') {
    diagnostics.push('JavaScript could read the response, so the browser accepted the CORS policy for this request.');
    diagnostics.push('Only safelisted response headers and headers named in Access-Control-Expose-Headers are visible here.');
    if (expectsCurrentBlocked && !expectsCurrentAllowed) {
      diagnostics.push('Policy mismatch: this origin is expected blocked, but the browser test passed.');
    }
  }

  if (result.responseType === 'opaque') {
    diagnostics.push('Opaque responses always show status 0 and no readable headers or body by design.');
  }

  if (typeof result.statusCode === 'number' && result.statusCode >= 400) {
    diagnostics.push('CORS passed, but the API returned an HTTP error status. Debug the application response separately from CORS.');
  }

  if (draft.allowedOrigins.some((origin) => originKey(origin) !== currentOriginKey) || draft.blockedOrigins.some((origin) => originKey(origin) !== currentOriginKey)) {
    diagnostics.push('To truly verify another domain, open this same static app or a small test page from that domain. A browser app cannot set Origin for domain A while running on domain B.');
  }

  return diagnostics;
}

function makeReport(draft: TestDraft, result: Omit<TestResult, 'report'>, appliedHeaders: Array<[string, string]>) {
  const headerLines = appliedHeaders.length
    ? appliedHeaders.map(([name, value]) => `  ${name}: ${value}`).join('\n')
    : '  (none)';
  const responseHeaderLines = result.headers.length
    ? result.headers.map(([name, value]) => `  ${name}: ${value}`).join('\n')
    : '  (none visible)';
  const diagnostics = result.diagnostics.map((item) => `- ${item}`).join('\n');

  return [
    'CORS Test Lab report',
    `Generated: ${new Date().toISOString()}`,
    `Tester origin: ${getOriginLabel()}`,
    '',
    'Request',
    `  URL: ${draft.url}`,
    `  Method: ${draft.method}`,
    `  Mode: ${draft.mode}`,
    `  Credentials: ${draft.credentials}`,
    `  Preflight expected: ${expectsPreflight(draft, appliedHeaders) ? 'yes' : 'no'}`,
    '  Headers:',
    headerLines,
    draft.body.trim() ? `  Body: ${draft.body}` : '  Body: (empty)',
    '',
    'Domain policy expectations',
    `  Actual browser origin: ${getOriginLabel()}`,
    '  Expected allowed origins:',
    formatOriginList(draft.allowedOrigins),
    '  Expected blocked origins:',
    formatOriginList(draft.blockedOrigins),
    '',
    'Result',
    `  Status: ${result.status}`,
    `  Browser result: ${result.browserResult}`,
    `  HTTP status: ${result.statusCode ?? 'not readable'}`,
    `  Response type: ${result.responseType ?? 'not available'}`,
    `  Duration: ${result.durationMs}ms`,
    result.error ? `  Error: ${result.error}` : '',
    '',
    'Visible response headers',
    responseHeaderLines,
    '',
    'Diagnostics',
    diagnostics || '- No diagnostics generated.',
  ]
    .filter(Boolean)
    .join('\n');
}

function emptyHeader(): HeaderRow {
  return { id: crypto.randomUUID(), name: '', value: '' };
}

function normalizedDraft(draft: TestDraft): TestDraft {
  return {
    ...draft,
    timeoutMs: Number.isFinite(draft.timeoutMs) ? Math.max(1000, draft.timeoutMs) : 12000,
    headers: draft.headers.length ? draft.headers : [emptyHeader()],
    allowedOrigins: cleanOriginList(draft.allowedOrigins),
    blockedOrigins: cleanOriginList(draft.blockedOrigins),
  };
}

export default function App() {
  const [draft, setDraft] = useState<TestDraft>(defaultDraft);
  const [caseName, setCaseName] = useState('');
  const [savedCases, setSavedCases] = useState<SavedCase[]>([]);
  const [results, setResults] = useState<TestResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return;
    }
    try {
      const parsed = JSON.parse(stored) as SavedCase[];
      if (Array.isArray(parsed)) {
        setSavedCases(
          parsed.map((item) => ({
            ...normalizedDraft(item),
            id: item.id || crypto.randomUUID(),
            name: item.name || `${item.method} ${item.url}`,
            savedAt: item.savedAt || new Date().toISOString(),
          })),
        );
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(savedCases));
  }, [savedCases]);

  const headerSummary = useMemo(() => buildHeaders(draft), [draft]);
  const preflightExpected = useMemo(
    () => expectsPreflight(draft, headerSummary.applied),
    [draft, headerSummary.applied],
  );

  const latestResult = results[0];

  function patchDraft(patch: Partial<TestDraft>) {
    setDraft((current) => normalizedDraft({ ...current, ...patch }));
  }

  function updateHeader(id: string, field: 'name' | 'value', value: string) {
    setDraft((current) => ({
      ...current,
      headers: current.headers.map((header) =>
        header.id === id ? { ...header, [field]: value } : header,
      ),
    }));
  }

  function removeHeader(id: string) {
    setDraft((current) => ({
      ...current,
      headers: current.headers.length === 1 ? [emptyHeader()] : current.headers.filter((header) => header.id !== id),
    }));
  }

  async function runTest(overrides: Partial<TestDraft> = {}, label = 'Manual test') {
    const nextDraft = normalizedDraft({ ...draft, ...overrides });
    setDraft(nextDraft);
    setIsRunning(true);

    const started = performance.now();
    const startedAt = new Date().toISOString();
    const { applied, warnings } = buildHeaders(nextDraft);
    const headers = new Headers(applied);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), nextDraft.timeoutMs);
    const canHaveBody = !['GET', 'HEAD'].includes(nextDraft.method);

    try {
      if (!parseTargetUrl(nextDraft.url)) {
        throw new Error('Invalid URL. Enter an absolute http:// or https:// API URL.');
      }

      const response = await fetch(nextDraft.url, {
        method: nextDraft.method,
        mode: nextDraft.mode,
        credentials: nextDraft.credentials,
        redirect: 'follow',
        headers,
        body: canHaveBody && nextDraft.body.trim() ? nextDraft.body : undefined,
        signal: controller.signal,
      });

      let bodyPreview = '';
      try {
        bodyPreview = await response.text();
      } catch (error) {
        bodyPreview = error instanceof Error ? `Body is not readable: ${error.message}` : 'Body is not readable.';
      }

      const elapsed = Math.round(performance.now() - started);
      const responseHeaders = Array.from(response.headers.entries());
      const status: TestResult['status'] = response.type === 'opaque' ? 'opaque' : 'passed';
      const draftResult = {
        id: crypto.randomUUID(),
        label,
        startedAt,
        durationMs: elapsed,
        status,
        browserResult: response.type === 'opaque' ? 'Opaque no-cors response' : 'Readable response',
        statusCode: response.type === 'opaque' ? undefined : response.status,
        statusText: response.type === 'opaque' ? undefined : response.statusText,
        responseType: response.type,
        responseUrl: response.url,
        headers: responseHeaders,
        bodyPreview: bodyPreview.slice(0, 6000),
        warnings,
        diagnostics: [] as string[],
      };
      const diagnostics = makeDiagnostics(nextDraft, draftResult, applied);
      const complete = { ...draftResult, diagnostics };
      const report = makeReport(nextDraft, complete, applied);
      setResults((current) => [{ ...complete, report }, ...current].slice(0, 20));
    } catch (error) {
      const elapsed = Math.round(performance.now() - started);
      const message =
        error instanceof DOMException && error.name === 'AbortError'
          ? `Timed out after ${nextDraft.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : 'Unknown fetch error';
      const draftResult = {
        id: crypto.randomUUID(),
        label,
        startedAt,
        durationMs: elapsed,
        status: 'failed' as const,
        browserResult: 'Fetch failed before JavaScript could read the response',
        headers: [] as Array<[string, string]>,
        error: message,
        warnings,
        diagnostics: [] as string[],
      };
      const diagnostics = makeDiagnostics(nextDraft, draftResult, applied);
      const complete = { ...draftResult, diagnostics };
      const report = makeReport(nextDraft, complete, applied);
      setResults((current) => [{ ...complete, report }, ...current].slice(0, 20));
    } finally {
      window.clearTimeout(timeout);
      setIsRunning(false);
    }
  }

  function saveCase() {
    const name = caseName.trim() || `${draft.method} ${draft.url || 'Untitled API'}`;
    const saved: SavedCase = {
      ...normalizedDraft(draft),
      id: crypto.randomUUID(),
      name,
      savedAt: new Date().toISOString(),
    };
    setSavedCases((current) => [saved, ...current]);
    setCaseName('');
  }

  function loadCase(saved: SavedCase) {
    const { id: _id, name: _name, savedAt: _savedAt, ...caseDraft } = saved;
    setDraft(normalizedDraft(caseDraft));
  }

  function exportCases() {
    const blob = new Blob([JSON.stringify(savedCases, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = 'cors-test-cases.json';
    link.click();
    URL.revokeObjectURL(href);
  }

  async function importCases(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as SavedCase[];
      if (!Array.isArray(parsed)) {
        throw new Error('Import file must contain an array of saved cases.');
      }
      const sanitized = parsed.map((item) => ({
        ...normalizedDraft(item),
        id: item.id || crypto.randomUUID(),
        name: item.name || `${item.method} ${item.url}`,
        savedAt: item.savedAt || new Date().toISOString(),
      }));
      setSavedCases((current) => [...sanitized, ...current]);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not import cases.');
    } finally {
      event.target.value = '';
    }
  }

  async function copyReport(result: TestResult) {
    await navigator.clipboard.writeText(result.report);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Browser CORS tester</p>
          <h1>CORS Test Lab</h1>
        </div>
        <div className="origin-badge">
          <span>Actual origin</span>
          <strong>{getOriginLabel()}</strong>
        </div>
      </header>

      <section className="workspace">
        <div className="tester-card">
          <div className="card-heading">
            <h2>Test an API endpoint</h2>
            <p>Run a real browser request from the origin shown above. The app cannot spoof the Origin header.</p>
          </div>

          <div className="url-row">
            <label className="field">
              <span>API URL</span>
              <input
                value={draft.url}
                onChange={(event) => patchDraft({ url: event.target.value })}
                placeholder="https://api.example.com/v1/resource"
                inputMode="url"
              />
            </label>
            <button className="primary run-button" disabled={isRunning} onClick={() => void runTest()}>
              {isRunning ? 'Running...' : 'Run test'}
            </button>
          </div>

          <div className="request-grid">
            <label className="field">
              <span>Method</span>
              <select value={draft.method} onChange={(event) => patchDraft({ method: event.target.value as HttpMethod })}>
                {METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Mode</span>
              <select value={draft.mode} onChange={(event) => patchDraft({ mode: event.target.value as CorsMode })}>
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Credentials</span>
              <select
                value={draft.credentials}
                onChange={(event) => patchDraft({ credentials: event.target.value as CredentialsMode })}
              >
                {CREDENTIALS.map((credentials) => (
                  <option key={credentials} value={credentials}>
                    {credentials}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Timeout</span>
              <input
                type="number"
                min="1000"
                step="500"
                value={draft.timeoutMs}
                onChange={(event) => patchDraft({ timeoutMs: Number(event.target.value) })}
              />
            </label>
          </div>

          <div className="summary-strip">
            <span className={preflightExpected ? 'pill warning' : 'pill ok'}>
              {preflightExpected ? 'Preflight expected' : 'Simple request shape'}
            </span>
            <span className="pill">Mode: {draft.mode}</span>
            <span className="pill">Credentials: {draft.credentials}</span>
          </div>

          <div className="quick-probes">
            <div>
              <h3>Quick probes</h3>
              <p>Use the same URL with common CORS shapes.</p>
            </div>
            <div className="probe-list">
              {scenarios.map((scenario) => (
                <button
                  className="probe-chip"
                  key={scenario.id}
                  disabled={isRunning}
                  onClick={() => void runTest(scenario.overrides, scenario.title)}
                  title={scenario.description}
                >
                  {scenario.title}
                </button>
              ))}
            </div>
          </div>

          <details className="details-panel">
            <summary>Request details</summary>
            <div className="details-body">
              <div className="section-subhead">
                <h3>Headers</h3>
                <button className="ghost" onClick={() => patchDraft({ headers: [...draft.headers, emptyHeader()] })}>
                  Add header
                </button>
              </div>
              <div className="headers-list">
                {draft.headers.map((header) => (
                  <div className="header-row" key={header.id}>
                    <input
                      value={header.name}
                      onChange={(event) => updateHeader(header.id, 'name', event.target.value)}
                      placeholder="Header name"
                    />
                    <input
                      value={header.value}
                      onChange={(event) => updateHeader(header.id, 'value', event.target.value)}
                      placeholder="Value"
                    />
                    <button className="icon-button" aria-label="Remove header" onClick={() => removeHeader(header.id)}>
                      x
                    </button>
                  </div>
                ))}
              </div>

              <div className="body-grid">
                <label className="field">
                  <span>Content type</span>
                  <select value={draft.contentType} onChange={(event) => patchDraft({ contentType: event.target.value })}>
                    {CONTENT_TYPES.map((contentType) => (
                      <option key={contentType.value} value={contentType.value}>
                        {contentType.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field field-body">
                  <span>Body</span>
                  <textarea
                    value={draft.body}
                    onChange={(event) => patchDraft({ body: event.target.value })}
                    placeholder='{"example": true}'
                    spellCheck={false}
                  />
                </label>
              </div>
            </div>
          </details>

          <details className="details-panel">
            <summary>Domain policy notes</summary>
            <div className="details-body">
              <div className="policy-origin">
                <span>Actual browser origin</span>
                <strong>{getOriginLabel()}</strong>
              </div>
              <p className="policy-note">
                Add expected allowed or blocked origins for your report. This is not a spoofed test; to verify another
                domain, run this app from that domain.
              </p>
              <div className="policy-grid">
                <label className="field policy-field">
                  <span>Expected allowed origins</span>
                  <textarea
                    className="origin-textarea"
                    value={originLines(draft.allowedOrigins)}
                    onChange={(event) => patchDraft({ allowedOrigins: parseOriginLines(event.target.value) })}
                    placeholder={'https://app.example.com\nhttps://admin.example.com'}
                    spellCheck={false}
                  />
                </label>
                <label className="field policy-field">
                  <span>Expected blocked origins</span>
                  <textarea
                    className="origin-textarea"
                    value={originLines(draft.blockedOrigins)}
                    onChange={(event) => patchDraft({ blockedOrigins: parseOriginLines(event.target.value) })}
                    placeholder={'https://unknown.example.com\nhttps://staging.example.net'}
                    spellCheck={false}
                  />
                </label>
              </div>
            </div>
          </details>

          <details className="details-panel">
            <summary>Saved cases</summary>
            <div className="details-body">
              <div className="save-row">
                <input value={caseName} onChange={(event) => setCaseName(event.target.value)} placeholder="Case name" />
                <button className="secondary" onClick={saveCase}>
                  Save
                </button>
              </div>
              <div className="saved-actions">
                <button className="ghost" disabled={!savedCases.length} onClick={exportCases}>
                  Export JSON
                </button>
                <button className="ghost" onClick={() => fileInputRef.current?.click()}>
                  Import JSON
                </button>
              </div>
              <input ref={fileInputRef} hidden type="file" accept="application/json" onChange={(event) => void importCases(event)} />
              <div className="saved-list">
                {savedCases.length === 0 ? (
                  <p className="muted">No saved cases yet.</p>
                ) : (
                  savedCases.map((saved) => (
                    <div className="saved-item" key={saved.id}>
                      <button onClick={() => loadCase(saved)}>
                        <strong>{saved.name}</strong>
                        <span>
                          {saved.method} {saved.url || 'No URL'}
                        </span>
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Delete ${saved.name}`}
                        onClick={() => setSavedCases((current) => current.filter((item) => item.id !== saved.id))}
                      >
                        x
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </details>
        </div>

        <div className="result-panel">
          <div className="card-heading result-heading">
            <div>
              <h2>Result</h2>
              <p>{latestResult ? latestResult.label : 'Run a test to see browser evidence and diagnostics.'}</p>
            </div>
            {latestResult ? (
              <button className="secondary" onClick={() => void copyReport(latestResult)}>
                Copy report
              </button>
            ) : null}
          </div>

          {!latestResult ? (
            <div className="empty-state">
              <strong>Ready to test an API.</strong>
              <span>Enter a URL or run one of the probes after adding your endpoint.</span>
            </div>
          ) : (
            <>
              <div className="result-summary">
                <span className={`big-status ${latestResult.status}`}>{latestResult.status}</span>
                <div>
                  <strong>{latestResult.browserResult}</strong>
                  <span>{latestResult.durationMs}ms</span>
                </div>
              </div>

              <div className="result-meta">
                <span>HTTP: {latestResult.statusCode ? `${latestResult.statusCode} ${latestResult.statusText ?? ''}` : 'not readable'}</span>
                <span>Type: {latestResult.responseType ?? 'not available'}</span>
                <span>Origin: {getOriginLabel()}</span>
              </div>

              {latestResult.error ? <div className="alert danger">{latestResult.error}</div> : null}
              {latestResult.warnings.map((warning) => (
                <div className="alert warning" key={warning}>
                  {warning}
                </div>
              ))}

              <div className="detail-grid">
                <div>
                  <h3>Visible headers</h3>
                  {latestResult.headers.length ? (
                    <pre>{latestResult.headers.map(([name, value]) => `${name}: ${value}`).join('\n')}</pre>
                  ) : (
                    <p className="muted">No response headers are visible to JavaScript.</p>
                  )}
                </div>
                <div>
                  <h3>Body preview</h3>
                  {latestResult.bodyPreview ? <pre>{latestResult.bodyPreview}</pre> : <p className="muted">No readable body.</p>}
                </div>
              </div>
            </>
          )}

          <div className="analysis-block">
            <h3>Diagnostics</h3>
            {latestResult ? (
              <ul className="diagnostics-list">
                {latestResult.diagnostics.map((diagnostic) => (
                  <li key={diagnostic}>{diagnostic}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Diagnostics appear after a run.</p>
            )}
          </div>

          <div className="history">
            <h3>Run history</h3>
            {results.length === 0 ? (
              <p className="muted">No history yet.</p>
            ) : (
              results.map((result) => (
                <button className="history-row" key={result.id} onClick={() => setResults((current) => [result, ...current.filter((item) => item.id !== result.id)])}>
                  <span className={`dot ${result.status}`} />
                  <strong>{result.label}</strong>
                  <span>{new Date(result.startedAt).toLocaleTimeString()}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
