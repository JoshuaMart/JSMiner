import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { JSLUICE_VERSION } from '@jsminer/adapters';
import { validateContract } from '@jsminer/contracts';
import { buildApp } from '../dist/app.js';
import { createAuthenticator } from '../dist/auth.js';
import { loadConfig, parseConfig } from '../dist/config.js';
import { openMetadataStore } from '../dist/storage.js';

const admin = 'fixture_admin_token_not_for_production_01';
const reader = 'fixture_reader_token_not_for_production_01';
const other = 'fixture_other_project_not_for_production_01';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const rawConfig = () => ({
  database: ':memory:',
  tokens: [
    {
      sha256: hash(admin),
      project_id: 'project_a',
      permissions: ['analysis:read', 'analysis:write', 'source:read'],
    },
    { sha256: hash(reader), project_id: 'project_a', permissions: ['analysis:read'] },
    { sha256: hash(other), project_id: 'project_b', permissions: ['source:read'] },
  ],
});
const options = {
  worker: {
    healthy: true,
    async run() {
      return {
        status: 'success',
        output: Buffer.from(
          JSON.stringify({
            type: 'done',
            version: JSLUICE_VERSION,
            truncated: false,
            secrets_truncated: false,
            syntax_error: false,
          }),
        ),
        durationMs: 1,
        errorCode: null,
        version: JSLUICE_VERSION,
      };
    },
  },
};
const headers = (token) => ({ authorization: `Bearer ${token}` });
async function fixture(t, config = rawConfig()) {
  const app = buildApp(config, options);
  t.after(() => app.close());
  await app.ready();
  return app;
}

