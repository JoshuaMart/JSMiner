import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CleanupError, JSLUICE_VERSION } from '@jsminer/adapters';
import { validateContract } from '@jsminer/contracts';
import { AnalysisEngine } from '../dist/analysis.js';
import { buildApp } from '../dist/app.js';
import { parseConfig } from '../dist/config.js';
import { openMetadataStore } from '../dist/storage.js';

const token = 'jobs_fixture_token_not_for_production';
const headers = (suffix = '') => ({ authorization: `Bearer ${token}${suffix}` });
const configuration = (extra = {}) => ({
  database: ':memory:',
  tokens: ['', '_other', '_read'].map((suffix) => ({
    sha256: createHash('sha256')
      .update(token + suffix)
      .digest('hex'),
    project_id: suffix === '_other' ? 'other' : 'test',
    permissions:
      suffix === '_read' ? ['analysis:read'] : ['analysis:read', 'analysis:write', 'source:read'],
  })),
  ...extra,
});
const payload = (names, budget_ms = 5000) => ({
  items: names.map((name) => ({ content: `const ${name}=1;`, tools: ['jsluice'] })),
  budget_ms,
});
const result = () => ({
  status: 'success',
  version: JSLUICE_VERSION,
  errorCode: null,
  durationMs: 1,
  output: Buffer.from(
    `${JSON.stringify({ type: 'done', version: JSLUICE_VERSION, truncated: false, secrets_truncated: false, syntax_error: false })}\n`,
  ),
});
function controlled() {
  const calls = [];
  let active = 0,
    peak = 0;
  return {
    calls,
    healthy: true,
    get peak() {
      return peak;
    },
    run(input) {
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        let settled = false;
        const done = (value = result()) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          input.signal.removeEventListener('abort', abort);
          active--;
          resolve(value);
        };
        const abort = () =>
          done({ ...result(), status: 'error', errorCode: 'aborted', output: Buffer.alloc(0) });
        const timer = setTimeout(
          () =>
            done({ ...result(), status: 'timeout', errorCode: 'timeout', output: Buffer.alloc(0) }),
          input.timeoutMs,
        );
        input.signal.addEventListener('abort', abort, { once: true });
        calls.push({ done, input });
        if (input.signal.aborted) abort();
      });
    },
  };
}
async function until(fn) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(5);
  }
  throw new Error('Condition did not become true');
}
async function setup(t, extra = {}, worker = controlled()) {
  const app = buildApp(configuration(extra), { worker });
  t.after(() => app.close());
  await app.ready();
  const submit = async (value) => {
    const response = await app.inject({
      method: 'POST',
      url: '/jobs',
      headers: headers(),
      payload: value,
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.headers.location, `/jobs/${response.json().id}`);
    assert.equal(validateContract('JobResponse', response.json()).ok, true);
    return response.json();
  };
  const get = async (id) => (await app.inject({ url: `/jobs/${id}`, headers: headers() })).json();
  return { app, worker, submit, get };
}

test('job returns immediately and exposes isolated per-item results while other work is running', async (t) => {
  const { app, worker, submit, get } = await setup(t, { budgets: { active_analyses: 2 } });
  const job = await submit(payload(['one', 'two', 'three']));
  assert.equal(job.status, 'queued');
  await until(() => worker.calls.length === 2);
  assert.equal(worker.peak, 2);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/analyze',
        headers: headers(),
        payload: payload(['sync']).items[0],
      })
    ).statusCode,
    429,
  );
  worker.calls[0].done();
  const partial = await until(async () => {
    const row = await get(job.id);
    return row.items[0].handle && row;
  });
  assert.equal(partial.status, 'running');
  assert.equal(partial.items[0].status, 'complete');
  assert.equal(JSON.stringify(partial).includes('const one'), false);
  const read = await app.inject({ url: `/jobs/${job.id}/items/0`, headers: headers() });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(validateContract('AnalyzeResponse', read.json()).ok, true);
  assert.equal(read.json().handle, partial.items[0].handle);
  for (const path of [`/jobs/${job.id}`, `/jobs/${job.id}/items/0`])
    assert.equal((await app.inject({ url: path, headers: headers('_other') })).statusCode, 404);
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/jobs/${job.id}`, headers: headers('_read') }))
      .statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url: `/jobs/${job.id}/items/1`, headers: headers() })).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ url: `/jobs/${job.id}/items/49`, headers: headers() })).statusCode,
    404,
  );
  await until(() => worker.calls.length === 3);
  worker.calls[1].done();
  worker.calls[2].done();
  const end = await until(async () => {
    const row = await get(job.id);
    return row.status === 'completed' && row;
  });
  assert.ok(end.items.every((item) => item.status === 'complete'));
  assert.equal(worker.peak, 2);
});

test('memory budget limits slots even when higher concurrency is configured', async (t) => {
  const { worker, submit, get } = await setup(t, {
    budgets: { active_analyses: 4, active_workers: 4, total_worker_memory_bytes: 2147483648 },
  });
  const job = await submit(payload(['one', 'two']));
  await until(() => worker.calls.length === 1);
  await delay(40);
  assert.equal(worker.calls.length, 1);
  worker.calls[0].done();
  await until(() => worker.calls.length === 2);
  worker.calls[1].done();
  await until(async () => (await get(job.id)).status === 'completed');
  assert.equal(worker.peak, 1);
});

test('global deadline counts queue time and never starts remaining items', async (t) => {
  const { worker, submit, get } = await setup(t);
  const blocker = await submit(payload(['blocker']));
  await until(() => worker.calls.length === 1);
  const job = await submit(payload(['one', 'two'], 30));
  const end = await until(async () => {
    const row = await get(job.id);
    return row.status === 'timed_out' && row;
  });
  assert.ok(
    end.items.every((item) => item.status === 'skipped' && item.error_code === 'job_deadline'),
  );
  assert.equal(worker.calls.length, 1);
  worker.calls[0].done();
  await until(async () => (await get(blocker.id)).status === 'completed');
});

test('running item uses remaining global budget and preserves an earlier completed result', async (t) => {
  const { worker, submit, get } = await setup(t);
  const job = await submit(payload(['one', 'two', 'three'], 150));
  await until(() => worker.calls.length === 1);
  worker.calls[0].done();
  await until(() => worker.calls.length === 2);
  assert.ok(worker.calls[1].input.timeoutMs < 150);
  const end = await until(async () => {
    const row = await get(job.id);
    return row.status === 'timed_out' && row;
  });
  assert.equal(end.items[0].status, 'complete');
  assert.equal(end.items[1].status, 'failed');
  assert.ok(end.items[1].handle);
  assert.equal(end.items[2].status, 'skipped');
  assert.equal(worker.calls.length, 2);
});

test('cancel retains completed results, aborts active work and skips queued work; repeated cancel is safe', async (t) => {
  const { app, worker, submit, get } = await setup(t);
  const job = await submit(payload(['one', 'two', 'three']));
  await until(() => worker.calls.length === 1);
  worker.calls[0].done();
  await until(() => worker.calls.length === 2);
  const cancel = () => app.inject({ method: 'DELETE', url: `/jobs/${job.id}`, headers: headers() });
  assert.equal((await cancel()).statusCode, 200);
  const end = await until(async () => {
    const row = await get(job.id);
    return row.status === 'cancelled' && row;
  });
  assert.equal(end.items[0].status, 'complete');
  assert.equal(end.items[1].error_code, 'job_cancelled');
  assert.equal(end.items[1].handle, null);
  assert.equal(end.items[2].status, 'skipped');
  assert.deepEqual((await cancel()).json(), end);
  assert.equal(worker.calls.length, 2);
});

test('job admission validates every item, permissions, count, bytes and budget', async (t) => {
  const { app, submit } = await setup(t, { jobs: { max_jobs: 1 } });
  const post = (value, suffix = '') =>
    app.inject({ method: 'POST', url: '/jobs', headers: headers(suffix), payload: value });
  assert.equal((await post(payload(['one']), '_read')).statusCode, 403);
  assert.equal((await post({ items: [] })).statusCode, 400);
  assert.equal(
    (await post(payload(Array.from({ length: 51 }, (_, i) => `x${i}`)))).statusCode,
    400,
  );
  assert.equal(
    (await post({ items: [{ content: 'x', url: 'https://example.invalid/x.js' }] })).statusCode,
    400,
  );
  assert.equal((await post({ items: [{ content: '\ud800' }] })).statusCode, 422);
  assert.equal(
    (await post({ items: [{ content: 'x', endpoint_scope: 'same_domain' }] })).statusCode,
    400,
  );
  assert.equal((await post(payload(['one'], 300001))).json().error.code, 'job_budget_exceeded');
  await submit(payload(['one']));
  assert.equal((await post(payload(['two']))).json().error.code, 'job_capacity');
  const small = await setup(t, { jobs: { max_bytes: 8192 } });
  assert.equal(
    (
      await small.app.inject({
        method: 'POST',
        url: '/jobs',
        headers: headers(),
        payload: payload(['one']),
      })
    ).json().error.code,
    'job_capacity',
  );
});

test('restart preserves completed results and marks unfinished jobs interrupted without replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jsminer-jobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = configuration({ database: join(dir, 'metadata.db') });
  const worker = controlled();
  let app = buildApp(cfg, { worker });
  await app.ready();
  const first = await app.inject({
    method: 'POST',
    url: '/jobs',
    headers: headers(),
    payload: payload(['one', 'two']),
  });
  const id = first.json().id;
  await until(() => worker.calls.length === 1);
  worker.calls[0].done();
  await until(() => worker.calls.length === 2);
  await app.close();
  // Emulate metadata left by a process lost while an item was running.
  const db = openMetadataStore(cfg.database);
  assert.equal(
    db.database.prepare('SELECT status FROM jobs WHERE id=?').get(id).status,
    'interrupted',
  );
  db.database.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
  db.database.prepare("UPDATE job_items SET status='running' WHERE job=? AND idx=1").run(id);
  db.close();
  const restarted = controlled();
  app = buildApp(cfg, { worker: restarted });
  t.after(() => app.close());
  await app.ready();
  const job = (await app.inject({ url: `/jobs/${id}`, headers: headers() })).json();
  assert.equal(job.status, 'interrupted');
  assert.equal(job.items[0].status, 'complete');
  assert.equal(job.items[1].error_code, 'service_restarted');
  assert.equal(
    (await app.inject({ url: `/jobs/${id}/items/0`, headers: headers() })).statusCode,
    200,
  );
  await delay(40);
  assert.equal(restarted.calls.length, 0);
  assert.equal(statSync(cfg.database).mode & 0o777, 0o600);
});

test('storage reservations account for simultaneous analyses and are released on completion', async (t) => {
  const worker = controlled();
  const config = parseConfig(
    configuration({
      budgets: {
        active_analyses: 2,
        storage_bytes: 72000,
        artifact_bytes: 50000,
        response_bytes: 2000,
      },
    }),
  );
  const db = openMetadataStore(':memory:');
  const engine = new AnalysisEngine(config, db.database, { worker });
  t.after(async () => {
    await engine.close();
    db.close();
  });
  const analyze = (name) =>
    engine.analyze('test', payload([name]).items[0], new AbortController().signal);
  const a = analyze('one');
  const b = analyze('two');
  await until(() => worker.calls.length === 2);
  worker.calls[1].done();
  await b;
  worker.calls[0].done();
  await a;
  const total = Number(db.database.prepare('SELECT sum(bytes) AS n FROM analyses').get().n);
  assert.ok(total <= config.budgets.storage_bytes);
  const c = analyze('three');
  await until(() => worker.calls.length === 3);
  worker.calls[2].done();
  await c;
});

test('an early HTTP admission release keeps its slot until worker cleanup completes', async (t) => {
  const worker = controlled();
  const config = parseConfig(configuration());
  const db = openMetadataStore(':memory:');
  const engine = new AnalysisEngine(config, db.database, { worker });
  t.after(async () => {
    await engine.close();
    db.close();
  });
  const admission = engine.reserve();
  const active = engine.analyze(
    'test',
    payload(['one']).items[0],
    new AbortController().signal,
    1000,
    admission,
  );
  await until(() => worker.calls.length === 1);
  admission();
  assert.equal(engine.available, 0);
  assert.throws(() => engine.reserve(), { code: 'analysis_capacity' });
  worker.calls[0].done();
  await active;
  assert.equal(engine.available, 1);
});

test('unconfirmed worker cleanup blocks admission, aborts peers and never starts queued scripts', async (t) => {
  const calls = [];
  const worker = {
    healthy: true,
    run(input) {
      return new Promise((resolve, reject) => {
        calls.push({ reject });
        input.signal.addEventListener(
          'abort',
          () =>
            resolve({
              ...result(),
              status: 'error',
              errorCode: 'aborted',
              output: Buffer.alloc(0),
            }),
          { once: true },
        );
      });
    },
  };
  const { app, submit, get } = await setup(t, { budgets: { active_analyses: 2 } }, worker);
  const job = await submit(payload(['one', 'two', 'three']));
  await until(() => calls.length === 2);
  calls[0].reject(new CleanupError('cleanup_verify', 'container_remaining'));
  const done = await until(async () => {
    const row = await get(job.id);
    return row.status === 'completed' && row;
  });
  assert.equal(done.items[0].error_code, 'worker_cleanup_unconfirmed');
  assert.equal(done.items[1].error_code, 'analysis_cancelled');
  assert.equal(done.items[2].error_code, 'service_unavailable');
  assert.ok(done.items.every((item) => item.handle === null));
  assert.equal(calls.length, 2);
  assert.equal((await app.inject({ url: '/health', headers: headers() })).statusCode, 503);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/jobs',
        headers: headers(),
        payload: payload(['four']),
      })
    ).statusCode,
    503,
  );
});

test('dispatch rotates between jobs while retaining input order inside each job', async (t) => {
  const { worker, submit, get } = await setup(t);
  const a = await submit(payload(['a0', 'a1', 'a2']));
  await until(() => worker.calls.length === 1);
  const b = await submit(payload(['b0']));
  worker.calls[0].done();
  await until(() => worker.calls.length === 2);
  assert.equal(worker.calls[1].input.content.toString(), 'const b0=1;');
  worker.calls[1].done();
  await until(() => worker.calls.length === 3);
  assert.equal(worker.calls[2].input.content.toString(), 'const a1=1;');
  worker.calls[2].done();
  await until(() => worker.calls.length === 4);
  worker.calls[3].done();
  await until(async () => (await get(a.id)).status === 'completed');
  assert.equal((await get(b.id)).status, 'completed');
});

test('expired jobs release admission quotas and hide their existence from other projects', async (t) => {
  let now = Date.now();
  const worker = { healthy: true, run: async () => result() };
  const app = buildApp(configuration({ jobs: { max_jobs: 1 } }), { worker, now: () => now });
  t.after(() => app.close());
  await app.ready();
  const submit = () =>
    app.inject({ method: 'POST', url: '/jobs', headers: headers(), payload: payload(['one']) });
  const id = (await submit()).json().id;
  await until(
    async () =>
      (await app.inject({ url: `/jobs/${id}`, headers: headers() })).json().status === 'completed',
  );
  now += 86400001;
  assert.equal((await app.inject({ url: `/jobs/${id}`, headers: headers() })).statusCode, 410);
  assert.equal(
    (await app.inject({ url: `/jobs/${id}`, headers: headers('_other') })).statusCode,
    404,
  );
  assert.equal((await submit()).statusCode, 202);
  now += 86400001;
  await submit();
  assert.equal((await app.inject({ url: `/jobs/${id}`, headers: headers() })).statusCode, 404);
});

test('a failed script keeps its own error and does not cancel the rest of the job', async (t) => {
  const worker = { healthy: true, run: async () => result() };
  const { app, submit, get } = await setup(t, {}, worker);
  const input = payload(['bad', 'good']);
  input.items[0].script_hash = `sha256:${'0'.repeat(64)}`;
  const job = await submit(input);
  const end = await until(async () => {
    const row = await get(job.id);
    return row.status === 'completed' && row;
  });
  assert.equal(end.items[0].status, 'failed');
  assert.equal(end.items[0].error_code, 'script_hash_mismatch');
  assert.equal(end.items[0].handle, null);
  assert.equal(end.items[1].status, 'complete');
  assert.equal(
    (await app.inject({ url: `/jobs/${job.id}/items/1`, headers: headers() })).statusCode,
    200,
  );
});

test('cancellation never hides an unconfirmed cleanup behind job_cancelled', async (t) => {
  let started = false;
  const worker = {
    healthy: true,
    run(input) {
      started = true;
      return new Promise((_resolve, reject) =>
        input.signal.addEventListener(
          'abort',
          () => reject(new CleanupError('cleanup_verify', 'container_remaining')),
          { once: true },
        ),
      );
    },
  };
  const { app, submit, get } = await setup(t, {}, worker);
  const job = await submit(payload(['one']));
  await until(() => started);
  await app.inject({ method: 'DELETE', url: `/jobs/${job.id}`, headers: headers() });
  const end = await until(async () => {
    const row = await get(job.id);
    return row.status === 'cancelled' && row;
  });
  assert.equal(end.items[0].error_code, 'worker_cleanup_unconfirmed');
  assert.equal(end.items[0].handle, null);
  assert.equal((await app.inject({ url: '/health', headers: headers() })).statusCode, 503);
});

const tightStorage = {
  active_analyses: 2,
  storage_bytes: 60000,
  artifact_bytes: 60000,
  response_bytes: 2000,
};

test('jobs wait for temporary storage reservations and all complete without restarting extraction', async (t) => {
  const { worker, submit, get } = await setup(t, { budgets: tightStorage });
  const job = await submit(payload(['one', 'two', 'three']));
  await until(() => worker.calls.length === 1);
  await delay(60);
  assert.equal(worker.calls.length, 1);
  assert.ok((await get(job.id)).items.every((item) => item.status !== 'failed'));
  for (let i = 0; i < 3; i++) {
    await until(() => worker.calls.length === i + 1);
    assert.equal(
      worker.calls[i].input.content.toString(),
      payload(['one', 'two', 'three']).items[i].content,
    );
    worker.calls[i].done();
  }
  const end = await until(async () => {
    const row = await get(job.id);
    return row.status === 'completed' && row;
  });
  assert.ok(end.items.every((item) => item.status === 'complete'));
  assert.equal(worker.peak, 1);
});

test('storage waits respect the global deadline and cancellation before starting a worker', async (t) => {
  const { app, worker, submit, get } = await setup(t, { budgets: tightStorage });
  const blocker = await submit(payload(['blocker']));
  await until(() => worker.calls.length === 1);
  const timed = await submit(payload(['timed'], 250));
  await until(async () => (await get(timed.id)).items[0].status === 'running');
  const expired = await until(async () => {
    const row = await get(timed.id);
    return row.status === 'timed_out' && row;
  });
  assert.equal(expired.items[0].error_code, 'global_deadline');
  assert.equal(expired.items[0].handle, null);
  const cancelled = await submit(payload(['cancelled']));
  await until(async () => (await get(cancelled.id)).items[0].status === 'running');
  await app.inject({ method: 'DELETE', url: `/jobs/${cancelled.id}`, headers: headers() });
  const stopped = await until(async () => {
    const row = await get(cancelled.id);
    return row.status === 'cancelled' && row;
  });
  assert.equal(stopped.items[0].error_code, 'job_cancelled');
  assert.equal(worker.calls.length, 1);
  worker.calls[0].done();
  await until(async () => (await get(blocker.id)).status === 'completed');
  await delay(30);
  assert.equal(worker.calls.length, 1);
});

test('committed storage exhaustion fails explicitly instead of waiting indefinitely', async (t) => {
  const { submit, get } = await setup(
    t,
    { budgets: tightStorage },
    { healthy: true, run: async () => result() },
  );
  const job = await submit(payload(Array.from({ length: 12 }, (_, i) => `item${i}`)));
  const end = await until(async () => {
    const row = await get(job.id);
    return row.status === 'completed' && row;
  });
  assert.ok(end.items.some((item) => item.status === 'complete'));
  assert.ok(end.items.some((item) => item.error_code === 'storage_full'));
  assert.ok(
    end.items.every((item) => item.status === 'complete' || item.error_code === 'storage_full'),
  );
});

test('a failed SQL dispatch rolls back its input and exposes scheduler failure while keeping completed results readable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jsminer-job-dispatch-'));
  const database = join(directory, 'metadata.db');
  let calls = 0;
  const app = buildApp(configuration({ database }), {
    worker: {
      healthy: true,
      run: async () => {
        calls++;
        return result();
      },
    },
  });
  let metadata;
  t.after(async () => {
    await app.close();
    metadata?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await app.ready();
  const submit = (budget_ms = 5000) =>
    app.inject({
      method: 'POST',
      url: '/jobs',
      headers: headers(),
      payload: payload(['one'], budget_ms),
    });
  const first = (await submit()).json();
  await until(
    async () =>
      (await app.inject({ url: `/jobs/${first.id}`, headers: headers() })).json().status ===
      'completed',
  );
  metadata = openMetadataStore(database);
  metadata.database.exec(
    "CREATE TRIGGER dispatch_fault BEFORE UPDATE OF turn ON jobs BEGIN SELECT RAISE(FAIL,'simulated write failure'); END;",
  );
  const pending = (await submit(200)).json();
  await until(
    async () => (await app.inject({ url: '/health', headers: headers() })).statusCode === 503,
  );
  metadata.database.exec('DROP TRIGGER dispatch_fault');
  const stored = metadata.database
    .prepare('SELECT status,request FROM job_items WHERE job=?')
    .get(pending.id);
  assert.equal(stored.status, 'queued');
  assert.deepEqual(JSON.parse(stored.request), payload(['one']).items[0]);
  assert.equal(
    metadata.database.prepare('SELECT status,turn FROM jobs WHERE id=?').get(pending.id).status,
    'queued',
  );
  assert.equal(calls, 1);
  for (const path of [`/jobs/${pending.id}`, `/jobs/${pending.id}/items/0`]) {
    const response = await app.inject({ url: path, headers: headers() });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'scheduler_unavailable');
    assert.equal((await app.inject({ url: path, headers: headers('_other') })).statusCode, 404);
  }
  assert.equal(
    (await app.inject({ url: `/jobs/${first.id}`, headers: headers() })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: `/jobs/${first.id}/items/0`, headers: headers() })).statusCode,
    200,
  );
  await delay(210);
  assert.equal(
    (await app.inject({ url: `/jobs/${pending.id}`, headers: headers() })).statusCode,
    503,
  );
  assert.equal(calls, 1);
});

test('omitted aggregate memory preserves legacy per-worker budgets while explicit limits remain enforced', () => {
  const input = configuration({ budgets: { worker_memory_bytes: 8 * 1024 ** 3 } });
  const parsed = parseConfig(input);
  assert.equal(parsed.budgets.total_worker_memory_bytes, 8 * 1024 ** 3);
  assert.equal(parsed.budgets.active_analyses, 1);
  assert.equal(Object.hasOwn(input.budgets, 'total_worker_memory_bytes'), false);
  assert.deepEqual(parseConfig(parsed), parsed);
  assert.equal(parseConfig(configuration()).budgets.total_worker_memory_bytes, 4 * 1024 ** 3);
  assert.throws(
    () =>
      parseConfig(
        configuration({
          budgets: { worker_memory_bytes: 8 * 1024 ** 3, total_worker_memory_bytes: 4 * 1024 ** 3 },
        }),
      ),
    /Inconsistent/,
  );
  assert.throws(
    () => parseConfig(configuration({ budgets: { total_worker_memory_bytes: null } })),
    /Invalid service configuration/,
  );
});

test('waiting for storage retains captured URL bytes without fetching them again', async (t) => {
  let fetches = 0;
  const server = createServer((_request, response) => {
    fetches++;
    response.end('const captured=1;');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { worker, submit, get } = await setup(t, {
    budgets: tightStorage,
    capture: { origins: [{ origin, allow_private: true }] },
  });
  const blocker = await submit(payload(['blocker']));
  await until(() => worker.calls.length === 1);
  const fetched = await submit({
    items: [{ url: `${origin}/fixture.js`, tools: ['jsluice'] }],
    budget_ms: 5000,
  });
  await until(() => fetches === 1);
  await delay(50);
  assert.equal(worker.calls.length, 1);
  worker.calls[0].done();
  await until(() => worker.calls.length === 2);
  assert.equal(worker.calls[1].input.content.toString(), 'const captured=1;');
  worker.calls[1].done();
  await until(async () => (await get(fetched.id)).status === 'completed');
  assert.equal((await get(blocker.id)).items[0].status, 'complete');
  assert.equal((await get(fetched.id)).items[0].status, 'complete');
  assert.equal(fetches, 1);
});
