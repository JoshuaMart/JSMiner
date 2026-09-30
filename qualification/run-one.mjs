import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { AnalysisEngine } from '../apps/api/dist/analysis.js';
import { parseConfig } from '../apps/api/dist/config.js';
import { openMetadataStore } from '../apps/api/dist/storage.js';
import { DockerWorker, OFFLINE_VERSION } from '../packages/adapters/dist/index.js';
import { validateContract } from '../packages/contracts/dist/index.js';
import { measuredCommand } from './command.mjs';
import { hash } from './harness.mjs';
import { categories, score } from './scoring.mjs';

const context = JSON.parse(process.env.JSMINER_QUALIFICATION ?? '{}');
if (
  !/^qualification-[a-f0-9-]{36}$/.test(context.owner ?? '') ||
  !['jsminer-jsluice:qualification', 'jsminer-offline:qualification'].every((tag) =>
    /^sha256:[a-f0-9]{64}$/.test(context.images?.[tag] ?? ''),
  )
)
  throw new Error('Run qualification through its parent harness.');
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const policyBytes = readFileSync(new URL('./policy.json', import.meta.url));
if (hash(corpusBytes) !== context.corpus_hash || hash(policyBytes) !== context.policy_hash)
  throw new Error('Qualification inputs changed during the run.');
const corpus = JSON.parse(corpusBytes),
  policy = JSON.parse(policyBytes);
const fixture =
  process.argv[2] === 'large-single-line'
    ? (await import('./stress-fixture.mjs')).stressFixture
    : corpus.cases.find((item) => item.id === process.argv[2]);
const profile = process.argv[3],
  tools = policy.profiles[profile];
if (!fixture || !tools) throw new Error('Unknown qualification case or profile.');
const samples = [],
  owner = context.owner;
const command = measuredCommand(samples);
const workers = Object.fromEntries(
  tools.map((name) => [
    name,
    name === 'jsluice'
      ? new DockerWorker(context.images['jsminer-jsluice:qualification'], owner, command)
      : new DockerWorker(
          context.images['jsminer-offline:qualification'],
          owner,
          command,
          undefined,
          {
            version: OFFLINE_VERSION,
            protocol: '1',
            command: [name],
            maxBytes: ['webcrack', 'wakaru'].includes(name) ? 96 * 1024 * 1024 : 2 * 1024 * 1024,
            tmpfsBytes: 128 * 1024 * 1024,
          },
        ),
  ]),
);
const config = parseConfig({
  database: ':memory:',
  cache: { enabled: false },
  tokens: [{ sha256: 'a'.repeat(64), project_id: 'fixture', permissions: ['analysis:write'] }],
});
const db = openMetadataStore(config.database);
const engine = new AnalysisEngine(config, db.database, { workers });
const abort = () => engine.abort();
process.once('SIGTERM', abort);
process.once('SIGINT', abort);
try {
  const started = performance.now();
  const response = await engine.analyze(
    'fixture',
    { content: fixture.content, tools, reference_domains: fixture.reference_domains },
    new AbortController().signal,
  );
  const duration_ms = Math.ceil(performance.now() - started);
  if (!validateContract('AnalyzeResponse', response).ok) throw new Error('Invalid response.');
  const observed = {
    endpoints: response.endpoints.map((x) => x.value),
    secrets: response.secrets.map((x) => `${x.kind}:${x.fingerprint}`),
    gql_operations: response.gql_operations.map((x) => `${x.operation_type}:${x.name}`),
    subdomains: response.subdomains.map((x) => x.hostname),
  };
  const expected = {
    ...fixture.expected,
    secrets: fixture.expected.secrets.map(
      (x) =>
        `${x.kind}:hmac-sha256:${engine.store.mac('fixture', JSON.stringify([...new Set(x.values)].sort()))}`,
    ),
  };
  const quality = Object.fromEntries(categories.map((c) => [c, score(expected[c], observed[c])]));
  const manifest = engine.store.list('fixture', response.handle, 100);
  const fragment = engine.store.read('fixture', response.handle, 'original/bundle.js', 0, 65536);
  if (
    !validateContract('SourceResponse', fragment).ok ||
    !fixture.content.startsWith(fragment.content)
  )
    throw new Error('Invalid source fragment.');
  if (Buffer.byteLength(fixture.content) > 65536 && fragment.next_offset === null)
    throw new Error('Unbounded source read.');
  for (const category of categories)
    for (const observation of response[category])
      for (const evidence of observation.evidence) {
        if (!manifest.modules.some((m) => m.path === evidence.module_path))
          throw new Error('Broken provenance.');
      }
  for (const secret of fixture.expected.secrets)
    for (const value of secret.values)
      if (JSON.stringify(response).includes(value)) throw new Error('Unmasked fixture secret.');
  const row = db.database.prepare('SELECT bytes FROM analyses WHERE handle=?').get(response.handle);
  const report = {
    case: fixture.id,
    profile,
    incomplete: fixture.incomplete,
    quality,
    status: response.status,
    truncation: response.truncation,
    tools: response.tools.map(({ name, status, error_code, duration_ms }) => ({
      name,
      status,
      error_code,
      duration_ms,
    })),
    resources: {
      duration_ms,
      api_peak_bytes: process.resourceUsage().maxRSS * 1024,
      worker_peak_bytes: Math.max(0, ...samples.map((s) => s.peak_bytes ?? 0)),
      worker_samples: samples.length,
      missing_memory_samples: samples.filter((s) => s.peak_bytes === null).length,
      artifact_bytes: Number(row.bytes),
      source_bytes: manifest.modules.reduce((sum, m) => sum + m.bytes, 0),
      response_bytes: Buffer.byteLength(JSON.stringify(response)),
      modules: manifest.total_modules,
    },
    differences: Object.fromEntries(
      categories
        .filter((c) => c !== 'secrets')
        .map((c) => [
          c,
          {
            missing: expected[c].filter((x) => !observed[c].includes(x)),
            unexpected: observed[c].filter((x) => !expected[c].includes(x)),
          },
        ]),
    ),
  };
  const leftovers = await command(['ps', '-aq', '--filter', `label=io.jsminer.owner=${owner}`], {
    timeoutMs: 10000,
    maxBytes: 65536,
  });
  if (leftovers.fault || leftovers.code || leftovers.output.toString().trim())
    throw new Error('Unconfirmed worker cleanup.');
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await engine.close();
  db.close();
}
