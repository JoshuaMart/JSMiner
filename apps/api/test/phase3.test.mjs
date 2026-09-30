import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSLUICE_VERSION, OFFLINE_VERSION } from '@jsminer/adapters';
import { validateContract } from '@jsminer/contracts';
import { AnalysisEngine } from '../dist/analysis.js';
import { parseConfig } from '../dist/config.js';
import { openMetadataStore } from '../dist/storage.js';

const result = (output, overrides = {}) => ({
  status: 'success',
  version: OFFLINE_VERSION,
  durationMs: 1,
  errorCode: null,
  output: Buffer.from(JSON.stringify(output)),
  ...overrides,
});
const offline = (overrides = {}) => ({
  modules: [],
  findings: [],
  partial: false,
  reasons: [],
  error_code: null,
  ...overrides,
});
const transform = (content = 'const x = 1;', path = 'bundle.js') =>
  offline({ modules: [{ path, content: Buffer.from(content).toString('base64') }] });
const worker = (fn) => ({
  healthy: true,
  run: async (input) => (typeof fn === 'function' ? fn(input) : result(fn)),
});
const jsluice = (records = [], done = {}) => ({
  ...result(null),
  version: JSLUICE_VERSION,
  output: Buffer.from(
    [
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
      .join('\n'),
  ),
});
const endpoint = (url = '/a') => ({
  type: 'endpoint',
  url,
  method: 'GET',
  kind: 'fetch',
  query_params: [],
  body_params: [],
});
function setup(t, workers, budgets = {}) {
  const config = parseConfig({
    database: ':memory:',
    tokens: [{ sha256: 'a'.repeat(64), project_id: 'p', permissions: ['analysis:write'] }],
    budgets,
  });
  const db = openMetadataStore(config.database),
    engine = new AnalysisEngine(config, db.database, { workers });
  t.after(async () => {
    await engine.close();
    db.close();
  });
  return engine;
}
const analyze = async (engine, tools, content = 'const original = 1;', extra = {}) => {
  const response = await engine.analyze(
    'p',
    { content, ...(tools ? { tools } : {}), ...extra },
    new AbortController().signal,
  );
  assert.equal(validateContract('AnalyzeResponse', response).ok, true);
  return response;
};
test('chain keeps validated aggregate, parent links, original bytes and module provenance', async (t) => {
  const seen = [];
  const engine = setup(t, {
    webcrack: worker(transform('const aggregate = 2;')),
    wakaru: worker((input) => {
      seen.push(JSON.parse(input.content).content);
      return result(transform('const rebuilt = 3;'));
    }),
    jsluice: worker(() => jsluice([endpoint()])),
  });
  const r = await analyze(
    engine,
    ['wakaru', 'jsluice', 'webcrack'],
    '\uFEFFconst original = 1;\r\n',
  );
  assert.equal(r.status, 'complete');
  assert.deepEqual(seen, ['const aggregate = 2;']);
  const list = engine.store.list('p', r.handle);
  assert.equal(list.total_modules, 3);
  assert.equal(
    list.modules.find((m) => m.path === 'wakaru/bundle.js').parent_path,
    'webcrack/bundle.js',
  );
  assert.equal(
    engine.store.read('p', r.handle, 'original/bundle.js').content,
    '\uFEFFconst original = 1;\r\n',
  );
  assert.equal(r.endpoints.length, 1);
  assert.equal(r.endpoints[0].evidence.length, 3);
  assert.equal(r.tools.find((t) => t.name === 'jsluice').modules_analyzed, 3);
});
test('webcrack failure falls back to original, without cancelling extraction', async (t) => {
  const engine = setup(t, {
    webcrack: worker(() => result(null, { status: 'error', errorCode: 'worker_failed' })),
    wakaru: worker((input) => {
      assert.equal(JSON.parse(input.content).content, 'const original = 1;');
      return result(transform());
    }),
    jsluice: worker(() => jsluice([endpoint()])),
  });
  const r = await analyze(engine, ['webcrack', 'wakaru', 'jsluice']);
  assert.equal(r.status, 'partial');
  assert.equal(r.coverage.endpoints, 'partial');
  assert.ok(r.warnings.some((w) => w.code === 'fallback_to_original'));
  assert.equal(r.tools.find((t) => t.name === 'wakaru').input_path, 'original/bundle.js');
});
test('global deadline skips later tools explicitly', async (t) => {
  let called = false;
  const engine = setup(
    t,
    {
      webcrack: worker(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return result(null, { status: 'timeout', errorCode: 'timeout' });
      }),
      wakaru: worker(() => {
        called = true;
        return result(transform());
      }),
    },
    { analysis_ms: 10 },
  );
  const r = await analyze(engine, ['webcrack', 'wakaru']);
  assert.equal(called, false);
  assert.equal(r.tools[1].error_code, 'global_deadline');
});
test('per-extractor budget is shared across modules, prior observations survive timeout', async (t) => {
  let calls = 0;
  const engine = setup(
    t,
    {
      webcrack: worker(transform()),
      jsluice: worker(async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return jsluice([endpoint()]);
      }),
    },
    { tool_ms: { jsluice: 10 } },
  );
  const r = await analyze(engine, ['webcrack', 'jsluice']);
  assert.equal(calls, 1);
  assert.equal(r.endpoints.length, 1);
  assert.equal(r.coverage.endpoints, 'partial');
  assert.equal(r.tools[1].modules_analyzed, 1);
  assert.equal(r.tools[1].error_code, 'tool_deadline');
});
test('failed module does not erase completed findings or falsely report full coverage', async (t) => {
  let calls = 0;
  const engine = setup(t, {
    webcrack: worker(transform()),
    jsluice: worker(() =>
      ++calls === 1
        ? result(null, { status: 'error', errorCode: 'worker_failed' })
        : jsluice([endpoint()]),
    ),
  });
  const r = await analyze(engine, ['webcrack', 'jsluice']);
  assert.equal(r.endpoints.length, 1);
  assert.equal(r.coverage.endpoints, 'partial');
  assert.equal(r.tools[1].modules_analyzed, 1);
});
test('secrets merge across detectors and mask endpoints after both detectors finish', async (t) => {
  const value = `ghp_${'synthetic'.repeat(4)}`;
  const engine = setup(t, {
    jsluice: worker(() =>
      jsluice([
        { type: 'secret', kind: 'githubKey', data: { key: value } },
        endpoint(`/a/${value}`),
      ]),
    ),
    trufflehog: worker(offline({ findings: [{ kind: 'Github', value, extra: '' }] })),
  });
  const r = await analyze(engine, ['trufflehog', 'jsluice']);
  assert.equal(r.secrets.length, 1);
  assert.equal(r.secrets[0].evidence.length, 2);
  assert.equal(r.secrets[0].kind, 'github');
  assert.ok(!JSON.stringify(r).includes(value));
  assert.ok(r.endpoints[0].value.includes('REDACTED'));
});
test('a TruffleHog-only finding masks a jsluice URL and keeps fingerprint stable', async (t) => {
  const value = 'syntheticSecretValue';
  const engine = setup(t, {
    jsluice: worker(() => jsluice([endpoint(`/a/${value}`)])),
    trufflehog: worker(offline({ findings: [{ kind: 'Example', value, extra: '' }] })),
  });
  const a = await analyze(engine, ['jsluice', 'trufflehog']),
    b = await analyze(engine, ['trufflehog', 'jsluice']);
  assert.ok(!JSON.stringify(a).includes(value));
  assert.equal(a.secrets[0].fingerprint, b.secrets[0].fingerprint);
  assert.equal(a.endpoints[0].id, b.endpoints[0].id);
});
test('default profile runs every tool and adds domains only with reference domains', async (t) => {
  const workers = Object.fromEntries(
    ['webcrack', 'wakaru', 'trufflehog', 'graphql', 'domains'].map((n) => [
      n,
      worker(['webcrack', 'wakaru'].includes(n) ? transform() : offline()),
    ]),
  );
  workers.jsluice = worker(() => jsluice());
  const engine = setup(t, workers),
    a = await analyze(engine),
    b = await analyze(engine, undefined, undefined, { reference_domains: ['example.com'] });
  assert.equal(a.tools.length, 5);
  assert.equal(a.status, 'complete');
  assert.equal(b.tools.length, 6);
  assert.equal(b.status, 'complete');
});
test('module and artifact budgets retain original and report losses', async (t) => {
  for (const budgets of [{ module_count: 1 }, { artifact_bytes: 2048, response_bytes: 1500 }]) {
    const engine = setup(
      t,
      {
        webcrack: worker(transform(`const big = '${'a'.repeat(1500)}';`)),
        jsluice: worker(() => jsluice()),
      },
      budgets,
    );
    const r = await analyze(engine, ['webcrack', 'jsluice']);
    assert.equal(r.status, 'partial');
    assert.equal(engine.store.list('p', r.handle).total_modules, 1);
    assert.ok(
      r.truncation.reasons.includes(budgets.module_count ? 'module_count' : 'artifact_bytes'),
    );
  }
});
test('unsafe paths, duplicate paths and invalid UTF-8 never become published modules', async (t) => {
  for (const modules of [
    [{ path: '../outside.js', content: 'YQ==' }],
    [{ path: `modules/m${'1'.repeat(300)}.js`, content: 'YQ==' }],
    [transform().modules[0], transform().modules[0]],
    [{ path: 'bundle.js', content: '/w==' }],
  ]) {
    const engine = setup(t, {
      webcrack: worker(offline({ modules })),
      wakaru: worker(transform()),
    });
    const r = await analyze(engine, ['webcrack', 'wakaru']);
    assert.equal(r.tools[0].status, 'error');
    assert.equal(r.tools[1].input_path, 'original/bundle.js');
  }
});
test('invalid GraphQL positions and unrelated domain outputs fail only their extractor', async (t) => {
  const engine = setup(t, {
    jsluice: worker(() => jsluice([endpoint()])),
    domains: worker(
      offline({
        findings: [
          {
            hostname: 'evil.example.net',
            reference_domain: 'example.net',
            location: { start_byte: 0, end_byte: 1 },
          },
        ],
      }),
    ),
    graphql: worker(
      offline({
        findings: [
          {
            operation_type: 'query',
            name: null,
            variables: [],
            root_fields: ['hello'],
            document_hash: `sha256:${'a'.repeat(64)}`,
            endpoint_id: null,
            location: { start_byte: 0, end_byte: 9999 },
          },
        ],
      }),
    ),
  });
  const r = await analyze(engine, ['jsluice', 'graphql', 'domains'], undefined, {
    reference_domains: ['example.com'],
  });
  assert.equal(r.endpoints.length, 1);
  assert.equal(r.coverage.gql_operations, 'failed');
  assert.equal(r.coverage.subdomains, 'failed');
});
test('response and evidence budgets are explicit and keep the result contract valid', async (t) => {
  const modules = Array.from({ length: 8 }, (_, i) => ({
    path: i === 0 ? 'bundle.js' : `modules/m${i}.js`,
    content: Buffer.from('const x=1;').toString('base64'),
  }));
  const engine = setup(
    t,
    {
      webcrack: worker(offline({ modules })),
      jsluice: worker(() => jsluice(Array.from({ length: 20 }, (_, i) => endpoint(`/api/${i}`)))),
    },
    { response_bytes: 2400 },
  );
  const r = await analyze(engine, ['webcrack', 'jsluice']);
  assert.ok(r.truncation.reasons.includes('response_bytes'));
  assert.ok(r.truncation.reasons.includes('evidence_count'));
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 2400);
});
test('clipped TruffleHog findings suppress observations without a complete redaction set', async (t) => {
  const engine = setup(t, {
    jsluice: worker(() => jsluice([endpoint()])),
    trufflehog: worker(
      offline({ partial: true, reasons: ['finding_count'], error_code: 'output_truncated' }),
    ),
  });
  const r = await analyze(engine, ['jsluice', 'trufflehog']);
  assert.equal(r.endpoints.length, 0);
  assert.equal(r.coverage.endpoints, 'partial');
});

