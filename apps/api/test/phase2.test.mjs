import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CleanupError, JSLUICE_VERSION } from '@jsminer/adapters';
import { validateContract } from '@jsminer/contracts';
import { AnalysisEngine } from '../dist/analysis.js';
import { buildApp } from '../dist/app.js';
import { parseConfig } from '../dist/config.js';
import { ServiceError } from '../dist/errors.js';
import { normalize } from '../dist/normalization.js';
import { openMetadataStore } from '../dist/storage.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const token = 'phase2_fixture_token_not_for_production';
const config = () => ({
  database: ':memory:',
  tokens: [
    {
      sha256: digest(token),
      project_id: 'a',
      permissions: ['analysis:read', 'analysis:write', 'source:read'],
    },
    {
      sha256: digest(`${token}_other`),
      project_id: 'b',
      permissions: ['analysis:read', 'analysis:write', 'source:read'],
    },
  ],
});
const endpoint = (url = '/api/profile') => ({
  type: 'endpoint',
  url,
  method: 'GET',
  kind: 'fetch',
  query_params: [],
  body_params: [],
});
const output = (records = [], done = {}) =>
  Buffer.from(
    `${[
      ...records,
      {
        type: 'done',
        version: JSLUICE_VERSION,
        truncated: false,
        secrets_truncated: false,
        syntax_error: false,
        ...done,
      },
    ]
      .map(JSON.stringify)
      .join('\n')}\n`,
  );
const worker = (records = [], done = {}) => ({
  healthy: true,
  async run() {
    return {
      status: 'success',
      version: JSLUICE_VERSION,
      errorCode: null,
      durationMs: 1,
      output: output(records, done),
    };
  },
});
const auth = (other = false) => ({ authorization: `Bearer ${token}${other ? '_other' : ''}` });
async function api(t, options = {}, overrides = {}) {
  const app = buildApp({ ...config(), ...overrides }, { worker: worker(), ...options });
  t.after(() => app.close());
  await app.ready();
  return app;
}
const analyze = (app, content = 'const x = 1;', extra = {}) =>
  app.inject({
    method: 'POST',
    url: '/analyze',
    headers: auth(),
    payload: { content, tools: ['jsluice'], ...extra },
  });
function engine(t, options = {}, overrides = {}) {
  const cfg = parseConfig({ ...config(), ...overrides });
  const db = openMetadataStore(cfg.database);
  const instance = new AnalysisEngine(cfg, db.database, { worker: worker(), ...options });
  t.after(async () => {
    await instance.close();
    db.close();
  });
  return { instance, db: db.database };
}
const request = { content: 'const value = 1;', tools: ['jsluice'] };
const signal = () => new AbortController().signal;

test('content yields a complete empty analysis, immutable original and UTF-8 reads', async (t) => {
  const app = await api(t);
  const content = '\ufeffconst x="été 🥐";\r\n';
  const response = await analyze(app, content, { script_hash: `sha256:${digest(content)}` });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(validateContract('AnalyzeResponse', result).ok, true);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.coverage, {
    endpoints: 'complete',
    secrets: 'complete',
    gql_operations: 'not_requested',
    subdomains: 'not_requested',
  });
  const manifest = await app.inject({ url: `/source/${result.handle}`, headers: auth() });
  assert.equal(validateContract('ManifestResponse', manifest.json()).ok, true);
  assert.equal(manifest.json().modules[0].hash, result.script_hash);
  let offset = 0,
    restored = '';
  do {
    const part = await app.inject({
      url: `/source/${result.handle}/original/bundle.js?offset=${offset}&max_bytes=4`,
      headers: auth(),
    });
    assert.equal(part.statusCode, 200, part.body);
    assert.equal(validateContract('SourceResponse', part.json()).ok, true);
    restored += part.json().content;
    offset = part.json().next_offset;
  } while (offset !== null);
  assert.equal(restored, content);
  for (const [suffix, status] of [
    ['?offset=1', 422],
    ['?offset=9999', 416],
    [`?offset=${Buffer.byteLength(content)}`, 200],
  ]) {
    assert.equal(
      (
        await app.inject({
          url: `/source/${result.handle}/original/bundle.js${suffix}`,
          headers: auth(),
        })
      ).statusCode,
      status,
    );
  }
  for (const suffix of ['', '/original/bundle.js'])
    assert.equal(
      (await app.inject({ url: `/source/${result.handle}${suffix}`, headers: auth(true) }))
        .statusCode,
      404,
    );
  assert.equal(
    (await analyze(app, 'const x=1;', { script_hash: `sha256:${'0'.repeat(64)}` })).statusCode,
    409,
  );
  for (const bad of ['   ', '\ufeff<html>error</html>', '<?xml version="1.0"?>'])
    assert.equal((await analyze(app, bad)).statusCode, 422);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/analyze',
        headers: auth(),
        payload: { url: 'https://example.invalid/bundle.js' },
      })
    ).statusCode,
    403,
  );
});

