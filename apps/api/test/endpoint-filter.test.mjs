import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { JSLUICE_VERSION } from '@jsminer/adapters';
import { validateContract } from '@jsminer/contracts';
import { buildApp } from '../dist/app.js';
import { normalize } from '../dist/normalization.js';
import { endpointFilter } from '../dist/result-filters.js';

const digest = (s) => createHash('sha256').update(s).digest('hex');
const endpoint = (value, dynamic = false) => ({ value, resolved_url: null, dynamic });
const filter = (options) => endpointFilter({ content: 'const x = 1;', ...options });

test('Same FQDN uses base_url first, ignores scheme/port, and excludes ambiguous destinations', () => {
  const keep = filter({
    url: 'https://cdn.example.com/bundle.js',
    base_url: 'https://APP.example.com./page/',
    endpoint_scope: 'same_fqdn',
  });
  for (const value of [
    '/api',
    '../api',
    '//app.example.com/api',
    'http://app.example.com:8080/api',
  ])
    assert.equal(keep(endpoint(value)), true, value);
  for (const value of [
    'https://cdn.example.com/a',
    'https://app.example.com.evil.test/a',
    '//[broken',
  ])
    assert.equal(keep(endpoint(value)), false, value);
  assert.equal(keep(endpoint('/api/EXPR', true)), true);
  assert.equal(keep(endpoint('https://EXPR.example.com/api', true)), false);
  const fallback = endpointFilter({
    url: 'https://cdn.example.com/a.js',
    endpoint_scope: 'same_fqdn',
  });
  assert.equal(fallback(endpoint('/api')), true);
  assert.equal(fallback(endpoint('https://app.example.com/api')), false);
});

test('Same domain handles public/private suffixes, IDNs, IPs and hostname boundaries', () => {
  for (const [base, allowed, denied] of [
    ['https://app.example.co.uk', 'https://api.example.co.uk/a', 'https://other.co.uk/a'],
    ['https://alice.github.io', 'https://api.alice.github.io/a', 'https://bob.github.io/a'],
    ['https://app.example.com', 'https://example.com/a', 'https://example.com.evil.test/a'],
    ['https://bücher.de', 'https://api.xn--bcher-kva.de/a', 'https://other.de/a'],
    ['http://127.0.0.1', 'http://127.0.0.1:8080/a', 'http://127.0.0.2/a'],
    ['http://[::1]', 'http://[::1]:8080/a', 'http://[::2]/a'],
    ['http://localhost', 'http://localhost:8080/a', 'http://elsewhere/a'],
  ]) {
    const keep = filter({ base_url: base, endpoint_scope: 'same_domain' });
    assert.equal(keep(endpoint(allowed)), true, allowed);
    assert.equal(keep(endpoint(denied)), false, denied);
  }
});

test('Extension exclusions apply to path suffixes only, including encoded and compound suffixes', () => {
  const keep = filter({ exclude_extensions: ['.CSS', 'png', 'js.map'] });
  for (const value of [
    '/style.CsS?v=1',
    'images/a.png#anchor',
    '/a%2Epng',
    '//cdn.example.com/app.js.map',
  ])
    assert.equal(keep(endpoint(value)), false, value);
  for (const value of ['/api?file=a.png', '/file.png/data', '/folder.css/', '/app.js', '/api'])
    assert.equal(keep(endpoint(value)), true, value);
  assert.equal(filter({})(endpoint('/style.css')), true);
  assert.equal(filter({ exclude_extensions: [] })(endpoint('/style.css')), true);
});

const records = [
  '/api/profile?q=ordinary-search',
  '/style.css?v=1',
  'https://api.example.com/items',
  'https://other.test/items',
].map((url) => ({
  type: 'endpoint',
  url,
  method: 'GET',
  kind: url.startsWith('/style.css') ? 'stringLiteral' : 'fetch',
  query_params: [],
  body_params: [],
}));
const output = Buffer.from(
  [
    ...records,
    { type: 'secret', kind: 'genericSecret', data: { value: 'synthetic-secret-fixture' } },
    {
      type: 'done',
      version: JSLUICE_VERSION,
      truncated: false,
      secrets_truncated: false,
      syntax_error: false,
    },
  ]
    .map(JSON.stringify)
    .join('\n'),
);

test('Query redaction is opt-in and leaves parameter metadata intact', () => {
  for (const redact of [undefined, false, true]) {
    const result = normalize(output, digest, 'https://app.example.com/', redact);
    const found = result.endpoints.find((e) => e.value.startsWith('/api/profile'));
    assert.equal(found.value, `/api/profile?q=${redact ? 'REDACTED' : 'ordinary-search'}`);
    assert.deepEqual(found.query_params, ['q']);
    assert.equal(result.sensitive.includes('ordinary-search'), false);
  }
});