test('composite secret identities stay distinct and malformed scalar values fail only their detector', async (t) => {
  const engine = setup(t, {
    trufflehog: worker(
      offline({
        findings: [
          { kind: 'Example', value: 'shared', extra: 'pair-one' },
          { kind: 'Example', value: 'shared', extra: 'pair-two' },
        ],
      }),
    ),
  });
  const r = await analyze(engine, ['trufflehog']);
  assert.equal(r.secrets.length, 2);
  assert.notEqual(r.secrets[0].fingerprint, r.secrets[1].fingerprint);
  const bad = setup(t, {
    jsluice: worker(() => jsluice([endpoint()])),
    trufflehog: worker(
      offline({ findings: [{ kind: 'Example', value: String.fromCharCode(0xd800), extra: '' }] }),
    ),
  });
  const partial = await analyze(bad, ['jsluice', 'trufflehog']);
  assert.equal(partial.coverage.secrets, 'partial');
  assert.equal(partial.endpoints.length, 1);
  assert.equal(partial.tools[1].error_code, 'invalid_worker_output');
});
test('redaction expansion is bounded before final response validation', async (t) => {
  const engine = setup(t, {
    jsluice: worker(() => jsluice([endpoint(`/api/${'a'.repeat(500)}`)])),
    trufflehog: worker(offline({ findings: [{ kind: 'Example', value: 'a', extra: '' }] })),
  });
  const r = await analyze(engine, ['jsluice', 'trufflehog']);
  assert.equal(r.endpoints.length, 0);
  assert.ok(r.truncation.reasons.includes('field_bytes'));
});

