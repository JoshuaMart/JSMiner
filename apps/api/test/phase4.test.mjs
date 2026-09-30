import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { JSLUICE_VERSION, OFFLINE_VERSION } from '@jsminer/adapters';
import { validateContract } from '@jsminer/contracts';
import { AnalysisEngine } from '../dist/analysis.js';
import { buildApp } from '../dist/app.js';
import { capture, isPublicAddress } from '../dist/capture.js';
import { parseConfig } from '../dist/config.js';
import { openMetadataStore } from '../dist/storage.js';

const raw = {
  database: ':memory:',
  tokens: [{ sha256: 'a'.repeat(64), project_id: 'p', permissions: ['analysis:write'] }],
};
const signal = () => new AbortController().signal;
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const done = (extra = {}) => ({
  type: 'done',
  version: JSLUICE_VERSION,
  truncated: false,
  secrets_truncated: false,
  syntax_error: false,
  ...extra,
});
const result = (records = [done()]) => ({
  status: 'success',
  version: JSLUICE_VERSION,
  durationMs: 1,
  errorCode: null,
  output: Buffer.from(records.map(JSON.stringify).join('\n')),
});
const endpoint = (url = '/api/test') => ({
  type: 'endpoint',
  url,
  method: 'GET',
  kind: 'fetch',
  query_params: [],
  body_params: [],
});
const offline = (modules = [], overrides = {}) => ({
  status: 'success',
  version: OFFLINE_VERSION,
  durationMs: 1,
  errorCode: null,
  output: Buffer.from(
    JSON.stringify({
      modules: modules.map((content) => ({
        path: 'bundle.js',
        content: Buffer.from(content).toString('base64'),
      })),
      findings: [],
      partial: false,
      reasons: [],
      error_code: null,
      ...overrides,
    }),
  ),
});
function worker(fn = () => result()) {
  return {
    healthy: true,
    calls: 0,
    identity: 'fixture-image-v1',
    async pin() {
      return { identity: this.identity, worker: this };
    },
    async run(input) {
      this.calls++;
      return fn(input, this.calls);
    },
  };
}
function setup(t, workers = { jsluice: worker() }, overrides = {}, options = {}) {
  const config = parseConfig({ ...raw, ...overrides });
  const db = openMetadataStore(config.database);
  const engine = new AnalysisEngine(config, db.database, { workers, ...options });
  t.after(async () => {
    await engine.close();
    db.close();
  });
  return { engine, config, db: db.database, workers };
}
async function analyze(engine, request = {}, project = 'p') {
  const output = await engine.analyze(
    project,
    { content: 'const x = 1;', tools: ['jsluice'], ...request },
    signal(),
  );
  assert.equal(validateContract('AnalyzeResponse', output).ok, true, JSON.stringify(output));
  return output;
}
async function server(t, respond) {
  const requests = [];
  const http = createServer((req, res) => {
    requests.push(req.url);
    respond(req, res);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        http.close(resolve);
        http.closeAllConnections();
      }),
  );
  return { origin: `http://127.0.0.1:${http.address().port}`, requests };
}
const originConfig = (origin, extra = {}) =>
  parseConfig({ ...raw, capture: { origins: [{ origin, allow_private: true }] }, ...extra });
const rejects = (promise, status, code) =>
  assert.rejects(promise, (e) => e.status === status && e.code === code);

test('Private URL capture requires an exact-origin opt-in', async (t) => {
  const { origin, requests } = await server(t, (_req, res) => res.end('const x = 1;'));
  await rejects(
    capture(`${origin}/x`, parseConfig(raw), signal(), 1000),
    403,
    'destination_denied',
  );
  await rejects(
    capture(
      `${origin}/x`,
      parseConfig({ ...raw, capture: { origins: [{ origin }] } }),
      signal(),
      1000,
    ),
    403,
    'destination_denied',
  );
  await rejects(
    capture(`${origin}/x`, originConfig('http://127.0.0.1:1'), signal(), 1000),
    403,
    'destination_denied',
  );
  assert.deepEqual(requests, []);
  assert.equal(
    (await capture(`${origin}/x`, originConfig(origin), signal(), 1000)).toString(),
    'const x = 1;',
  );
  assert.throws(() => originConfig(`${origin}/path`));
  assert.throws(() => originConfig('file:///tmp/example'));
  assert.throws(() => originConfig('http://name:password@localhost'));
  assert.throws(() =>
    parseConfig({ ...raw, capture: { origins: [{ origin }, { origin: `${origin}/` }] } }),
  );
});

