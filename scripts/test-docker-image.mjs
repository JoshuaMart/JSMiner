import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = process.env.JSMINER_TEST_IMAGE ?? 'jsminer-api:test';
const name = `jsminer-image-test-${randomUUID()}`;
const volume = `${name}-data`;
const socket = process.env.JSMINER_DOCKER_SOCKET ?? '/var/run/docker.sock';
const volumeMount = `type=volume,src=${volume},dst=/data`;
const socketMount = `type=bind,src=${socket},dst=/var/run/docker.sock`;
const docker = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

try {
  docker(['volume', 'create', volume]);
  const group = docker([
    'run',
    '--rm',
    '--mount',
    socketMount,
    image,
    'stat',
    '-c',
    '%g',
    '/var/run/docker.sock',
  ]).trim();
  assert.match(group, /^\d+$/);
  docker([
    'run',
    '--rm',
    '--mount',
    volumeMount,
    '-e',
    'JSMINER_WORKER_IMAGE=jsminer-jsluice:phase2',
    '-e',
    'JSMINER_OFFLINE_WORKER_IMAGE=jsminer-offline:phase3',
    image,
    'node',
    '/app/init-config.mjs',
    '--docker',
  ]);
  const initialized = JSON.parse(
    docker(['run', '--rm', '--mount', volumeMount, image, 'cat', '/data/.local/config.json']),
  );
  assert.equal(initialized.host, '0.0.0.0');
  assert.equal(initialized.worker_image, 'jsminer-jsluice:phase2');
  assert.equal(initialized.offline_worker_image, 'jsminer-offline:phase3');
  assert.throws(() =>
    docker([
      'run',
      '--rm',
      '--mount',
      volumeMount,
      image,
      'node',
      '/app/init-config.mjs',
      '--docker',
    ]),
  );
  const token = docker([
    'run',
    '--rm',
    '--mount',
    volumeMount,
    image,
    'cat',
    '/data/.local/token',
  ]).trim();
  const start = () => {
    docker([
      'run',
      '-d',
      '--name',
      name,
      '--group-add',
      group,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--mount',
      volumeMount,
      '--mount',
      socketMount,
      '-p',
      '127.0.0.1::3000',
      image,
    ]);
    const published = docker(['port', name, '3000/tcp']).trim();
    assert.match(published, /^127\.0\.0\.1:\d+$/);
    return `http://${published}`;
  };
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const ready = async (base) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      try {
        const response = await fetch(`${base}/health`, {
          headers,
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) return;
      } catch {
        /* Wait for the container listener. */
      }
      await pause();
    }
    throw new Error('Container did not become ready.');
  };
  let base = start();
  await ready(base);
  assert.notEqual(docker(['exec', name, 'id', '-u']).trim(), '0');
  assert.equal((await fetch(`${base}/health`)).status, 401);
  const content =
    'fetch("/api/docker-fixture"); const doc = gql`query Viewer { viewer { id } }`; const link = "https://api.example.com/v1";';
  const request = {
    content,
    tools: ['jsluice', 'graphql', 'domains'],
    base_url: 'https://app.example.com/',
    reference_domains: ['example.com'],
  };
  const analyze = async () => {
    const response = await fetch(`${base}/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(110000),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'complete');
    assert.ok(result.endpoints.some((e) => e.value === '/api/docker-fixture'));
    assert.ok(result.gql_operations.some((e) => e.name === 'Viewer'));
    assert.ok(result.subdomains.some((e) => e.hostname === 'api.example.com'));
    return result;
  };
  const first = await analyze();
  docker(['stop', '--time', '15', name]);
  docker(['rm', name]);
  base = start();
  await ready(base);
  const source = await fetch(`${base}/source/${first.handle}/original/bundle.js`, { headers });
  assert.equal(source.status, 200);
  assert.equal((await source.json()).content, content);
  assert.equal((await analyze()).cache.status, 'hit');
  console.info(
    'Docker image verified: auth, both worker images, source retention and cache after restart.',
  );
} finally {
  for (const args of [
    ['rm', '--force', name],
    ['volume', 'rm', volume],
  ]) {
    try {
      docker(args);
    } catch {
      /* Keep the original test failure. */
    }
  }
}