test('family aliases preserve both jsluice rules within one module', async (t) => {
  const records = ['firebase', 'gcpKey'].map((kind) => ({
    type: 'secret',
    kind,
    data: { apiKey: 'syntheticGoogleKey' },
  }));
  const engine = setup(t, { jsluice: worker(() => jsluice(records)) });
  const r = await analyze(engine, ['jsluice']);
  assert.equal(r.secrets.length, 1);
  assert.deepEqual(r.secrets[0].evidence.map((e) => e.rule_id).sort(), [
    'jsluice:firebase',
    'jsluice:gcpKey',
  ]);
});

test('redaction cannot turn URL credentials or query values into visible path text', async (t) => {
  for (const secret of ['https:', '?', '#']) {
    const engine = setup(t, {
      jsluice: worker(() =>
        jsluice([
          { type: 'secret', kind: 'genericSecret', data: { key: secret } },
          endpoint(
            'https://fixture-user:fixture-password@example.test/path?q=fixture-query#fixture-fragment',
          ),
        ]),
      ),
    });
    const response = await analyze(engine, ['jsluice']);
    const json = JSON.stringify(response);
    for (const raw of ['fixture-user', 'fixture-password', 'fixture-query', 'fixture-fragment'])
      assert.ok(!json.includes(raw), raw);
  }
});