test('public address policy rejects local, metadata, mapped and transition ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.1.1',
    '192.168.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    'fc00::1',
    'fe80::1',
    '2002:7f00:1::',
    '2001:db8::1',
    '2001::1',
    'invalid',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(address), true, address);
});

test('capture refuses redirect, remote errors, markup, invalid UTF-8, empty and invalid encodings', async (t) => {
  const routes = {
    '/redirect': [302, { location: '/target' }, 'redirect'],
    '/missing': [404, {}, 'missing'],
    '/html': [200, { 'content-type': 'text/html' }, 'const text = 1;'],
    '/xml': [200, { 'content-type': 'application/xhtml+xml' }, 'const text = 1;'],
    '/markup': [200, {}, '\ufeff \r\n<html>error</html>'],
    '/empty': [200, {}, '  '],
    '/utf8': [200, {}, Buffer.from([0xff])],
    '/charset': [200, { 'content-type': 'text/javascript; charset=iso-8859-1' }, 'const x = 1;'],
    '/encoding': [200, { 'content-encoding': 'compress' }, 'bad'],
    '/gzip': [200, { 'content-encoding': 'gzip' }, 'not-gzip'],
  };
  const { origin, requests } = await server(t, (req, res) => {
    const [code, headers, content] = routes[req.url];
    res.writeHead(code, headers);
    res.end(content);
  });
  const config = originConfig(origin);
  for (const path of Object.keys(routes))
    await rejects(
      capture(origin + path, config, signal(), 1000),
      ['/redirect', '/missing', '/encoding', '/gzip'].includes(path) ? 502 : 422,
      ['/redirect', '/missing'].includes(path)
        ? 'capture_status'
        : path === '/encoding'
          ? 'capture_encoding'
          : path === '/gzip'
            ? 'capture_failed'
            : 'invalid_content',
    );
  assert.equal(requests.includes('/target'), false);
});

test('capture preserves decompressed BOM and CRLF bytes with gzip, deflate, Brotli and atypical MIME', async (t) => {
  const content = Buffer.from('\ufeffconst été = "🥐";\r\n');
  const { origin } = await server(t, (req, res) => {
    const encoding = req.url.slice(1);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-encoding', encoding);
    res.end({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }[encoding](content));
  });
  for (const encoding of ['gzip', 'deflate', 'br'])
    assert.deepEqual(
      await capture(`${origin}/${encoding}`, originConfig(origin), signal(), 1000),
      content,
    );
});

test('wire and decoded caps apply to chunked bodies and compression expansion', async (t) => {
  const { origin } = await server(t, (req, res) => {
    if (req.url === '/compressed') {
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipSync('x'.repeat(10000)));
    } else {
      res.write('x'.repeat(80));
      res.end('x'.repeat(80));
    }
  });
  const wireConfig = parseConfig({
    ...raw,
    capture: { origins: [{ origin, allow_private: true }], wire_bytes: 100 },
  });
  await rejects(capture(`${origin}/chunked`, wireConfig, signal(), 1000), 413, 'capture_too_large');
  await rejects(
    capture(
      `${origin}/compressed`,
      originConfig(origin, { budgets: { script_bytes: 100 } }),
      signal(),
      1000,
    ),
    413,
    'script_too_large',
  );
});