test('normalization masks secret values, URL credentials/query/fragment and preserves provenance', async (t) => {
  const secret = `ghp_${'a'.repeat(36)}`;
  const records = [
    { type: 'secret', kind: 'githubKey', data: { key: secret } },
    endpoint(`/api/${secret}?access_token=${secret}#${secret}`),
    endpoint('https://user:password@example.test/users?q=private'),
    endpoint('https:user:password@example.test/alternate'),
  ];
  const app = await api(t, { worker: worker(records) });
  const response = await analyze(app, 'const syntheticFixture = true;', {
    base_url: 'https://app.example.test/base/',
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.secrets.length, 1);
  assert.equal(result.endpoints.length, 3);
  for (const value of [secret, 'password', 'private', 'syntheticFixture'])
    assert.ok(!response.body.includes(value));
  assert.equal(result.secrets[0].masked_value, '[REDACTED]');
  assert.equal(result.secrets[0].validation, 'not_performed');
  for (const observation of [...result.endpoints, ...result.secrets])
    assert.equal(observation.evidence[0].module_path, 'original/bundle.js');
  const again = (await analyze(app)).json();
  assert.equal(again.secrets[0].fingerprint, result.secrets[0].fingerprint);
  const other = await app.inject({
    method: 'POST',
    url: '/analyze',
    headers: auth(true),
    payload: request,
  });
  assert.notEqual(other.json().secrets[0].fingerprint, result.secrets[0].fingerprint);
});

test('output loss, syntax errors, unavailable tools and failures never claim complete coverage', async (t) => {
  for (const done of [{ syntax_error: true }, { truncated: true }]) {
    const app = await api(t, { worker: worker([endpoint()], done) });
    const response = await analyze(app);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'partial');
    assert.equal(response.json().coverage.endpoints, 'partial');
  }
  for (const result of [
    { status: 'timeout', errorCode: 'timeout', output: Buffer.alloc(0) },
    { status: 'error', errorCode: 'worker_failed', output: Buffer.alloc(0) },
    { status: 'success', errorCode: null, output: Buffer.from('untrusted invalid output') },
  ]) {
    const app = await api(t, {
      worker: {
        healthy: true,
        async run() {
          return { version: JSLUICE_VERSION, durationMs: 2, ...result };
        },
      },
    });
    const response = await analyze(app);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'failed');
    assert.equal(response.json().coverage.secrets, 'failed');
  }
  const app = await api(t);
  const response = await analyze(app, undefined, { tools: ['jsluice', 'webcrack', 'trufflehog'] });
  assert.equal(response.json().status, 'partial');
  assert.equal(response.json().coverage.endpoints, 'partial');
  assert.equal(response.json().tools[1].error_code, 'tool_unavailable');
});

test('compact budget clips findings explicitly; malformed worker data is rejected', async (t) => {
  const app = await api(
    t,
    { worker: worker(Array.from({ length: 100 }, (_, i) => endpoint(`/api/${i}`))) },
    { budgets: { response_bytes: 2000 } },
  );
  const response = await analyze(app);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(Buffer.byteLength(response.body) <= 2000);
  assert.equal(validateContract('AnalyzeResponse', response.json()).ok, true);
  assert.ok(response.json().truncation.reasons.includes('response_bytes'));
  for (const bad of [
    Buffer.from('{}'),
    output([{ ...endpoint(), source: 'raw source' }]),
    output([{ type: 'secret', kind: 'unknown', data: { key: 'x' } }]),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  ])
    assert.throws(() => normalize(bad, digest));
  const truncated = normalize(output([endpoint(`/${'é'.repeat(1100)}`)]), digest);
  assert.deepEqual(truncated.reasons, ['field_bytes']);
});

