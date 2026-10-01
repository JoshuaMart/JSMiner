import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DockerWorker, dockerCommand, JSLUICE_VERSION } from '@jsminer/adapters';
import { validateContract } from '@jsminer/contracts';
import { buildApp } from '../dist/app.js';

const exec = promisify(execFile);
const docker = (...args) => exec('docker', args, { timeout: 120000, maxBuffer: 1024 * 1024 });
const token = 'docker_integration_fixture_not_for_production';
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

test('real jsluice extracts annotated local source, masks secrets and never evaluates code', async (t) => {
  await docker('image', 'inspect', 'jsminer-jsluice:phase2');
  const app = buildApp(configuration);
  t.after(() => app.close());
  const secret = `ghp_${'A'.repeat(36)}`;
  const fixtures = [
    {
      content: `const token = "${secret}"; fetch("/api/profile?access_token=fixture-value"); while(true) {} throw new Error("SOURCE_MARKER");`,
      endpoints: 1,
      endpointValue: '/api/profile?access_token=fixture-value',
      secrets: 1,
      status: 'complete',
    },
    { content: 'const version = 1;', endpoints: 0, secrets: 0, status: 'complete' },
    { content: 'function incomplete() {', endpoints: 0, secrets: 0, status: 'partial' },
    { content: 'function broken( {', endpoints: 0, secrets: 0, status: 'partial' },
    {
      content: Array.from({ length: 220 }, (_, i) => `fetch('/api/item/${i}');`).join('\n'),
      minEndpoints: 1,
      secrets: 0,
      status: 'partial',
    },
    {
      content:
        'const firebase={apiKey:"AIzaSYNTHETICfixture",authDomain:"fixture.test",projectId:"fixture",storageBucket:"fixture",extra:{nested:1}};',
      secrets: 1,
      status: 'complete',
    },
  ];
  for (const fixture of fixtures) {
    const response = await app.inject({
      method: 'POST',
      url: '/analyze',
      headers,
      payload: { content: fixture.content, tools: ['jsluice'], base_url: 'https://example.test/' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(validateContract('AnalyzeResponse', result).ok, true);
    assert.equal(result.status, fixture.status, response.body);
    if (fixture.minEndpoints)
      assert.ok(result.endpoints.length >= fixture.minEndpoints && result.endpoints.length <= 200);
    if (fixture.endpoints !== undefined)
      assert.equal(result.endpoints.length, fixture.endpoints, response.body);
    assert.equal(result.secrets.length, fixture.secrets, response.body);
    if (fixture.endpointValue)
      assert.ok(result.endpoints.some((e) => e.value === fixture.endpointValue));
    for (const marker of [secret, 'SOURCE_MARKER', 'AIzaSYNTHETICfixture'])
      assert.ok(!response.body.includes(marker));
    const source = await app.inject({
      url: `/source/${result.handle}/original/bundle.js`,
      headers,
    });
    assert.equal(source.json().content, fixture.content);
  }
});

test('real jsluice applies optional query redaction on cached output while always masking detected secrets', async (t) => {
  const app = buildApp(configuration);
  t.after(() => app.close());
  const secret = `ghp_${'B'.repeat(36)}`;
  const content = `const token = "${secret}"; fetch("/api/search?q=ordinary-query&access_token=${secret}");`;
  for (const [index, redact] of [undefined, true, false].entries()) {
    const response = await app.inject({
      method: 'POST',
      url: '/analyze',
      headers,
      payload: {
        content,
        tools: ['jsluice'],
        base_url: 'https://example.test/',
        ...(redact === undefined ? {} : { redact_query_values: redact }),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(validateContract('AnalyzeResponse', result).ok, true);
    assert.equal(result.status, 'complete');
    assert.equal(result.cache.status, index === 0 ? 'miss' : 'hit');
    assert.equal(result.endpoints.length, 1);
    const url = new URL(result.endpoints[0].resolved_url);
    assert.equal(url.searchParams.get('q'), redact ? 'REDACTED' : 'ordinary-query');
    assert.equal(url.searchParams.get('access_token'), 'REDACTED');
    assert.ok(result.secrets.some((s) => s.kind === 'github'));
    assert.ok(result.secrets.every((s) => s.masked_value === '[REDACTED]'));
    assert.ok(!response.body.includes(secret));
  }
});

test('real containers enforce isolation and leave no worker after failure, timeout, output overflow or abort', async (t) => {
  const suffix = randomUUID();
  const image = `jsminer-lifecycle-fixture:${suffix}`;
  const owner = `fixture-${suffix}`;
  const directory = fileURLToPath(new URL('./fixture-worker', import.meta.url));
  await docker(
    'build',
    '--build-arg',
    `JSLUICE_VERSION=${JSLUICE_VERSION}`,
    '-t',
    image,
    directory,
  );
  t.after(async () => {
    const ids = (await docker('ps', '-aq', '--filter', `label=io.jsminer.owner=${owner}`)).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length) await docker('rm', '--force', ...ids);
    await docker('image', 'rm', image);
  });
  // Trigger the intended timeout during execution, after Docker has confirmed creation.
  const batchCommand = (args, options) =>
    dockerCommand(args, {
      ...options,
      timeoutMs: args[0] === 'start' ? Math.min(options.timeoutMs, 1500) : options.timeoutMs,
    });
  const batchWorker = new DockerWorker(image, owner, batchCommand, undefined, {
    version: JSLUICE_VERSION,
    protocol: '3',
    command: ['batch-timeout'],
    maxBytes: 1024,
  });
  const batch = await batchWorker.runBatch({
    contents: [Buffer.from('first'), Buffer.from('second')],
    timeoutMs: 15000,
    cleanupMs: 10000,
    memoryBytes: 128 * 1024 * 1024,
    cpus: 1,
    pids: 32,
    signal: new AbortController().signal,
  });
  assert.equal(batch.terminal.errorCode, 'timeout');
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].output.toString(), 'ok');
  assert.equal(
    (await docker('ps', '-aq', '--filter', `label=io.jsminer.owner=${owner}`)).stdout.trim(),
    '',
  );
  for (const scenario of ['error', 'output', 'timeout', 'abort']) {
    const controller = new AbortController();
    let checked = false;
    const command = async (args, options) => {
      if (args[0] === 'start') {
        const inspection = JSON.parse((await docker('inspect', args.at(-1))).stdout)[0];
        assert.equal(inspection.HostConfig.NetworkMode, 'none');
        assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
        assert.equal(inspection.HostConfig.Memory, 128 * 1024 * 1024);
        assert.equal(inspection.HostConfig.PidsLimit, 32);
        assert.deepEqual(inspection.Mounts, []);
        checked = true;
        if (scenario === 'abort') setTimeout(() => controller.abort(), 250);
      }
      return dockerCommand(args, {
        ...options,
        timeoutMs:
          scenario === 'timeout' && args[0] === 'start'
            ? Math.min(options.timeoutMs, 1500)
            : options.timeoutMs,
      });
    };
    const worker = new DockerWorker(image, owner, command);
    const result = await worker.run({
      content: Buffer.from(['timeout', 'abort'].includes(scenario) ? 'sleep' : scenario),
      timeoutMs: 15000,
      cleanupMs: 10000,
      memoryBytes: 128 * 1024 * 1024,
      cpus: 1,
      pids: 32,
      signal: controller.signal,
    });
    assert.equal(checked, true);
    assert.equal(result.status, scenario === 'timeout' ? 'timeout' : 'error');
    assert.equal(
      result.errorCode,
      { error: 'worker_failed', output: 'output_limit', timeout: 'timeout', abort: 'aborted' }[
        scenario
      ],
    );
    assert.equal(result.output.length, 0);
    assert.equal(worker.healthy, true);
    assert.equal(
      (await docker('ps', '-aq', '--filter', `label=io.jsminer.owner=${owner}`)).stdout.trim(),
      '',
    );
  }
});

test('HTTP disconnect and service close abort a running worker before shutdown returns', async (t) => {
  // The container lifecycle is covered above; this test checks the actual HTTP signal wiring.
  for (const action of ['disconnect', 'shutdown']) {
    let entered, stopped;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const finished = new Promise((resolve) => {
      stopped = resolve;
    });
    const worker = {
      healthy: true,
      run(input) {
        entered();
        return new Promise((resolve) =>
          input.signal.addEventListener(
            'abort',
            () => {
              stopped();
              resolve({
                status: 'error',
                errorCode: 'aborted',
                durationMs: 1,
                version: null,
                output: Buffer.alloc(0),
              });
            },
            { once: true },
          ),
        );
      },
    };
    const app = buildApp(configuration, { worker });
    t.after(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const request = fetch(`${address}/analyze`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'const x=1;', tools: ['jsluice'] }),
      signal: controller.signal,
    }).catch(() => null);
    await started;
    if (action === 'disconnect') controller.abort();
    else await app.close();
    await finished;
    await request;
    if (action === 'disconnect') await app.close();
  }
});

test('updated jsluice grammar accepts modern syntax and worker finding caps are configurable', async (t) => {
  const content =
    'const n = x?.5:0; const {a:b=()=>{},c:d=1} = x; class A { #x = 1; static {this.x=2;} has(o) {return #x in o;} }' +
    Array.from({ length: 230 }, (_, i) => `fetch('/fixture/${i}');`).join('\n');
  for (const limit of [3, 1000]) {
    const app = buildApp({ ...configuration, budgets: { finding_count: limit } });
    t.after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/analyze',
      headers,
      payload: { content, tools: ['jsluice'] },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.status, limit < 230 ? 'partial' : 'complete', response.body);
    if (limit === 1000) assert.equal(result.endpoints.length, 230);
    else assert.ok(result.endpoints.length > 0 && result.endpoints.length <= limit);
    assert.notEqual(result.tools[0].error_code, 'syntax_incomplete');
  }
});
