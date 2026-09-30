import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('startup identifies a busy port without exposing configuration or credentials', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jsminer-startup-'));
  const server = createServer();
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const digest = randomBytes(32).toString('hex');
  const privateDirectory = join(directory, 'private');
  mkdirSync(privateDirectory, { mode: 0o700 });
  const config = join(directory, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      port,
      database: join(privateDirectory, 'metadata.db'),
      tokens: [{ sha256: digest, project_id: 'private-project', permissions: ['analysis:read'] }],
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    exec(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url))], {
      env: { ...process.env, JSMINER_CONFIG: config },
      timeout: 10000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /EADDRINUSE/);
      assert.ok(error.stderr.includes(`127.0.0.1:${port}`));
      for (const value of [directory, digest, 'private-project'])
        assert.equal(error.stderr.includes(value), false);
      assert.equal(error.stdout, '');
      return true;
    },
  );
});