test('expiration removes source, keeps owner-only tombstones then forgets them', async (t) => {
  let now = Date.now();
  const { instance, db } = engine(t, { now: () => now }, { budgets: { retention_ms: 1000 } });
  const result = await instance.analyze('a', request, signal());
  const root = instance.store.root;
  now += 1001;
  assert.throws(() => instance.store.list('b', result.handle), { status: 404 });
  assert.throws(() => instance.store.list('a', result.handle), { status: 410 });
  assert.deepEqual(readdirSync(join(root, 'objects')), []);
  assert.equal(db.prepare('SELECT bytes FROM analyses').get().bytes, 0);
  now += 86400000;
  instance.store.purge();
  assert.throws(() => instance.store.list('a', result.handle), { status: 404 });
});

test('pagination cursors are bound to project and handle; source integrity and symlinks fail closed', async (t) => {
  const { instance, db } = engine(t);
  const first = await instance.analyze('a', request, signal());
  const second = await instance.analyze('a', request, signal());
  const original = instance.store.list('a', first.handle).modules[0];
  const modules = [
    original,
    ...Array.from({ length: 4 }, (_, i) => ({
      ...original,
      path: `webcrack/${i}.js`,
      origin: 'webcrack',
      parent_path: original.path,
    })),
  ];
  db.prepare('UPDATE analyses SET manifest=? WHERE handle=?').run(
    JSON.stringify(modules),
    first.handle,
  );
  const page = instance.store.list('a', first.handle, 2);
  assert.equal(page.total_modules, 5);
  assert.equal(page.modules.length, 2);
  const next = instance.store.list('a', first.handle, 2, page.next_cursor);
  assert.equal(next.modules[0].path, 'webcrack/1.js');
  assert.equal(instance.store.list('a', first.handle, 2, next.next_cursor).next_cursor, null);
  assert.throws(() => instance.store.list('a', second.handle, 2, page.next_cursor), {
    code: 'invalid_cursor',
  });
  assert.throws(() => instance.store.list('b', first.handle, 2, page.next_cursor), { status: 404 });
  assert.throws(() => instance.store.list('a', first.handle, 2, 'corrupt'), {
    code: 'invalid_cursor',
  });
  const path = join(instance.store.root, 'objects', first.handle, 'original/bundle.js');
  writeFileSync(path, 'changed');
  assert.throws(() => instance.store.read('a', first.handle, original.path), {
    code: 'invalid_artifact',
  });
  rmSync(path);
  symlinkSync(join(instance.store.root, '.key'), path);
  assert.throws(() => instance.store.read('a', first.handle, original.path), {
    code: 'invalid_artifact',
  });
});

test('admission rejects concurrent work and cancellation cleans staging before accepting another request', async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const controlled = {
    healthy: true,
    run(input) {
      entered();
      return new Promise((resolve) =>
        input.signal.addEventListener(
          'abort',
          () =>
            resolve({
              status: 'error',
              errorCode: 'aborted',
              durationMs: 1,
              version: JSLUICE_VERSION,
              output: Buffer.alloc(0),
            }),
          { once: true },
        ),
      );
    },
  };
  const { instance } = engine(t, { worker: controlled });
  const controller = new AbortController();
  const pending = instance.analyze('a', request, controller.signal);
  await started;
  assert.throws(() => instance.analyze('a', request, signal()), { status: 429 });
  controller.abort();
  await assert.rejects(pending, { code: 'analysis_cancelled' });
  assert.deepEqual(readdirSync(join(instance.store.root, 'staging')), []);
  assert.deepEqual(readdirSync(join(instance.store.root, 'objects')), []);
  controlled.run = worker().run;
  assert.equal((await instance.analyze('a', request, signal())).status, 'complete');
});

test('cleanup failure blocks admissions and health without publishing a handle', async (t) => {
  const app = await api(t, {
    worker: {
      healthy: true,
      async run() {
        throw new CleanupError();
      },
    },
  });
  const first = await analyze(app);
  assert.equal(first.statusCode, 503);
  assert.equal(first.json().error.code, 'worker_cleanup_unconfirmed');
  assert.equal((await analyze(app)).json().error.code, 'service_unavailable');
  assert.equal((await app.inject({ url: '/health', headers: auth() })).statusCode, 503);
});

