import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { beginReport, execute } from './harness.mjs';

test('reports invalidate prior success and reject concurrent qualifications', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qualification-report-'));
  try {
    writeFileSync(join(dir, 'report.json'), '{"passed":true}');
    const session = beginReport('report', dir);
    try {
      assert.equal(JSON.parse(readFileSync(join(dir, 'report.json'))).passed, false);
      assert.throws(() => beginReport('stress', dir), { code: 'EEXIST' });
      session.save({ passed: true });
      assert.equal(JSON.parse(readFileSync(join(dir, 'report.json'))).passed, true);
    } finally {
      session.close();
    }
    const next = beginReport('stress', dir);
    next.close();
    assert.equal(existsSync(join(dir, '.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancellation waits for a stubborn subprocess to exit after escalation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qualification-cancel-'));
  const ready = join(dir, 'ready');
  const controller = new AbortController();
  const result = execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(99), 2000);
  `,
      ready,
    ],
    { signal: controller.signal, graceMs: 50, timeout: 5000 },
  );
  const rejected = assert.rejects(result, /interrupted/);
  try {
    const deadline = Date.now() + 4000;
    while (!existsSync(ready) && Date.now() < deadline) await delay(10);
    assert.equal(existsSync(ready), true);
    const pid = Number(readFileSync(ready, 'utf8'));
    const started = Date.now();
    controller.abort();
    await rejected;
    assert.ok(
      Date.now() - started < 1500,
      'Cancellation did not terminate the subprocess promptly.',
    );
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    const started = Date.now();
    controller.abort();
    await rejected;
    assert.ok(
      Date.now() - started < 1500,
      'Cancellation did not terminate the subprocess promptly.',
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subprocess timeouts and pre-aborted requests fail closed', async () => {
  const started = Date.now();
  await assert.rejects(
    execute(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(99), 2000)'],
      { timeout: 50, graceMs: 50 },
    ),
    /timed out/,
  );
  assert.ok(Date.now() - started < 1500, 'Timeout did not terminate the subprocess promptly.');
  assert.throws(() =>
    execute(process.execPath, ['-e', 'process.exit(0)'], { signal: AbortSignal.abort() }),
  );
});