test('Visible query values preserve duplicates and mask detected secrets after URL decoding', () => {
  const secret = 'synthetic & fixture';
  const records = [
    {
      type: 'endpoint',
      url: '/api?q=one&q=two&token=synthetic+%26+fixture&empty=#fragment',
      method: 'GET',
      kind: 'fetch',
      query_params: [],
      body_params: [],
    },
    { type: 'secret', kind: 'genericSecret', data: { value: secret } },
    {
      type: 'done',
      version: JSLUICE_VERSION,
      truncated: false,
      secrets_truncated: false,
      syntax_error: false,
    },
  ];
  const result = normalize(Buffer.from(records.map(JSON.stringify).join('\n')), digest);
  const found = result.endpoints[0];
  assert.equal(found.value, '/api?q=one&q=two&token=REDACTED&empty=');
  assert.deepEqual(found.query_params, ['empty', 'q', 'token']);
});

test('API filters cached extraction per request, preserving secrets and original sources', async (t) => {
  const token = 'endpoint_filter_fixture_token_not_for_production';
  const worker = {
    healthy: true,
    calls: 0,
    output,
    async pin() {
      return { identity: 'filter-fixture-v1', worker: this };
    },
    async run() {
      this.calls++;
      return {
        status: 'success',
        version: JSLUICE_VERSION,
        errorCode: null,
        durationMs: 1,
        output: this.output,
      };
    },
  };
  const app = buildApp(
    {
      database: ':memory:',
      tokens: [
        {
          sha256: digest(token),
          project_id: 'fixture',
          permissions: ['analysis:write', 'analysis:read', 'source:read'],
        },
      ],
    },
    { worker },
  );
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${token}` };
  const content = 'const fixture = 1;';
  const analyze = async (extra) => {
    const res = await app.inject({
      method: 'POST',
      url: '/analyze',
      headers,
      payload: {
        content,
        tools: ['jsluice'],
        base_url: 'https://app.example.com/',
        ...extra,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(validateContract('AnalyzeResponse', res.json()).ok, true);
    return res.json();
  };
  const all = await analyze({});
  assert.equal(all.endpoints.length, 4);
  const fqdn = await analyze({ endpoint_scope: 'same_fqdn', exclude_extensions: ['css'] });
  assert.equal(fqdn.endpoints.length, 1);
  assert.equal(fqdn.endpoints[0].value, '/api/profile?q=ordinary-search');
  const domain = await analyze({ endpoint_scope: 'same_domain', exclude_extensions: ['css'] });
  assert.equal(domain.endpoints.length, 2);
  const changedBase = await analyze({
    base_url: 'https://unrelated.test/',
    endpoint_scope: 'same_fqdn',
    exclude_extensions: ['css'],
  });
  // Relative paths remain associated with the explicit document base.
  assert.equal(changedBase.endpoints.length, 1);
  for (const result of [fqdn, domain, changedBase]) {
    assert.equal(result.cache.status, 'hit');
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.secrets, all.secrets);
    assert.equal(result.truncation.truncated, false);
  }
  assert.equal((await analyze({ endpoint_scope: 'all' })).endpoints.length, 4);
  const redacted = await analyze({ redact_query_values: true });
  assert.equal(
    redacted.endpoints.find((e) => e.value.startsWith('/api/profile')).value,
    '/api/profile?q=REDACTED',
  );
  assert.equal(redacted.cache.status, 'hit');
  const visible = await analyze({ redact_query_values: false });
  assert.deepEqual(visible.endpoints, all.endpoints);
  const medium = await analyze({ min_confidence: 'medium' });
  assert.equal(medium.endpoints.length, 3);
  assert.deepEqual(medium.secrets, all.secrets);
  const high = await analyze({ min_confidence: 'high' });
  assert.deepEqual(high.endpoints, []);
  assert.deepEqual(high.secrets, []);
  assert.equal(high.status, 'complete');
  assert.equal(high.truncation.truncated, false);
  assert.equal(high.cache.status, 'hit');
  assert.equal(worker.calls, 1);
  worker.output = Buffer.from(
    output
      .toString()
      .split('\n')
      .filter((line) => {
        const record = JSON.parse(line);
        return record.type !== 'endpoint' || record.url.startsWith('https://');
      })
      .join('\n'),
  );
  const empty = await analyze({ content: 'const absolute = 1;', endpoint_scope: 'same_fqdn' });
  assert.deepEqual(empty.endpoints, []);
  assert.equal(empty.status, 'complete');
  assert.equal(empty.coverage.endpoints, 'complete');
  assert.equal(empty.truncation.truncated, false);
  assert.deepEqual(empty.secrets, all.secrets);
  const source = await app.inject({ url: `/source/${fqdn.handle}/original/bundle.js`, headers });
  assert.equal(source.statusCode, 200);
  assert.equal(source.json().content, content);
  const invalid = await app.inject({
    method: 'POST',
    url: '/analyze',
    headers,
    payload: {
      content,
      tools: ['jsluice'],
      endpoint_scope: 'same_fqdn',
    },
  });
  assert.equal(invalid.statusCode, 400);
});
