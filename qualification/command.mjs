import { spawn } from 'node:child_process';
import { dockerCommand } from '../packages/adapters/dist/index.js';

export function readPeak(stderr) {
  try {
    const matches = [...stderr.matchAll(/^JSMINER_METRICS:(\{[^\n]+\})$/gm)];
    const peak = matches.length === 1 ? JSON.parse(matches[0][1]).peak_bytes : null;
    return Number.isSafeInteger(peak) && peak > 0 ? peak : null;
  } catch {
    return null;
  }
}

/** Only bounded metrics reach the report; all other stderr is discarded. */
export function measuredCommand(samples) {
  return (args, options) => {
    if (args[0] !== 'start') return dockerCommand(args, options);
    return new Promise((resolve) => {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const output = [],
        errors = [];
      let bytes = 0,
        errorBytes = 0,
        fault = null;
      const stop = (reason) => {
        fault ??= reason;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => stop('timeout'), Math.max(1, options.timeoutMs));
      const abort = () => stop('aborted');
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > options.maxBytes) stop('output_limit');
        else output.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        errorBytes += chunk.length;
        if (errorBytes > 65536) stop('output_limit');
        else errors.push(chunk);
      });
      child.stdin.on('error', () => {});
      child.on('error', () => {
        fault = 'spawn_error';
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        const peak = readPeak(Buffer.concat(errors).toString());
        samples.push({
          peak_bytes: Number.isSafeInteger(peak) && peak > 0 ? peak : null,
          status: code === 0 && !fault ? 'success' : 'failed',
        });
        resolve({ code, fault, output: Buffer.concat(output) });
      });
      if (options.signal?.aborted) abort();
      child.stdin.end(options.input);
    });
  };
}