test('capture timeout, truncated transfer and abort terminate acquisition without calling workers', async (t) => {
  const { origin } = await server(t, (req, res) => {
    if (req.url === '/truncated') {
      res.writeHead(200, { 'content-length': '100' });
      res.flushHeaders();
      res.write('x');
      setImmediate(() => res.destroy());
    }
  });
  await rejects(
    capture(`${origin}/truncated`, originConfig(origin), signal(), 1000),
    502,
    'capture_failed',
  );
  const w = worker();
  const { engine } = setup(
    t,
    { jsluice: w },
    { capture: { origins: [{ origin, allow_private: true }] }, budgets: { capture_ms: 30 } },
  );
  await rejects(
    engine.analyze('p', { url: `${origin}/hang`, tools: ['jsluice'] }, signal()),
    504,
    'capture_timeout',
  );
  const controller = new AbortController();
  const pending = engine.analyze(
    'p',
    { url: `${origin}/hang`, tools: ['jsluice'] },
    controller.signal,
  );
  controller.abort();
  await rejects(pending, 503, 'analysis_cancelled');
  assert.equal(w.calls, 0);
  assert.equal(engine.healthy, true);
  assert.equal((await analyze(engine)).status, 'complete');
});

test('identical bytes at different URLs hit static cache; acquisition and hash assertion still run', async (t) => {
  const bytes = Buffer.from('\ufefffetch("/api/test");\r\n');
  const { origin, requests } = await server(t, (_req, res) => res.end(bytes));
  const w = worker(() => result([endpoint(), done()]));
  const { engine } = setup(
    t,
    { jsluice: w },
    { capture: { origins: [{ origin, allow_private: true }] } },
  );
  const request = { content: undefined, url: `${origin}/one`, script_hash: sha(bytes) };
  const first = await analyze(engine, { ...request, base_url: 'https://one.example/base' });
  const second = await analyze(engine, {
    ...request,
    url: `${origin}/two`,
    base_url: 'https://two.example/base',
  });
  assert.equal(first.cache.status, 'miss');
  assert.equal(second.cache.status, 'hit');
  assert.equal(w.calls, 1);
  assert.notEqual(first.handle, second.handle);
  assert.equal(first.endpoints[0].resolved_url, 'https://one.example/api/test');
  assert.equal(second.endpoints[0].resolved_url, 'https://two.example/api/test');
  assert.equal(
    engine.store.read('p', second.handle, 'original/bundle.js').content,
    bytes.toString(),
  );
  assert.equal((await analyze(engine, request)).endpoints[0].resolved_url, null);
  await rejects(
    analyze(engine, { ...request, script_hash: sha('other') }),
    409,
    'script_hash_mismatch',
  );
  assert.equal(w.calls, 1);
  assert.equal(requests.length, 4);
});

test('cache invalidates on input, immutable runtime/options identity, budgets and project', async (t) => {
  const w = worker(() => result([endpoint(), done()]));
  const { engine, config } = setup(t, { jsluice: w });
  await analyze(engine);
  assert.equal((await analyze(engine)).cache.status, 'hit');
  await analyze(engine, { content: 'const x = 2;' });
  w.identity = 'fixture-image-v2';
  await analyze(engine);
  w.identity = 'fixture-image-v2-options-v2';
  await analyze(engine);
  config.budgets.tool_ms.jsluice--;
  await analyze(engine);
  config.budgets.finding_count++;
  assert.equal((await analyze(engine)).cache.status, 'miss');
  const other = await analyze(engine, {}, 'other');
  assert.equal(other.cache.status, 'miss');
  assert.equal(w.calls, 7);
  assert.notEqual(other.endpoints[0].id, (await analyze(engine)).endpoints[0].id);
});

test('reference domains invalidate their detector only, not independent static extraction', async (t) => {
  const js = worker(),
    domains = worker(() => offline());
  const { engine } = setup(t, { jsluice: js, domains });
  await analyze(engine, { tools: ['jsluice', 'domains'], reference_domains: ['example.com'] });
  const second = await analyze(engine, {
    tools: ['jsluice', 'domains'],
    reference_domains: ['example.org'],
  });
  assert.equal(second.cache.status, 'partial_hit');
  assert.equal(js.calls, 1);
  assert.equal(domains.calls, 2);
});