test('quota rejects before worker execution; response failure discards staging', async (t) => {
  let runs = 0;
  const limited = worker();
  const run = limited.run;
  limited.run = () => {
    runs++;
    return run();
  };
  const { instance } = engine(
    t,
    { worker: limited },
    { budgets: { storage_bytes: 100, artifact_bytes: 100 } },
  );
  await assert.rejects(instance.analyze('a', request, signal()), { status: 429 });
  assert.equal(runs, 0);
  const other = engine(t, {}, { budgets: { response_bytes: 1 } }).instance;
  await assert.rejects(other.analyze('a', request, signal()), {
    code: 'response_budget_too_small',
  });
  assert.deepEqual(readdirSync(join(other.store.root, 'staging')), []);
});

test('restart retains handles and HMAC key, removes orphan staging, and refuses a second owner', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jsminer-restart-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const cfg = parseConfig({ ...config(), database: join(directory, 'db.sqlite') });
  let db = openMetadataStore(cfg.database);
  let instance = new AnalysisEngine(cfg, db.database, { worker: worker() });
  const result = await instance.analyze('a', request, signal());
  const key = instance.store.mac('a', 'fixture');
  assert.throws(() => new AnalysisEngine(cfg, db.database, { worker: worker() }), /already in use/);
  writeFileSync(join(instance.store.root, 'staging', 'orphan'), 'fixture');
  await instance.close();
  db.close();
  db = openMetadataStore(cfg.database);
  instance = new AnalysisEngine(cfg, db.database, { worker: worker() });
  try {
    assert.equal(instance.store.mac('a', 'fixture'), key);
    assert.equal(
      instance.store.read('a', result.handle, 'original/bundle.js').content,
      request.content,
    );
    assert.deepEqual(readdirSync(join(instance.store.root, 'staging')), []);
    assert.ok(
      !readFileSync(
        join(instance.store.root, 'objects', result.handle, 'result.json'),
        'utf8',
      ).includes(request.content),
    );
  } finally {
    await instance.close();
    db.close();
  }
});

test('failed index publication leaves no visible handle or orphan file', async (t) => {
  const { instance, db } = engine(t);
  db.exec(
    "CREATE TRIGGER reject_publication BEFORE INSERT ON analyses BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;",
  );
  await assert.rejects(instance.analyze('a', request, signal()));
  assert.equal(db.prepare('SELECT count(*) AS count FROM analyses').get().count, 0);
  assert.deepEqual(readdirSync(join(instance.store.root, 'objects')), []);
  assert.deepEqual(readdirSync(join(instance.store.root, 'staging')), []);
  db.exec('DROP TRIGGER reject_publication');
  assert.equal((await instance.analyze('a', request, signal())).status, 'complete');
});

test('retention begins after worker completion, and original plus result obey artifact budget', async (t) => {
  let now = Date.now();
  const delayed = worker();
  const run = delayed.run;
  delayed.run = () => {
    now += 5000;
    return run();
  };
  const { instance } = engine(
    t,
    { worker: delayed, now: () => now },
    { budgets: { retention_ms: 1000 } },
  );
  const response = await instance.analyze('a', request, signal());
  assert.equal(Date.parse(response.expires_at), now + 1000);
  assert.equal(instance.store.list('a', response.handle).total_modules, 1);
  const tiny = engine(t, {}, { budgets: { artifact_bytes: 100 } }).instance;
  await assert.rejects(tiny.analyze('a', request, signal()), { code: 'artifact_too_large' });
  assert.deepEqual(readdirSync(join(tiny.store.root, 'objects')), []);
});

test('endpoint truncation retains safe partial results; incomplete secret redaction suppresses them', () => {
  const truncated = normalize(output([endpoint()], { truncated: true }), digest);
  assert.equal(truncated.endpoints.length, 1);
  assert.equal(truncated.partial, true);
  const unsafe = normalize(
    output([endpoint()], { truncated: true, secrets_truncated: true }),
    digest,
  );
  assert.equal(unsafe.endpoints.length, 0);
  assert.equal(unsafe.partial, true);
  assert.throws(() => normalize(output([], { secrets_truncated: true }), digest));
  assert.throws(() => normalize(output(Array.from({ length: 201 }, () => endpoint())), digest));
});

