import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { JSLUICE_VERSION } from '@jsminer/adapters';
import { AnalysisEngine } from '../dist/analysis.js';
import { parseConfig } from '../dist/config.js';
import { openMetadataStore } from '../dist/storage.js';

const execute = promisify(execFile);
const worker = {
  healthy: true,
  async run() {
    return {
      status: 'success',
      version: JSLUICE_VERSION,
      errorCode: null,
      durationMs: 1,
      output: Buffer.from(
        JSON.stringify({
          type: 'done',
          version: JSLUICE_VERSION,
          truncated: false,
          secrets_truncated: false,
          syntax_error: false,
        }),
      ),
    };
  },
};
const raw = {
  tokens: [{ sha256: 'a'.repeat(64), project_id: 'p', permissions: ['analysis:write'] }],
};
const analyze = (engine) =>
  engine.analyze(
    'p',
    { content: 'const x = 1;', tools: ['jsluice'] },
    new AbortController().signal,
  );

test('offline purge refuses a live owner and preserves active handles while removing expired data', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jsminer-purge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = parseConfig({ ...raw, database: join(directory, 'metadata.db') });
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const metadata = openMetadataStore(config.database);
  let now = Date.now() - 2 * 86400000;
  const engine = new AnalysisEngine(config, metadata.database, { worker, now: () => now });
  const script = fileURLToPath(new URL('../../../scripts/purge-expired.mjs', import.meta.url));
  const purge = () =>
    execute(process.execPath, [script], { env: { ...process.env, JSMINER_CONFIG: path } });
  try {
    const expired = await analyze(engine);
    // Publish a second live handle without triggering admission purge of the first.
    metadata.database
      .prepare('UPDATE analyses SET expires=? WHERE handle=?')
      .run(Date.now() + 86400000, expired.handle);
    now = Date.now();
    const live = await analyze(engine);
    metadata.database
      .prepare('UPDATE analyses SET expires=? WHERE handle=?')
      .run(Date.now() - 1000, expired.handle);
    await assert.rejects(purge(), (error) => error.code === 1 && !error.stderr.includes(directory));
    await engine.close();
    const output = await purge();
    assert.equal(output.stdout.includes('terminée'), true);
    assert.equal(
      metadata.database.prepare('SELECT expired FROM analyses WHERE handle=?').get(expired.handle)
        .expired,
      1,
    );
    assert.equal(
      metadata.database.prepare('SELECT expired FROM analyses WHERE handle=?').get(live.handle)
        .expired,
      0,
    );
    assert.deepEqual(readdirSync(join(`${config.database}.artifacts`, 'objects')), [live.handle]);
  } finally {
    await engine.close();
    metadata.close();
  }
});

test('SQLite storage exhaustion rolls back unpublished artefacts and allows a later retry', async (t) => {
  const config = parseConfig({ ...raw, database: ':memory:' });
  const metadata = openMetadataStore(config.database);
  const engine = new AnalysisEngine(config, metadata.database, { worker });

  // A multi-page manifest needs fresh SQLite pages while its source files remain small.
  const transform = {
    healthy: true,
    async run() {
      return {
        status: 'success',
        version: 'fixture',
        durationMs: 1,
        errorCode: null,
        output: Buffer.from(
          JSON.stringify({
            modules: [
              { path: 'bundle.js', content: Buffer.from('const x = 1;').toString('base64') },
              ...Array.from({ length: 40 }, (_, i) => ({
                path: `modules/m${i}.js`,
                content: Buffer.from('const x = 1;').toString('base64'),
              })),
            ],
            findings: [],
            partial: false,
            reasons: [],
            error_code: null,
          }),
        ),
      };
    },
  };
  await engine.close();
  const subject = new AnalysisEngine(config, metadata.database, {
    workers: { webcrack: transform },
  });
  t.after(async () => {
    await subject.close();
    metadata.close();
  });
  const pages = Number(metadata.database.prepare('PRAGMA page_count').get().page_count);
  metadata.database.exec(`PRAGMA max_page_count=${pages}`);
  const request = () =>
    subject.analyze(
      'p',
      { content: 'const x = 1;', tools: ['webcrack'] },
      new AbortController().signal,
    );
  await assert.rejects(request(), /full/i);
  assert.equal(metadata.database.prepare('SELECT count(*) AS n FROM analyses').get().n, 0);
  for (const part of ['objects', 'staging'])
    assert.deepEqual(readdirSync(join(subject.store.root, part)), []);
  metadata.database.exec(`PRAGMA max_page_count=${pages + 100}`);
  assert.equal((await request()).status, 'complete');
});

test('purge refuses a missing database without creating an empty replacement', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jsminer-purge-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'missing.db'),
    config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ ...raw, database }), { mode: 0o600 });
  const script = fileURLToPath(new URL('../../../scripts/purge-expired.mjs', import.meta.url));
  await assert.rejects(
    execute(process.execPath, [script], { env: { ...process.env, JSMINER_CONFIG: config } }),
  );
  assert.equal(existsSync(database), false);
});
