import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerWorker, dockerCommand, OFFLINE_VERSION } from '@jsminer/adapters';
import { buildApp } from '../dist/app.js';

// No remote capture: identical local fixture sets, with the extraction cache disabled.
test('asynchronous jobs use bounded concurrent real containers and recover the owner only once', {
  timeout: 120000,
}, async (t) => {
  const token = 'jobs_integration_fixture_token_not_for_production';
  const headers = { authorization: `Bearer ${token}` };
  const items = Array.from({ length: 4 }, (_, i) => ({
    content: Array.from(
      { length: 1600 },
      (_, n) => `function item${i}_${n}(v){return v+${n};}`,
    ).join('\n'),
    tools: ['webcrack', 'graphql'],
  }));
  const measurements = [];
  for (const concurrency of [1, 2]) {
    const owner = `jobs-fixture-${randomUUID()}`;
    let active = 0,
      peak = 0,
      recoveryLists = 0,
      created = 0;
    const executing = new Set();
    const command = async (args, options) => {
      if (args[0] === 'ps' && args.includes(`label=io.jsminer.owner=${owner}`)) {
        recoveryLists++;
        assert.equal(active, 0, 'recovery must never remove another active worker');
      }
      if (args[0] === 'create') {
        created++;
        assert.ok(args.includes('--memory=2147483648'));
      }
      if (args[0] === 'start') {
        active++;
        peak = Math.max(peak, active);
        executing.add(args.at(-1));
      }
      const result = await dockerCommand(args, options);
      if (args[0] === 'ps' && args.at(-1)?.startsWith('name=^/')) {
        const name = args.at(-1).slice('name=^/'.length, -1);
        if (executing.delete(name)) active--;
      }
      return result;
    };
    const workers = Object.fromEntries(
      ['webcrack', 'graphql'].map((name) => [
        name,
        new DockerWorker('jsminer-offline:phase3', owner, command, undefined, {
          version: OFFLINE_VERSION,
          protocol: '1',
          command: [name],
          nodeHeap: true,
          maxBytes: name === 'webcrack' ? 96 * 1024 ** 2 : 2 * 1024 ** 2,
          tmpfsBytes: 128 * 1024 ** 2,
        }),
      ]),
    );
    const app = buildApp(
      {
        database: ':memory:',
        cache: { enabled: false },
        tokens: [
          {
            sha256: createHash('sha256').update(token).digest('hex'),
            project_id: 'fixture',
            permissions: ['analysis:write', 'analysis:read'],
          },
        ],
        budgets: {
          active_analyses: concurrency,
          active_workers: 2,
          total_worker_memory_bytes: 4 * 1024 ** 3,
        },
      },
      { workers },
    );
    try {
      await app.ready();
      const start = performance.now();
      const accepted = await app.inject({
        method: 'POST',
        url: '/jobs',
        headers,
        payload: { items, budget_ms: 60000 },
      });
      assert.equal(accepted.statusCode, 202, accepted.body);
      let job = accepted.json();
      const id = job.id;
      const acceptedMs = performance.now() - start;
      let firstResultMs = null;
      while (
        !['completed', 'timed_out', 'interrupted'].includes(job.status) &&
        performance.now() - start < 70000
      ) {
        await delay(25);
        job = (await app.inject({ url: `/jobs/${id}`, headers })).json();
        if (firstResultMs === null && job.items.some((item) => item.handle))
          firstResultMs = performance.now() - start;
      }
      assert.equal(job.status, 'completed', JSON.stringify(job));
      assert.ok(
        job.items.every((item) => item.status === 'complete'),
        JSON.stringify(job),
      );
      for (const item of job.items) {
        const result = await app.inject({ url: `/jobs/${id}/items/${item.index}`, headers });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().cache.status, 'miss');
      }
      assert.equal(created, 8);
      assert.equal(active, 0);
      assert.equal(peak, concurrency);
      assert.equal(recoveryLists, 2);
      const remaining = await dockerCommand(
        ['ps', '-aq', '--filter', `label=io.jsminer.owner=${owner}`],
        { timeoutMs: 5000, maxBytes: 65536 },
      );
      assert.equal(remaining.code, 0);
      assert.equal(remaining.output.toString().trim(), '');
      measurements.push({
        concurrency,
        accepted_ms: Math.round(acceptedMs),
        first_result_ms: Math.round(firstResultMs),
        total_ms: Math.round(performance.now() - start),
        peak_containers: peak,
      });
    } finally {
      await app.close();
    }
  }
  t.diagnostic(JSON.stringify(measurements));
});