test('query parsing retains parameter names following a question mark in a value', () => {
  const result = normalize(output([endpoint('/api/items?first=a?b&second=value')]), digest);
  assert.deepEqual(result.endpoints[0].query_params, ['first', 'second']);
  assert.equal(result.endpoints[0].value, '/api/items?first=REDACTED&second=REDACTED');
});

test('repeated close cannot release a newer store lease', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jsminer-lease-'));
  const cfg = parseConfig({ ...config(), database: join(directory, 'db.sqlite') });
  const db = openMetadataStore(cfg.database);
  const first = new AnalysisEngine(cfg, db.database, { worker: worker() });
  await first.close();
  const second = new AnalysisEngine(cfg, db.database, { worker: worker() });
  t.after(async () => {
    await second.close();
    db.close();
    rmSync(directory, { recursive: true });
  });
  await first.close();
  assert.throws(() => new AnalysisEngine(cfg, db.database, { worker: worker() }), /already in use/);
});

test('HTTP admission is reserved while the body is still streaming and released on disconnect', {
  timeout: 5000,
}, async (t) => {
  const app = buildApp(config(), { worker: worker() });
  t.after(() => app.close());
  let entering, aborted;
  const receiving = new Promise((resolve) => {
    entering = resolve;
  });
  const disconnected = new Promise((resolve) => {
    aborted = resolve;
  });
  app.addHook('preParsing', async (request) => {
    request.raw.once('aborted', aborted);
    entering();
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const slow = httpRequest(`${address}/analyze`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
  });
  slow.on('error', () => {});
  t.after(() => slow.destroy());
  slow.write('{"content":"');
  await receiving;
  const refused = await app.inject({
    method: 'POST',
    url: '/analyze',
    headers: { ...auth(), 'content-type': 'application/json' },
    payload: 'invalid json',
  });
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.headers['retry-after'], '1');
  slow.destroy();
  await disconnected;
  assert.equal((await analyze(app)).statusCode, 200);
  assert.equal((await analyze(app, '')).statusCode, 422);
  assert.equal((await analyze(app)).statusCode, 200);
});

test('a crashed process releases the store lease without deleting its lock file', {
  timeout: 10000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jsminer-crash-'));
  const cfg = { ...config(), database: join(directory, 'db.sqlite') };
  const moduleUrl = new URL('../dist/app.js', import.meta.url).href;
  const program = `import {buildApp} from ${JSON.stringify(moduleUrl)};
    const app=buildApp(JSON.parse(process.argv[1]));
    await app.ready(); process.stdout.write('ready'); setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', program, JSON.stringify(cfg)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  });
  const exited = once(child, 'exit');
  assert.equal((await once(child.stdout, 'data'))[0].toString(), 'ready');
  assert.throws(() => buildApp(cfg, { worker: worker() }), /already in use/);
  child.kill('SIGKILL');
  await exited;
  const reopened = buildApp(cfg, { worker: worker() });
  try {
    assert.equal((await analyze(reopened)).statusCode, 200);
  } finally {
    await reopened.close();
  }
});

test('deduplication preserves navigation and additional request metadata', () => {
  const result = normalize(
    output([
      endpoint('/shared'),
      { ...endpoint('/shared'), method: '', kind: 'locationReplacement' },
      { ...endpoint('/shared'), method: '', body_params: ['payload'] },
      { ...endpoint('/shared'), method: '', kind: 'stringLiteral' },
    ]),
    digest,
  );
  assert.equal(result.endpoints.length, 3);
  assert.ok(result.endpoints.some((e) => e.kind === 'navigation'));
  assert.ok(result.endpoints.some((e) => e.body_params.includes('payload')));
});

test('unconfirmed publication rollback blocks subsequent admissions', async (t) => {
  const { instance } = engine(t);
  instance.store.publish = () => {
    throw new ServiceError(503, 'storage_cleanup_unconfirmed');
  };
  await assert.rejects(instance.analyze('a', request, signal()), {
    code: 'storage_cleanup_unconfirmed',
  });
  assert.equal(instance.healthy, false);
  assert.throws(() => instance.analyze('a', request, signal()), { code: 'service_unavailable' });
});