test('empty reconstructed modules are retained and a blank webcrack aggregate triggers fallback', async (t) => {
  const inputs = [];
  const engine = setup(t, {
    webcrack: worker(transform('')),
    wakaru: worker((input) => {
      inputs.push(JSON.parse(input.content).content);
      return result(transform(''));
    }),
    jsluice: worker((input) => {
      inputs.push(input.content.toString());
      return jsluice();
    }),
  });
  const response = await analyze(engine, ['webcrack', 'wakaru', 'jsluice']);
  assert.equal(response.status, 'complete');
  assert.equal(response.tools[1].input_path, 'original/bundle.js');
  assert.deepEqual(inputs, ['const original = 1;', 'const original = 1;', '', '']);
  const source = engine.store.read('p', response.handle, 'webcrack/bundle.js');
  assert.equal(source.total_bytes, 0);
  assert.equal(source.content, '');
  assert.equal(source.next_offset, null);
});

test('initial admission reserves manifest storage before invoking a worker', async (t) => {
  let invoked = false;
  const engine = setup(
    t,
    {
      jsluice: worker(() => {
        invoked = true;
        return jsluice();
      }),
    },
    { storage_bytes: 10500, artifact_bytes: 2200, response_bytes: 2200 },
  );
  await assert.rejects(analyze(engine, ['jsluice']), (error) => error.code === 'storage_full');
  assert.equal(invoked, false);
});

test('redaction examines observed GraphQL/domain values, not JSON keys or document hashes', async (t) => {
  const engine = setup(t, {
    trufflehog: worker(
      offline({
        findings: [
          { kind: 'Example', value: 'name', extra: '' },
          { kind: 'Example', value: 'hostname', extra: '' },
          { kind: 'Example', value: 'a'.repeat(64), extra: '' },
        ],
      }),
    ),
    graphql: worker(
      offline({
        findings: [
          {
            operation_type: 'query',
            name: 'Review',
            variables: [],
            root_fields: ['user'],
            document_hash: `sha256:${'a'.repeat(64)}`,
            endpoint_id: null,
            location: { start_byte: 0, end_byte: 1 },
          },
        ],
      }),
    ),
    domains: worker(
      offline({
        findings: [
          {
            hostname: 'api.example.com',
            reference_domain: 'example.com',
            location: { start_byte: 0, end_byte: 1 },
          },
        ],
      }),
    ),
  });
  const r = await analyze(engine, ['trufflehog', 'graphql', 'domains'], undefined, {
    reference_domains: ['example.com'],
  });
  assert.equal(r.gql_operations.length, 1);
  assert.equal(r.subdomains.length, 1);
  assert.equal(r.status, 'complete');
});

test('an ordinary adapter exception is contained while other requested tools finish', async (t) => {
  const engine = setup(t, {
    webcrack: worker(() => {
      throw new Error('private worker diagnostic');
    }),
    wakaru: worker(transform()),
    jsluice: worker(() => jsluice([endpoint()])),
  });
  const r = await analyze(engine, ['webcrack', 'wakaru', 'jsluice']);
  assert.equal(r.status, 'partial');
  assert.equal(r.tools[0].error_code, 'worker_failed');
  assert.equal(r.tools[1].status, 'success');
  assert.equal(r.endpoints.length, 1);
  assert.ok(!JSON.stringify(r).includes('private worker diagnostic'));
});
