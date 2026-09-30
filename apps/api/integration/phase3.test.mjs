import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { DockerWorker, dockerCommand, OFFLINE_VERSION } from '@jsminer/adapters';
import { validateContract } from '@jsminer/contracts';
import { buildApp } from '../dist/app.js';

const exec = promisify(execFile);
const token = 'phase3_fixture_not_for_production',
  headers = { authorization: `Bearer ${token}` };
const configuration = {
  database: ':memory:',
  tokens: [
    {
      sha256: createHash('sha256').update(token).digest('hex'),
      project_id: 'fixture',
      permissions: ['analysis:write', 'analysis:read', 'source:read'],
    },
  ],
};
const request = (app, payload) => app.inject({ method: 'POST', url: '/analyze', headers, payload });

test('full offline profile traverses bundle transformations, merges synthetic secrets and retains source positions', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  const secret = 'ghp_r8VnP5kQ2xL9mT4bZ7hD6sF3cY1wA0uE5jK9';
  const content = `/* é fixture */ (self.webpackChunk=self.webpackChunk||[]).push([[1],{42:function(module,exports,require){const token="${secret}"; const document = gql\`query Profile($id: ID!) { alias: user(id:$id) { name } }\`; fetch("https://api.example.com/v1?token=synthetic");}}]);`;
  const response = await request(app, { content, reference_domains: ['example.com'] });
  assert.equal(response.statusCode, 200, response.body);
  const r = response.json();
  assert.equal(validateContract('AnalyzeResponse', r).ok, true);
  assert.equal(r.status, 'partial', response.body);
  assert.deepEqual(r.truncation.reasons, ['evidence_count']);
  assert.ok(r.tools.every((tool) => tool.status === 'success'));
  assert.equal(r.tools.find((t) => t.name === 'wakaru').input_path, 'webcrack/bundle.js');
  assert.equal(r.secrets.length, 1, response.body);
  assert.deepEqual([...new Set(r.secrets[0].evidence.map((e) => e.tool))].sort(), [
    'jsluice',
    'trufflehog',
  ]);
  assert.ok(!response.body.includes(secret));
  assert.ok(r.endpoints.some((e) => e.value === 'https://api.example.com/v1?token=synthetic'));
  assert.equal(r.gql_operations.length, 1);
  assert.deepEqual(r.gql_operations[0].root_fields, ['user']);
  assert.equal(r.subdomains[0].hostname, 'api.example.com');
  const manifest = (await app.inject({ url: `/source/${r.handle}`, headers })).json();
  assert.ok(manifest.total_modules >= 4);
  assert.ok(manifest.modules.some((m) => m.path.startsWith('webcrack/modules/')));
  for (const module of manifest.modules)
    if (module.parent_path)
      assert.ok(manifest.modules.some((parent) => parent.path === module.parent_path));
  for (const e of r.gql_operations[0].evidence) {
    const source = (
      await app.inject({ url: `/source/${r.handle}/${e.module_path}`, headers })
    ).json();
    assert.match(
      Buffer.from(source.content).subarray(e.location.start_byte, e.location.end_byte).toString(),
      /query Profile/,
    );
  }
});
test('static extractors handle fragments, incomplete documents, UTF-8, domain boundaries and explicit selections', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  const content =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture contains an unevaluated template interpolation.
    'const é="préfixe"; const a=gql`query One($id: ID! = "private") { ...Root } fragment Root on Query { alias: user(id:$id){name} }`;const b=gql`query Two { ${unknown} }`; const c=gql`fragment Only on Query { ignored }`; const urls=["https://deep.api.example.com/path","https://example.com","https://api.example.com.other.test","*.example.com","https://bücher.example.com"];while(true){}';
  const response = await request(app, {
    content,
    tools: ['graphql', 'domains'],
    reference_domains: ['example.com', 'api.example.com'],
  });
  assert.equal(response.statusCode, 200, response.body);
  const r = response.json();
  assert.equal(r.status, 'partial');
  assert.deepEqual(
    r.tools.map((t) => t.name),
    ['graphql', 'domains'],
  );
  assert.equal(r.coverage.endpoints, 'not_requested');
  assert.equal(r.gql_operations.length, 1);
  assert.deepEqual(r.gql_operations[0].variables, [{ name: 'id', type: 'ID!' }]);
  assert.deepEqual(r.gql_operations[0].root_fields, ['user']);
  assert.ok(!response.body.includes('private'));
  assert.ok(r.warnings.some((w) => w.code === 'incomplete_document'));
  assert.equal(r.subdomains.length, 2);
  assert.equal(
    r.subdomains.find((d) => d.hostname === 'deep.api.example.com').reference_domain,
    'api.example.com',
  );
  assert.ok(r.subdomains.some((d) => d.hostname === 'xn--bcher-kva.example.com'));
  const e = r.gql_operations[0].evidence[0];
  assert.match(
    Buffer.from(content).subarray(e.location.start_byte, e.location.end_byte).toString(),
    /^`query One/,
  );
});
test('Node worker enforces offline, private temporary storage and whole-container cleanup', async () => {
  const owner = `phase3-${randomUUID()}`;
  let inspected = false;
  const command = async (args, options) => {
    if (args[0] === 'start') {
      const data = JSON.parse((await exec('docker', ['inspect', args.at(-1)])).stdout)[0];
      assert.equal(data.HostConfig.NetworkMode, 'none');
      assert.equal(data.HostConfig.ReadonlyRootfs, true);
      assert.equal(data.Config.User, '65532:65532');
      assert.equal(data.HostConfig.Memory, 256 * 1024 * 1024);
      assert.ok(data.HostConfig.Tmpfs['/tmp'].includes('size=134217728'));
      assert.ok(data.Mounts.every((m) => m.Type === 'tmpfs'));
      inspected = true;
    }
    return dockerCommand(args, options);
  };
  const worker = new DockerWorker('jsminer-offline:phase3', owner, command, undefined, {
    version: OFFLINE_VERSION,
    protocol: '1',
    command: ['graphql'],
    maxBytes: 2 * 1024 * 1024,
    tmpfsBytes: 128 * 1024 * 1024,
  });
  const result = await worker.run({
    content: Buffer.from(
      JSON.stringify({
        content: 'while(true){}; const q="query Q { hello }";',
        max_bytes: 1024,
        max_modules: 1,
      }),
    ),
    timeoutMs: 5000,
    cleanupMs: 10000,
    memoryBytes: 256 * 1024 * 1024,
    cpus: 1,
    pids: 32,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'success');
  assert.equal(inspected, true);
  assert.equal(JSON.parse(result.output).findings[0].name, 'Q');
  assert.equal(
    (
      await exec('docker', ['ps', '-aq', '--filter', `label=io.jsminer.owner=${owner}`])
    ).stdout.trim(),
    '',
  );
});
test('real transform output limits retain original without invented modules', async (t) => {
  const app = buildApp({ ...configuration, budgets: { module_count: 1 } });
  t.after(() => app.close());
  const response = await request(app, {
    content: 'const x = 1;',
    tools: ['webcrack', 'wakaru', 'jsluice'],
  });
  assert.equal(response.statusCode, 200, response.body);
  const r = response.json();
  assert.equal(r.status, 'partial');
  assert.ok(r.truncation.reasons.includes('module_count'));
  assert.ok(r.warnings.some((w) => w.code === 'fallback_to_original'));
  const manifest = (await app.inject({ url: `/source/${r.handle}`, headers })).json();
  assert.equal(manifest.total_modules, 1);
});

test('JSX and React output remains parseable across both real transformers', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  for (const content of [
    'const Button=()=>React.createElement("button",null,"Ok");',
    'const Button=()=> <button>Ok</button>;',
  ]) {
    const response = await request(app, { content, tools: ['webcrack', 'wakaru'] });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'complete', response.body);
  }
});

test('incomplete and ambiguous fragment graphs never claim complete GraphQL coverage', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  const documents = [
    'query Q { user { ...Missing } }',
    'query Q { ...F } fragment F on Query { ...F }',
    'query Q { ...F } fragment F on Query { a } fragment F on Query { b }',
  ];
  for (const document of documents) {
    const response = await request(app, {
      content: `const q=${JSON.stringify(document)};`,
      tools: ['graphql'],
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.status, 'partial');
    assert.equal(result.coverage.gql_operations, 'partial');
    assert.deepEqual(result.gql_operations, []);
    assert.ok(result.warnings.some((w) => w.code === 'incomplete_document'));
  }
});

test('large ordinary literal arrays do not overflow AST traversal or scan prefixes repeatedly', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  const content = `const values=[${Array.from({ length: 150000 }, () => '"ordinary"').join(',')}];`;
  const response = await request(app, { content, tools: ['graphql'] });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'complete', response.body);
  assert.deepEqual(response.json().gql_operations, []);
  const repeated = content.replaceAll('ordinary', 'api.example.com');
  const domains = await request(app, {
    content: repeated,
    tools: ['domains'],
    reference_domains: ['example.com'],
  });
  assert.equal(domains.statusCode, 200, domains.body);
  assert.equal(domains.json().tools[0].status, 'partial', domains.body);
  assert.equal(domains.json().tools[0].error_code, 'output_truncated');
  assert.equal(domains.json().subdomains.length, 1);
});

test('GraphQL findings obey the worker byte cap while retaining complete records', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  const fields = Array.from({ length: 128 }, (_, i) => `field${i}_${'a'.repeat(100)}`).join(' ');
  const document = Array.from({ length: 150 }, (_, i) => `query Q${i} { ${fields} }`).join('\n');
  const response = await request(app, {
    content: `const q=${JSON.stringify(document)};`,
    tools: ['graphql'],
  });
  assert.equal(response.statusCode, 200, response.body);
  const r = response.json();
  assert.equal(r.tools[0].status, 'partial');
  assert.equal(r.tools[0].error_code, 'output_truncated');
  assert.ok(r.gql_operations.length > 0);
  assert.ok(r.truncation.reasons.includes('finding_count'));
  assert.ok(!r.warnings.some((w) => w.code === 'incomplete_document'));
});

test('valid empty Wakaru outputs remain readable and analyzable by jsluice', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  const response = await request(app, {
    content: '// local comment-only fixture',
    tools: ['wakaru', 'jsluice'],
  });
  assert.equal(response.statusCode, 200, response.body);
  const r = response.json();
  assert.equal(r.status, 'complete', response.body);
  const source = await app.inject({ url: `/source/${r.handle}/wakaru/bundle.js`, headers });
  assert.equal(source.statusCode, 200, source.body);
  assert.equal(source.json().returned_bytes, 0);
  assert.equal(source.json().next_offset, null);
});

test('ordinary brace strings do not make GraphQL coverage incomplete', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  const response = await request(app, {
    content:
      'const ordinary=["{", "{}", "{not valid!", \'{"enabled":true}\']; const q="{ user { id } }";',
    tools: ['graphql'],
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.status, 'complete', response.body);
  assert.equal(result.gql_operations.length, 1);
  assert.deepEqual(result.gql_operations[0].root_fields, ['user']);
  const incomplete = await request(app, { content: 'const q=gql`{ user {`;', tools: ['graphql'] });
  assert.equal(incomplete.json().tools[0].error_code, 'incomplete_document');
});

test('real static worker respects configurable finding caps above and below its old limit', async (t) => {
  const content = `const q=${JSON.stringify(Array.from({ length: 230 }, (_, i) => `query Q${i} { hello }`).join('\n'))};`;
  for (const count of [3, 250]) {
    const app = buildApp({ ...configuration, budgets: { finding_count: count } });
    t.after(() => app.close());
    const response = await request(app, { content, tools: ['graphql'] });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.gql_operations.length, Math.min(count, 230));
    assert.equal(result.status, count < 230 ? 'partial' : 'complete');
  }
});

test('Node memory exhaustion is classified without exposing diagnostics and containers are removed', async () => {
  const owner = `memory-fixture-${randomUUID()}`;
  const worker = new DockerWorker('jsminer-offline:phase3', owner, undefined, undefined, {
    version: OFFLINE_VERSION,
    protocol: '1',
    command: ['graphql'],
    nodeHeap: true,
    maxBytes: 2 * 1024 * 1024,
    tmpfsBytes: 16 * 1024 * 1024,
  });
  const result = await worker.run({
    content: Buffer.from(JSON.stringify({ content: `const values=[${'0,'.repeat(200000)}];` })),
    timeoutMs: 15000,
    cleanupMs: 10000,
    memoryBytes: 96 * 1024 * 1024,
    cpus: 1,
    pids: 32,
    signal: new AbortController().signal,
  });
  assert.equal(result.errorCode, 'memory_limit');
  assert.equal(result.output.length, 0);
  assert.equal(
    (
      await exec('docker', ['ps', '-aq', '--filter', `label=io.jsminer.owner=${owner}`])
    ).stdout.trim(),
    '',
  );
});

test('real Wakaru unpack failure preserves its validated aggregate for downstream extraction', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  // A hoisted function captures a loader that is later reassigned.
  const content = `(() => {
    const modules = {
      0: (module, exports, require) => {
        observe(); require = require(1);
        function observe() { consume(require(2)); }
        module.exports = require;
      },
      1: module => { module.exports = "fixture-one"; },
      2: module => { module.exports = "fixture-two"; }
    };
    const cache = {};
    (function require(id) {
      const module = cache[id] = { exports: {} };
      modules[id](module, module.exports, require);
      return module.exports;
    })(0);
  })();`;
  const response = await request(app, { content, tools: ['wakaru', 'jsluice'] });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.tools[0].status, 'partial', response.body);
  assert.equal(result.tools[0].error_code, 'unpack_failed');
  assert.equal(result.tools[1].status, 'success');
  assert.equal(result.tools[1].modules_analyzed, 2);
  const source = await app.inject({ url: `/source/${result.handle}/wakaru/bundle.js`, headers });
  assert.equal(source.statusCode, 200, source.body);
  assert.ok(source.json().content.length > 0);
});
