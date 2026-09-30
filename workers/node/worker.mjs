import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBatch } from './batch.mjs';
import { findingCollector } from './limits.mjs';
import { extract, parseJavaScript } from './static.mjs';
import { trufflehogBatch } from './trufflehog-batch.mjs';

// The container supervisor owns the deadline and kills the entire container.
const tool = process.argv[2];
const MAX_INPUT = 64 * 1024 * 1024;
async function analyze(input) {
  const { content } = input;
  if (typeof content !== 'string' || Buffer.byteLength(content) > 64 * 1024 * 1024)
    throw new Error();
  const maxBytes = Math.min(input.max_bytes ?? 0, 64 * 1024 * 1024);
  const maxModules = Math.min(input.max_modules ?? 0, 2000);
  const result = { modules: [], findings: [], partial: false, reasons: [], error_code: null };
  const reasons = new Set();
  let bytes = 0;
  function module(path, code) {
    if (!code?.isWellFormed()) throw new Error();
    const length = Buffer.byteLength(code);
    if (result.modules.length >= maxModules) {
      reasons.add('module_count');
      return;
    }
    if (bytes + length > maxBytes) {
      reasons.add('artifact_bytes');
      return;
    }
    parseJavaScript(code);
    bytes += length;
    result.modules.push({ path, content: Buffer.from(code).toString('base64') });
  }
  function run(command, args, maxBuffer = 2 * 1024 * 1024) {
    const r = spawnSync(command, args, {
      encoding: 'utf8',
      maxBuffer,
      env: { ...process.env, NO_COLOR: '1' },
    });
    if (r.error || r.status !== 0) throw new Error();
    return r.stdout;
  }
  if (tool === 'webcrack') {
    const { webcrack } = await import('webcrack');
    const value = await webcrack(content, {
      jsx: false,
      unpack: true,
      unminify: true,
      deobfuscate: true,
      mangle: false,
    });
    module('bundle.js', value.code);
    let index = 0;
    for (const valueModule of value.bundle?.modules.values() ?? [])
      module(`modules/m${index++}.js`, valueModule.code);
  } else if (tool === 'wakaru') {
    writeFileSync('/tmp/input.js', content, { mode: 0o600 });
    const cli = '/worker/node_modules/.bin/wakaru';
    run(cli, ['/tmp/input.js', '--level', 'standard', '-o', '/tmp/bundle.js']);
    module('bundle.js', readFileSync('/tmp/bundle.js', 'utf8'));
    try {
      run(cli, ['/tmp/input.js', '--unpack', '--level', 'standard', '-o', '/tmp/modules']);
      const directories = ['/tmp/modules'];
      let index = 0,
        visited = 0;
      while (directories.length) {
        const directory = directories.pop();
        for (const name of readdirSync(directory).sort()) {
          if (++visited > 10000) {
            reasons.add('module_count');
            directories.length = 0;
            break;
          }
          const file = join(directory, name),
            stat = lstatSync(file);
          if (stat.isSymbolicLink()) throw new Error();
          if (stat.isDirectory()) directories.push(file);
          else if (!stat.isFile()) throw new Error();
          else if (/\.(?:js|jsx|mjs|cjs)$/.test(name)) {
            if (stat.size > maxBytes - bytes) {
              reasons.add('artifact_bytes');
              continue;
            }
            module(
              `modules/m${index++}.js`,
              new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)),
            );
          }
        }
      }
    } catch {
      result.partial = true;
      result.error_code = 'unpack_failed';
    }
  } else if (tool === 'trufflehog') {
    mkdirSync('/tmp/source');
    writeFileSync('/tmp/source/input.js', content, { mode: 0o600 });
    const output = run('/usr/local/bin/trufflehog', [
      'filesystem',
      '/tmp/source',
      '--json',
      '--no-verification',
      '--no-update',
      '--concurrency=1',
      '--results=unverified,unknown',
      '--no-color',
    ]);
    const collector = findingCollector();
    result.findings = collector.findings;
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (typeof r.Raw !== 'string' || typeof r.DetectorName !== 'string') throw new Error();
      if (
        !collector.add({
          kind: r.DetectorName,
          value: r.Raw,
          extra: typeof r.RawV2 === 'string' ? r.RawV2 : '',
        })
      ) {
        reasons.add('finding_count');
        break;
      }
    }
  } else if (tool === 'graphql' || tool === 'domains')
    Object.assign(result, extract(content, tool, input.reference_domains));
  else throw new Error();
  result.reasons = [...new Set([...result.reasons, ...reasons])];
  if (result.reasons.length) {
    result.partial = true;
    result.error_code ??= 'output_truncated';
  }
  return result;
}
try {
  if (process.argv[3] === '--batch') {
    if (tool === 'trufflehog') await trufflehogBatch();
    else if (tool === 'graphql' || tool === 'domains') await runBatch(analyze);
    else throw new Error();
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT) throw new Error();
      chunks.push(chunk);
    }
    const input = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    process.stdout.write(JSON.stringify(await analyze(input)));
  }
} catch {
  // Never expose source or upstream diagnostics.
  process.exitCode = 2;
}
