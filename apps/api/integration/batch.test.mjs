import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DockerWorker, dockerCommand, OFFLINE_VERSION } from '@jsminer/adapters';
import { AnalysisEngine } from '../dist/analysis.js';
import { parseConfig } from '../dist/config.js';
import { openMetadataStore } from '../dist/storage.js';

const limits = () => ({
  timeoutMs: 15000,
  cleanupMs: 10000,
  memoryBytes: 2 * 1024 ** 3,
  cpus: 2,
  pids: 128,
  findingCount: 1000,
  signal: new AbortController().signal,
});
const profile = (name) => ({
  version: OFFLINE_VERSION,
  protocol: '1',
  command: [name],
  nodeHeap: true,
  maxBytes: name === 'webcrack' ? 96 * 1024 * 1024 : 2 * 1024 * 1024,
  tmpfsBytes: 128 * 1024 * 1024,
});

test('hundreds of modules use one container per extractor, retaining provenance and cache', async (t) => {
  const owner = `batch-fixture-${randomUUID()}`;
  const creates = {};
  const workers = Object.fromEntries(
    ['webcrack', 'jsluice', 'trufflehog', 'graphql'].map((name) => [
      name,
      new DockerWorker(
        name === 'jsluice' ? 'jsminer-jsluice:phase2' : 'jsminer-offline:phase3',
        owner,
        async (args, options) => {
          if (args[0] === 'create') creates[name] = (creates[name] ?? 0) + 1;
          return dockerCommand(args, options);
        },
        undefined,
        name === 'jsluice' ? undefined : profile(name),
      ),
    ]),
  );
  const config = parseConfig({
    database: ':memory:',
    tokens: [{ sha256: 'a'.repeat(64), project_id: 'fixture', permissions: ['analysis:write'] }],
    budgets: { finding_count: 1000 },
  });
  const store = openMetadataStore(':memory:');
  const engine = new AnalysisEngine(config, store.database, { workers });
  t.after(async () => {
    await engine.close();
    store.close();
  });
  const key = 'ghp_r8VnP5kQ2xL9mT4bZ7hD6sF3cY1wA0uE5jK9';
  const modules = Array.from(
    { length: 120 },
    (_, i) =>
      `${i}:function(module,exports,require){fetch('/fixture/${i}');const q="query Q${i} { hello }";${i === 0 ? `const token="${key}";` : ''}}`,
  ).join(',');
  const content = `(self.webpackChunk=self.webpackChunk||[]).push([[1],{${modules}}]);`;
  const analyze = () =>
    engine.analyze(
      'fixture',
      { content, tools: ['webcrack', 'jsluice', 'trufflehog', 'graphql'] },
      new AbortController().signal,
    );
  const first = await analyze();
  for (const tool of first.tools) {
    assert.equal(tool.status, 'success', JSON.stringify(first.tools));
    if (tool.modules_available !== null) {
      assert.ok(tool.modules_available >= 122);
      assert.equal(tool.modules_analyzed, tool.modules_available);
    }
  }
  assert.deepEqual(creates, { webcrack: 1, jsluice: 1, trufflehog: 1, graphql: 1 });
  assert.equal(first.endpoints.length, 120);
  assert.equal(first.gql_operations.length, 120);
  assert.ok(
    first.gql_operations.some((g) =>
      g.evidence.some((e) => e.module_path.startsWith('webcrack/modules/')),
    ),
  );
  const secret = first.secrets.find((s) => s.evidence.some((e) => e.tool === 'trufflehog'));
  assert.ok(secret);
  assert.ok(
    secret.evidence.some(
      (e) => e.tool === 'trufflehog' && e.module_path.startsWith('webcrack/modules/'),
    ),
  );
  assert.ok(!JSON.stringify(first).includes(key));
  assert.equal((await analyze()).cache.status, 'hit');
  assert.deepEqual(creates, { webcrack: 1, jsluice: 1, trufflehog: 1, graphql: 1 });
});

test('a malformed module does not cancel subsequent modules in a real Node batch', async () => {
  const worker = new DockerWorker(
    'jsminer-offline:phase3',
    `batch-errors-${randomUUID()}`,
    undefined,
    undefined,
    profile('graphql'),
  );
  const result = await worker.runBatch({
    ...limits(),
    contents: [
      'const q="query First { hello }";',
      'const = ;',
      'const q="query Last { hello }";',
    ].map((content) => Buffer.from(JSON.stringify({ content }))),
  });
  assert.equal(result.terminal, null);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ['success', 'error', 'success'],
  );
  assert.equal(JSON.parse(result.results[2].output).findings[0].name, 'Last');
});

test('a real memory failure preserves the preceding completed module and cleans the batch container', async () => {
  const worker = new DockerWorker(
    'jsminer-offline:phase3',
    `batch-memory-${randomUUID()}`,
    undefined,
    undefined,
    profile('graphql'),
  );
  const result = await worker.runBatch({
    ...limits(),
    memoryBytes: 96 * 1024 * 1024,
    contents: ['const q="query Complete { hello }";', `const values=[${'0,'.repeat(200000)}];`].map(
      (content) => Buffer.from(JSON.stringify({ content })),
    ),
  });
  assert.equal(result.terminal.errorCode, 'memory_limit');
  assert.equal(result.results.length, 1);
  assert.equal(JSON.parse(result.results[0].output).findings[0].name, 'Complete');
});
