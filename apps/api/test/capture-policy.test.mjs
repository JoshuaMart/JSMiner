import assert from 'node:assert/strict';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { capture } from '../dist/capture.js';
import { parseConfig } from '../dist/config.js';

const raw = {
  database: ':memory:',
  tokens: [{ sha256: 'a'.repeat(64), project_id: 'p', permissions: ['analysis:write'] }],
};
const config = (capture = {}) => parseConfig({ ...raw, capture });
const denied = (promise) =>
  assert.rejects(promise, (error) => error.status === 403 && error.code === 'destination_denied');

test('Capture defaults to public while preserving configured legacy allowlists', () => {
  assert.equal(parseConfig(raw).capture.mode, 'public');
  assert.equal(config({ origins: [] }).capture.mode, 'public');
  const legacy = { origins: [{ origin: 'https://fixture.invalid' }] };
  assert.equal(config(legacy).capture.mode, 'allowlist');
  assert.equal(legacy.mode, undefined);
  assert.equal(config({ ...legacy, mode: 'public' }).capture.mode, 'public');
  assert.equal(config({ mode: 'allowlist' }).capture.mode, 'allowlist');
  for (const mode of [null, '', 'all', true]) assert.throws(() => config({ mode }));
});

test('Public capture accepts an unlisted public destination and pins its address', async (t) => {
  const fixture = http.createServer((_req, res) => res.end('const fixture = 1;'));
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fixture.close(resolve)));
  const originalRequest = http.request;
  const pinned = [];
  // Route transport to a local fixture only after recording the production DNS pin.
  // No request in this test reaches the public network.
  const transport = t.mock.method(http, 'request', (target, options, callback) => {
    options.lookup(target.hostname, { all: true }, (error, addresses) => {
      assert.equal(error, null);
      pinned.push(addresses);
    });
    return originalRequest(
      `http://127.0.0.1:${fixture.address().port}${target.pathname}`,
      options,
      callback,
    );
  });
  syncBuiltinESMExports();
  t.after(() => {
    transport.mock.restore();
    syncBuiltinESMExports();
  });
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) {
    const answer = { address, family: address.includes(':') ? 6 : 4 };
    let resolutions = 0;
    const bytes = await capture(
      'http://fixture.invalid/bundle.js',
      config(),
      new AbortController().signal,
      1000,
      async () => {
        resolutions++;
        return [answer];
      },
    );
    assert.equal(bytes.toString(), 'const fixture = 1;');
    assert.equal(resolutions, 1);
    assert.deepEqual(pinned.at(-1), [answer]);
  }
  assert.equal(transport.mock.callCount(), 2);
});

test('Public mode rejects private, mixed and malformed DNS answers before transport', async () => {
  for (const answers of [
    [],
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '10.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: '8.8.8.8', family: 6 }],
    [{ address: 'invalid', family: 4 }],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ],
  ]) {
    await denied(
      capture(
        'http://fixture.invalid/x',
        config(),
        new AbortController().signal,
        1000,
        async () => answers,
      ),
    );
  }
});

test('Allowlist mode rejects unlisted destinations before DNS, including an empty list', async () => {
  for (const origins of [[], [{ origin: 'https://allowed.invalid' }]]) {
    let resolutions = 0;
    await denied(
      capture(
        'https://fixture.invalid/x',
        config({ mode: 'allowlist', origins }),
        new AbortController().signal,
        1000,
        async () => {
          resolutions++;
          return [{ address: '8.8.8.8', family: 4 }];
        },
      ),
    );
    assert.equal(resolutions, 0);
  }
});

test('Private exceptions in public mode remain scoped to the exact origin', async (t) => {
  const fixture = http.createServer((_req, res) => res.end('const fixture = 1;'));
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fixture.close(resolve)));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const allowed = config({ mode: 'public', origins: [{ origin, allow_private: true }] });
  assert.equal(
    (await capture(`${origin}/x`, allowed, new AbortController().signal, 1000)).toString(),
    'const fixture = 1;',
  );
  await denied(capture('http://127.0.0.1:1/x', allowed, new AbortController().signal, 1000));
});
