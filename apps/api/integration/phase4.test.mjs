import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { validateContract } from '@jsminer/contracts';
import { buildApp } from '../dist/app.js';

const token = 'phase4_integration_fixture_not_for_production';
const headers = { authorization: `Bearer ${token}` };
const configuration = {
  database: ':memory:',
  tokens: [
    {
      sha256: createHash('sha256').update(token).digest('hex'),
      project_id: 'fixture',
      permissions: ['analysis:read', 'analysis:write', 'source:read'],
    },
  ],
};
const request = (app, payload) => app.inject({ method: 'POST', url: '/analyze', headers, payload });

test('authorized gzip capture feeds real isolated jsluice; cache recomputes base URL and preserves original bytes', async (t) => {
  const bytes = Buffer.from('\ufefffetch("/api/profile");\r\n');
  let captures = 0;
  const server = createServer((_req, res) => {
    captures++;
    res.setHeader('content-encoding', 'gzip');
    res.end(gzipSync(bytes));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = buildApp({
    ...configuration,
    capture: { origins: [{ origin, allow_private: true }] },
  });
  t.after(() => app.close());
  const payload = {
    url: `${origin}/one`,
    tools: ['jsluice'],
    script_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    base_url: 'https://one.example/base/',
  };
  const first = await request(app, payload);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().status, 'complete', first.body);
  const second = await request(app, {
    ...payload,
    url: `${origin}/two`,
    base_url: 'https://two.example/base/',
  });
  assert.equal(second.statusCode, 200, second.body);
  const r = second.json();
  assert.equal(validateContract('AnalyzeResponse', r).ok, true);
  assert.equal(r.cache.status, 'hit');
  assert.equal(r.tools[0].duration_ms, 0);
  assert.equal(r.endpoints[0].resolved_url, 'https://two.example/api/profile');
  assert.notEqual(first.json().handle, r.handle);
  assert.equal(captures, 2);
  const source = await app.inject({ url: `/source/${r.handle}/original/bundle.js`, headers });
  assert.equal(source.json().content, bytes.toString());
});

test('real transformation and detector steps are reused with independent source handles', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  const payload = {
    content:
      'const query = gql`query Viewer { viewer { id } }`; fetch("https://api.example.com/profile");',
    reference_domains: ['example.com'],
  };
  const first = await request(app, payload);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().status, 'complete', first.body);
  const second = await request(app, payload);
  assert.equal(second.statusCode, 200, second.body);
  const r = second.json();
  assert.equal(validateContract('AnalyzeResponse', r).ok, true);
  assert.equal(r.cache.status, 'hit', second.body);
  assert.ok(r.tools.every((tool) => tool.cache_hit && tool.duration_ms === 0));
  for (const category of ['endpoints', 'secrets', 'gql_operations', 'subdomains'])
    assert.deepEqual(r[category], first.json()[category]);
  const manifest = async (handle) =>
    (await app.inject({ url: `/source/${handle}`, headers })).json();
  assert.deepEqual(
    (await manifest(r.handle)).modules,
    (await manifest(first.json().handle)).modules,
  );
});
