import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readBatch, writeResult } from './batch.mjs';
import { findingCollector } from './limits.mjs';

export async function trufflehogBatch() {
  mkdirSync('/tmp/source');
  const entries = [];
  const paths = new Map();
  let bytes = 0;
  for await (const { index, bytes: input } of readBatch()) {
    const entry = { index, collector: findingCollector(), partial: false, error: false };
    entries.push(entry);
    try {
      const { content } = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input));
      if (typeof content !== 'string' || !content.isWellFormed()) throw new Error();
      bytes += Buffer.byteLength(content);
      if (bytes > 64 * 1024 * 1024) throw new Error();
      const path = `/tmp/source/m${index}.js`;
      writeFileSync(path, content, { mode: 0o600 });
      paths.set(path, entry);
    } catch {
      entry.error = true;
    }
  }
  if (paths.size) {
    // One detector invocation for the entire directory. Negative files are only
    // marked complete after a successful scan, never from absence of output mid-scan.
    const run = spawnSync(
      '/usr/local/bin/trufflehog',
      [
        'filesystem',
        '/tmp/source',
        '--json',
        '--no-verification',
        '--no-update',
        '--concurrency=1',
        '--results=unverified,unknown',
        '--no-color',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
    );
    if (run.error || run.status !== 0) throw new Error();
    for (const line of run.stdout.trim().split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      const path = record.SourceMetadata?.Data?.Filesystem?.file;
      const entry = paths.get(path);
      if (!entry || typeof record.Raw !== 'string' || typeof record.DetectorName !== 'string')
        throw new Error();
      if (
        !entry.collector.add({
          kind: record.DetectorName,
          value: record.Raw,
          extra: typeof record.RawV2 === 'string' ? record.RawV2 : '',
        })
      )
        entry.partial = true;
    }
  }
  for (const entry of entries) {
    if (entry.error) await writeResult(entry.index, null, 'worker_failed');
    else
      await writeResult(entry.index, {
        modules: [],
        findings: entry.collector.findings,
        partial: entry.partial,
        reasons: entry.partial ? ['finding_count'] : [],
        error_code: entry.partial ? 'output_truncated' : null,
      });
  }
}
