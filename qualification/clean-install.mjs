import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { beginReport, cleanupOwner, execute } from './harness.mjs';

const session = beginReport('clean-install');
const exec = (file, args, options) => execute(file, args, { ...options, signal: session.signal });
let directory;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const token = randomBytes(32).toString('hex'),
  other = randomBytes(32).toString('hex');
const content =
  '\ufefffetch("/api/fixture"); const document=gql`query Fixture { viewer { id } }`;\r\n';
let forwardedCredentials = false;
const capture = createServer((req, res) => {
  forwardedCredentials ||= req.headers.authorization !== undefined;
  res.setHeader('content-encoding', 'gzip');
  res.end(gzipSync(content));
});
let child,
  closed,
  logs = '',
  owner,
  report;
const stop = () => child?.kill('SIGTERM');
session.signal.addEventListener('abort', stop);
const timedSignal = (ms) => AbortSignal.any([session.signal, AbortSignal.timeout(ms)]);
try {
  directory = mkdtempSync(join(tmpdir(), 'jsminer-clean-'));
  const files = (
    await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout
    .split('\0')
    .filter(Boolean);
  for (const file of new Set(files)) {
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  console.info(
    'Installation dans un workspace temporaire sans dépendances ni configuration existantes.',
  );
  await exec('pnpm', ['install', '--frozen-lockfile'], {
    cwd: directory,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120000,
  });
  await exec('pnpm', ['build'], { cwd: directory, maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
  await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const local = join(directory, '.local');
  mkdirSync(local, { mode: 0o700 });
  const configFile = join(local, 'config.json'),
    database = join(local, 'metadata.db');
  const captureOrigin = `http://127.0.0.1:${capture.address().port}`;
  writeFileSync(
    configFile,
    JSON.stringify({
      database,
      port,
      capture: { origins: [{ origin: captureOrigin, allow_private: true }] },
      tokens: [
        {
          sha256: digest(token),
          project_id: 'fixture',
          permissions: ['analysis:read', 'analysis:write', 'source:read'],
        },
        { sha256: digest(other), project_id: 'other', permissions: ['source:read'] },
      ],
    }),
    { mode: 0o600 },
  );
  owner = digest(`${database}.artifacts`).slice(0, 24);
  session.signal.throwIfAborted();
  child = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: directory,
    env: { ...process.env, JSMINER_CONFIG: configFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve) => child.once('close', (code, signal) => resolve([code, signal])));
  child.on('error', () => {});
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => {
      logs += bytes.toString();
      if (logs.length > 65536) child.kill('SIGTERM');
    });
  const origin = `http://127.0.0.1:${port}`,
    headers = { authorization: `Bearer ${token}` };
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch(`${origin}/health`, { headers, signal: timedSignal(1000) })).ok;
    } catch {}
    if (ready || child.exitCode !== null) break;
    await delay(100, undefined, { signal: session.signal });
  }
  assert.equal(ready, true, 'Fresh service did not start.');
  const post = async () => {
    const response = await fetch(`${origin}/analyze`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${captureOrigin}/fixture.js`,
        script_hash: `sha256:${digest(content)}`,
        base_url: 'https://app.example.com/',
      }),
      signal: timedSignal(120000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await post(),
    second = await post();
  assert.equal(forwardedCredentials, false);
  assert.equal(first.status, 'complete');
  assert.equal(second.cache.status, 'hit');
  assert.notEqual(first.handle, second.handle);
  const path = `/source/${first.handle}/original/bundle.js`;
  const source = await fetch(origin + path, { headers, signal: timedSignal(10000) });
  assert.equal((await source.json()).content, content);
  assert.equal(
    (
      await fetch(origin + path, {
        headers: { authorization: `Bearer ${other}` },
        signal: timedSignal(10000),
      })
    ).status,
    404,
  );
  child.kill('SIGTERM');
  const [code, signal] = await Promise.race([
    closed,
    delay(10000, undefined, { ref: false }).then(() => {
      throw new Error('Shutdown timed out.');
    }),
  ]);
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(
    (
      await exec('docker', ['ps', '-aq', '--filter', `label=io.jsminer.owner=${owner}`])
    ).stdout.trim(),
    '',
  );
  assert.equal(logs.includes(content), false);
  assert.equal(logs.includes(token), false);
  assert.equal(logs.includes(other), false);
  await exec(process.execPath, ['scripts/purge-expired.mjs'], {
    cwd: directory,
    env: { ...process.env, JSMINER_CONFIG: configFile },
  });
  report = {
    passed: true,
    date: new Date().toISOString(),
    node: process.version,
    checks: [
      'frozen install',
      'build',
      'authenticated health',
      'gzip capture',
      'full production workers',
      'cache hit',
      'source bytes',
      'project isolation',
      'graceful shutdown',
      'no abandoned workers',
      'no source/token in logs',
      'offline purge',
    ],
  };
} finally {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([closed, delay(10000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await closed;
      }
    }
    capture.closeAllConnections();
    await new Promise((resolve) => capture.close(resolve));
    if (owner) await cleanupOwner(owner);
    if (directory) rmSync(directory, { recursive: true, force: true });
    session.signal.throwIfAborted();
    if (report) {
      session.save(report);
      console.info('Installation propre et parcours HTTP complet validés.');
    }
  } finally {
    session.signal.removeEventListener('abort', stop);
    session.close();
  }
}