test('timeouts, invalid and partial steps are retried while successful steps remain reusable', async (t) => {
  for (const failure of [
    { ...offline(), status: 'timeout', errorCode: 'timeout' },
    { ...offline(), output: Buffer.from('{}') },
    offline([], { partial: true, reasons: ['finding_count'], error_code: 'output_truncated' }),
  ]) {
    const js = worker(),
      gql = worker((_input, count) => (count === 1 ? failure : offline()));
    const { engine } = setup(t, { jsluice: js, graphql: gql });
    assert.equal((await analyze(engine, { tools: ['jsluice', 'graphql'] })).status, 'partial');
    const second = await analyze(engine, { tools: ['jsluice', 'graphql'] });
    assert.equal(second.status, 'complete');
    assert.equal(second.cache.status, 'partial_hit');
    assert.equal(js.calls, 1);
    assert.equal(gql.calls, 2);
    assert.equal((await analyze(engine, { tools: ['jsluice', 'graphql'] })).cache.status, 'hit');
  }
});

test('transform and extraction caches retain provenance, and fallback has a distinct Wakaru identity', async (t) => {
  const code = 'const x = 1;';
  const wc = worker(() => offline([code])),
    wk = worker(() => offline([code])),
    js = worker();
  const { engine } = setup(t, { webcrack: wc, wakaru: wk, jsluice: js });
  const request = { tools: ['webcrack', 'wakaru', 'jsluice'] };
  const first = await analyze(engine, request),
    second = await analyze(engine, request);
  assert.equal(second.cache.status, 'hit');
  assert.equal(wc.calls, 1);
  assert.equal(wk.calls, 1);
  assert.equal(js.calls, 3);
  assert.deepEqual(
    engine.store.list('p', first.handle).modules,
    engine.store.list('p', second.handle).modules,
  );
  wc.identity = 'failed-webcrack-image';
  wc.run = async () => ({ ...offline(), status: 'error', errorCode: 'worker_failed' });
  const fallback = await analyze(engine, request);
  assert.equal(fallback.tools.find((x) => x.name === 'wakaru').input_path, 'original/bundle.js');
  assert.equal(wk.calls, 2);
  assert.equal(js.calls, 4);
});

test('corrupt cache is evicted and recomputed, without affecting previous handles', async (t) => {
  const w = worker();
  const { engine } = setup(t, { jsluice: w });
  const first = await analyze(engine);
  const directory = join(engine.store.root, 'cache');
  const file = readdirSync(directory)[0];
  assert.ok(file);
  writeFileSync(join(directory, file), 'corrupted');
  const second = await analyze(engine);
  assert.equal(second.cache.status, 'miss');
  assert.equal(w.calls, 2);
  assert.equal(engine.store.read('p', first.handle, 'original/bundle.js').content, 'const x = 1;');
  assert.equal((await analyze(engine)).cache.status, 'hit');
});

test('cache expiry is fixed, eviction preserves active handles, and quota reserves publication', async (t) => {
  let now = Date.now();
  const w = worker();
  const { engine, db, config } = setup(
    t,
    { jsluice: w },
    { cache: { retention_ms: 100, max_bytes: 20000 } },
    { now: () => now },
  );
  const first = await analyze(engine);
  now += 60;
  assert.equal((await analyze(engine)).cache.status, 'hit');
  now += 41;
  assert.equal((await analyze(engine)).cache.status, 'miss');
  assert.equal(w.calls, 2);
  // Two further inputs force FIFO eviction under a small cache quota.
  await analyze(engine, { content: 'const y = 2;' });
  await analyze(engine, { content: 'const z = 3;' });
  assert.ok(db.prepare('SELECT sum(bytes) AS n FROM step_cache').get().n <= 20000);
  assert.equal(engine.store.read('p', first.handle, 'original/bundle.js').content, 'const x = 1;');
  const before = w.calls;
  config.budgets.storage_bytes =
    Number(db.prepare('SELECT sum(bytes) AS n FROM analyses').get().n) + 100;
  await rejects(analyze(engine), 429, 'storage_full');
  assert.equal(w.calls, before);
  now += config.budgets.retention_ms;
  await rejects(
    Promise.resolve().then(() => engine.store.list('p', first.handle)),
    410,
    'handle_expired',
  );
  assert.throws(
    () => engine.store.list('foreign', first.handle),
    (e) => e.status === 404,
  );
  now += 86400000;
  engine.store.purge();
  assert.throws(
    () => engine.store.list('p', first.handle),
    (e) => e.status === 404,
  );
});