test('authentication binds server-side identity and permissions', () => {
  const auth = createAuthenticator(rawConfig().tokens);
  assert.deepEqual(auth(`Bearer ${other}`), {
    projectId: 'project_b',
    permissions: ['source:read'],
  });
  assert.equal(auth('Bearer unknown_unknown_unknown_unknown_01'), null);
  assert.equal(auth(`Bearer ${admin} extra`), null);
  assert.equal(auth(undefined), null);
});
test('health verifies SQLite and requires analysis:read', async (t) => {
  const app = await fixture(t);
  for (const token of [undefined, 'incorrect_token_with_sufficient_length_01']) {
    const r = await app.inject({ url: '/health', headers: token ? headers(token) : {} });
    assert.equal(r.statusCode, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
    assert.equal(validateContract('ErrorResponse', r.json()).ok, true);
  }
  assert.equal((await app.inject({ url: '/health', headers: headers(other) })).statusCode, 403);
  const r = await app.inject({ url: '/health', headers: headers(reader) });
  assert.equal(r.statusCode, 200);
  assert.equal(validateContract('HealthResponse', r.json()).ok, true);
  assert.deepEqual(r.json(), { status: 'ok', storage: 'ready' });
  assert.equal(r.headers['cache-control'], 'no-store');
});
test('analysis authorizes before parsing and never executes a script', async (t) => {
  const app = await fixture(t);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/analyze',
        headers: headers(reader),
        payload: { content: 'x' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/analyze',
        headers: { 'content-type': 'application/json' },
        payload: 'not-json',
      })
    ).statusCode,
    401,
  );
  const r = await app.inject({
    method: 'POST',
    url: '/analyze',
    headers: headers(admin),
    payload: { content: 'throw new Error("fixture marker");' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'partial');
  assert.ok(!r.body.includes('fixture marker'));
});
test('HTTP rejects invalid contracts without removing fields or coercing body types', async (t) => {
  const app = await fixture(t);
  const cases = [
    [{ url: 'https://example.com/x.js', content: 'x' }, 400],
    [{}, 400],
    [{ content: 'x', extra: true }, 400],
    [{ content: 'x', tools: ['unknown'] }, 400],
    [{ content: 42 }, 400],
    [{ content: 'x', tools: ['domains'] }, 422],
    [{ content: '' }, 422],
    [{ content: 'x', project_id: 'project_b' }, 400],
    [{ content: 'x', tools: ['jsluice', 'jsluice'] }, 400],
  ];
  for (const [payload, status] of cases) {
    const r = await app.inject({
      method: 'POST',
      url: '/analyze',
      headers: headers(admin),
      payload,
    });
    assert.equal(r.statusCode, status, r.body);
    assert.equal(validateContract('ErrorResponse', r.json()).ok, true);
  }
});
test('transport enforces media type, body limit and decoded script bytes', async (t) => {
  const app = await fixture(t, {
    ...rawConfig(),
    budgets: { http_body_bytes: 1024, script_bytes: 32 },
  });
  const post = (payload, extra = {}) =>
    app.inject({
      method: 'POST',
      url: '/analyze',
      headers: { ...headers(admin), ...extra },
      payload,
    });
  assert.equal((await post('plain text', { 'content-type': 'text/plain' })).statusCode, 415);
  assert.equal(
    (await post('{}', { 'content-type': 'application/json', 'content-encoding': 'gzip' }))
      .statusCode,
    415,
  );
  assert.equal((await post('{broken', { 'content-type': 'application/json' })).statusCode, 400);
  assert.equal((await post({ content: 'é'.repeat(17) })).statusCode, 413);
  assert.equal((await post({ content: 'x'.repeat(1100) })).statusCode, 413);
  assert.equal((await post({ content: 'é'.repeat(16) })).statusCode, 200);
});
test('source route distinguishes wildcard path from manifest and validates numeric queries', async (t) => {
  const app = await fixture(t);
  assert.equal(
    (await app.inject({ url: '/source/ana_fixture', headers: headers(reader) })).statusCode,
    403,
  );
  for (const [url, status] of [
    ['/source/ana_fixture?limit=100', 404],
    ['/source/ana_fixture?limit=101', 400],
    ['/source/ana_fixture?limit=1&limit=2', 400],
    ['/source/ana_fixture/original/bundle.js?offset=0&max_bytes=65536', 404],
    ['/source/ana_fixture/original/bundle.js?offset=-1', 422],
    ['/source/ana_fixture/original/bundle.js?max_bytes=1e2', 422],
    ['/source/ana_fixture/original/bundle.js?offset=0&unknown=1', 422],
    ['/source/ana_fixture/original/%252e%252e/private.js', 400],
  ])
    assert.equal((await app.inject({ url, headers: headers(admin) })).statusCode, status, url);
});
test('configuration fails closed and defaults do not mutate input', () => {
  const original = rawConfig();
  const copy = structuredClone(original);
  const config = parseConfig(original);
  assert.deepEqual(original, copy);
  assert.equal(config.budgets.tool_ms.webcrack, 25000);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.budgets.analysis_ms, 90000);
  assert.throws(() => parseConfig({ ...original, tokens: [] }));
  assert.throws(() =>
    parseConfig({ ...original, tokens: [original.tokens[0], original.tokens[0]] }),
  );
  assert.throws(() => parseConfig({ ...original, budgets: { analysis_ms: 0 } }));
  assert.throws(() => parseConfig({ ...original, budgets: { analysis_ms: 90001 } }));
  assert.throws(() => parseConfig({ ...original, budgets: { http_body_bytes: 1 } }));
  assert.throws(() => parseConfig({ ...original, allow_anonymous: true }));
});
test('both source routes accept handles up to the contract limit', async (t) => {
  const app = await fixture(t);
  for (const length of [100, 101, 128, 129]) {
    const handle = 'a'.repeat(length);
    for (const suffix of ['', '/original/bundle.js']) {
      const response = await app.inject({
        url: `/source/${handle}${suffix}`,
        headers: headers(admin),
      });
      assert.equal(response.statusCode, length <= 128 ? 404 : 414);
    }
  }
});
test('JSON transport rejects invalid UTF-8 and accepts literal or escaped Unicode unchanged', async (t) => {
  const app = await fixture(t);
  const post = (payload) =>
    app.inject({
      method: 'POST',
      url: '/analyze',
      headers: { ...headers(admin), 'content-type': 'application/json' },
      payload,
    });
  const invalid = Buffer.concat([
    Buffer.from('{"content":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  const refused = await post(invalid);
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.json().error.code, 'invalid_content');
  assert.equal(validateContract('ErrorResponse', refused.json()).ok, true);
  for (const content of ['\ufeffconst ville = "été 🥐";\r\n', 'replacement: \ufffd']) {
    const body = JSON.stringify({ content });
    assert.equal((await post(Buffer.from(body))).statusCode, 200);
    const escaped = body.replace(
      /[\u007f-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    assert.equal((await post(Buffer.from(escaped))).statusCode, 200);
  }
  assert.equal((await post(Buffer.from('{broken'))).statusCode, 400);
});
test('strict decoding preserves script bytes through the registered JSON parser', async (t) => {
  const app = buildApp(rawConfig(), options);
  t.after(() => app.close());
  let parsedContent;
  app.addHook('preValidation', async (request) => {
    parsedContent = request.body?.content;
  });
  const content = '\ufeffconst ville = "été 🥐";\r\n';
  const response = await app.inject({
    method: 'POST',
    url: '/analyze',
    headers: headers(admin),
    payload: { content },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Buffer.from(parsedContent), Buffer.from(content));
});
test('SQLite migration persists and is idempotent across reopens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsminer-sqlite-'));
  try {
    const path = join(directory, 'metadata.db');
    for (let i = 0; i < 2; i++) {
      const store = openMetadataStore(path);
      assert.equal(store.isReady(), true);
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('real HTTP socket works on an ephemeral loopback port and closes', async (t) => {
  const app = await fixture(t);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/health`, { headers: headers(reader) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).storage, 'ready');
  await app.close();
  await assert.rejects(fetch(`${address}/health`, { headers: headers(reader) }));
});

test('local setup creates private usable credentials and refuses to overwrite them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsminer-config-'));
  const run = promisify(execFile);
  const script = fileURLToPath(new URL('../../../scripts/init-local-config.mjs', import.meta.url));
  try {
    const output = await run(process.execPath, [script], { cwd: directory });
    const token = (await readFile(join(directory, '.local/token'), 'utf8')).trim();
    const config = loadConfig(join(directory, '.local/config.json'));
    assert.equal(createAuthenticator(config.tokens)(`Bearer ${token}`).projectId, 'local');
    assert.equal(output.stdout.includes(token), false);
    assert.equal((await stat(join(directory, '.local'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, '.local/token'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, '.local/config.json'))).mode & 0o777, 0o600);
    await assert.rejects(run(process.execPath, [script], { cwd: directory }));
    assert.equal((await readFile(join(directory, '.local/token'), 'utf8')).trim(), token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Docker setup binds all interfaces and selects matching registry image tags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsminer-docker-config-'));
  const script = fileURLToPath(new URL('../../../scripts/init-local-config.mjs', import.meta.url));
  const env = {
    ...process.env,
    JSMINER_IMAGE_PREFIX: 'ghcr.io/example/jsminer',
    JSMINER_IMAGE_TAG: 'v0.1.0',
  };
  delete env.JSMINER_WORKER_IMAGE;
  delete env.JSMINER_OFFLINE_WORKER_IMAGE;
  try {
    await promisify(execFile)(process.execPath, [script, '--docker'], {
      cwd: directory,
      env,
    });
    const config = loadConfig(join(directory, '.local/config.json'));
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 3000);
    assert.equal(config.worker_image, 'ghcr.io/example/jsminer-jsluice:v0.1.0');
    assert.equal(config.offline_worker_image, 'ghcr.io/example/jsminer-offline:v0.1.0');
    assert.equal((await stat(join(directory, '.local/token'))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup fails without printing invalid configuration contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsminer-startup-'));
  try {
    const config = join(directory, 'invalid.json');
    await writeFile(config, '{"sensitive_fixture_marker": invalid_json}');
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
        {
          env: { ...process.env, JSMINER_CONFIG: config },
        },
      ),
      (error) =>
        error.code === 1 &&
        error.stderr.includes('Check JSMINER_CONFIG') &&
        !error.stderr.includes('sensitive_fixture_marker'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