test('cache persists across restart, removes unpublished files and enforces exclusive publication ownership', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jsminer-phase4-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = parseConfig({ ...raw, database: join(directory, 'db') });
  const w = worker();
  const db = openMetadataStore(config.database);
  const first = new AnalysisEngine(config, db.database, { workers: { jsluice: w } });
  await analyze(first);
  assert.throws(
    () => new AnalysisEngine(config, db.database, { workers: { jsluice: w } }),
    /already in use/,
  );
  writeFileSync(join(first.store.root, 'cache', 'tmp-interrupted'), 'private partial output', {
    mode: 0o600,
  });
  await first.close();
  db.close();
  const reopened = openMetadataStore(config.database);
  const second = new AnalysisEngine(config, reopened.database, { workers: { jsluice: w } });
  try {
    assert.equal((await analyze(second)).cache.status, 'hit');
    assert.equal(w.calls, 1);
    assert.equal(readdirSync(join(second.store.root, 'cache')).includes('tmp-interrupted'), false);
  } finally {
    await second.close();
    reopened.close();
  }
});

test('URL route uses authenticated policy and stable errors without exposing the submitted URL', async (t) => {
  const token = 'phase4_fixture_token_not_for_production';
  const { origin } = await server(t, (_req, res) => res.end('const x = 1;'));
  const app = buildApp(
    {
      ...raw,
      tokens: [
        {
          sha256: createHash('sha256').update(token).digest('hex'),
          project_id: 'p',
          permissions: ['analysis:write', 'analysis:read'],
        },
      ],
      capture: { origins: [{ origin, allow_private: true }] },
    },
    { workers: { jsluice: worker() } },
  );
  t.after(() => app.close());
  const post = (url, authorized = true) =>
    app.inject({
      method: 'POST',
      url: '/analyze',
      headers: authorized ? { authorization: `Bearer ${token}` } : {},
      payload: { url, tools: ['jsluice'] },
    });
  assert.equal((await post(`${origin}/x`, false)).statusCode, 401);
  const denied = await post('http://example.invalid/private?secret=fixture_marker');
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.includes('fixture_marker'), false);
  assert.equal((await post(`${origin}/x`)).statusCode, 200);
  assert.equal((await post(`${origin}/x`)).json().cache.status, 'hit');
});

test('DNS policy validates every answer and pins one resolution while preserving Host', async (t) => {
  let host;
  const { origin } = await server(t, (req, res) => {
    host = req.headers.host;
    res.end('const x = 1;');
  });
  const target = origin.replace('127.0.0.1', 'fixture.invalid');
  let calls = 0;
  const resolver = async () => {
    calls++;
    return [{ address: '127.0.0.1', family: 4 }];
  };
  assert.equal(
    (await capture(`${target}/x`, originConfig(target), signal(), 1000, resolver)).toString(),
    'const x = 1;',
  );
  assert.equal(calls, 1);
  assert.equal(host, new URL(target).host);
  const publicOnly = parseConfig({ ...raw, capture: { origins: [{ origin: target }] } });
  await rejects(
    capture(`${target}/x`, publicOnly, signal(), 1000, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    403,
    'destination_denied',
  );
  await rejects(
    capture(`${target}/x`, originConfig(target), signal(), 10, () => new Promise(() => {})),
    504,
    'capture_timeout',
  );
  const controller = new AbortController();
  controller.abort();
  await rejects(
    capture(`${target}/x`, originConfig(target), controller.signal, 1000, async () => {
      throw new Error('DNS failed after cancellation');
    }),
    503,
    'analysis_cancelled',
  );
});

test('disabled cache and unidentified adapters always execute, with no persistent cache output', async (t) => {
  const w = worker();
  const { engine } = setup(t, { jsluice: w }, { cache: { enabled: false } });
  await analyze(engine);
  assert.equal((await analyze(engine)).cache.status, 'miss');
  assert.equal(w.calls, 2);
  assert.deepEqual(readdirSync(join(engine.store.root, 'cache')), []);
  delete w.pin;
  const other = setup(t, { jsluice: w }).engine;
  await analyze(other);
  assert.equal((await analyze(other)).cache.status, 'miss');
  assert.equal(w.calls, 4);
});

test('capture rejects protocol upgrades promptly and waits for transport closure', {
  timeout: 3000,
}, async (t) => {
  const { origin } = await server(t, (_req, res) => {
    res.writeHead(101, { connection: 'Upgrade', upgrade: 'fixture' });
    res.end();
  });
  let requestClosed = false,
    socketClosed = false;
  const diagnostic = channel('http.client.request.start');
  const observe = ({ request }) => {
    request.once('close', () => {
      requestClosed = true;
    });
    request.socket.once('close', () => {
      socketClosed = true;
    });
  };
  diagnostic.subscribe(observe);
  t.after(() => diagnostic.unsubscribe(observe));
  await rejects(
    capture(`${origin}/upgrade`, originConfig(origin), signal(), 1000),
    502,
    'capture_status',
  );
  assert.equal(requestClosed, true);
  assert.equal(socketClosed, true);
});

test('capture cancellation closes its socket before returning and does not start cancelled DNS work', async (t) => {
  let controller = new AbortController();
  const { origin } = await server(t, (_req, res) => {
    res.writeHead(200);
    res.write('const x = ');
    controller.abort();
  });
  let socketClosed = false;
  const diagnostic = channel('http.client.request.start');
  const observe = ({ request }) =>
    request.socket.once('close', () => {
      socketClosed = true;
    });
  diagnostic.subscribe(observe);
  t.after(() => diagnostic.unsubscribe(observe));
  await rejects(
    capture(origin, originConfig(origin), controller.signal, 1000),
    503,
    'analysis_cancelled',
  );
  assert.equal(socketClosed, true);
  controller = new AbortController();
  controller.abort();
  let resolved = false;
  const target = origin.replace('127.0.0.1', 'fixture.invalid');
  await rejects(
    capture(target, originConfig(target), controller.signal, 1000, async () => {
      resolved = true;
      return [{ address: '127.0.0.1', family: 4 }];
    }),
    503,
    'analysis_cancelled',
  );
  assert.equal(resolved, false);
});

test('capture checks elapsed time even before an expired timer can fire', async (t) => {
  const { origin, requests } = await server(t, (_req, res) => res.end('const x = 1;'));
  const target = origin.replace('127.0.0.1', 'fixture.invalid');
  await rejects(
    capture(target, originConfig(target), signal(), 5, async () => {
      const end = performance.now() + 15;
      while (performance.now() < end) {
        /* Simulate a synchronous resolver delay. */
      }
      return [{ address: '127.0.0.1', family: 4 }];
    }),
    504,
    'capture_timeout',
  );
  assert.deepEqual(requests, []);
});

test('origin configuration cannot normalize paths or empty query/fragment into broader permission', () => {
  for (const origin of [
    'https://example.com/path/..',
    'https://example.com/.',
    'https://example.com/?',
    'https://example.com/#',
  ])
    assert.throws(() => originConfig(origin));
  assert.equal(
    originConfig('https://EXAMPLE.com:443/').capture.origins[0].origin,
    'https://example.com',
  );
});
