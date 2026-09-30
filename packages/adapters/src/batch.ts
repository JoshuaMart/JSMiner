import type { WorkerResult } from './docker.js';

export const BATCH_INPUT_BYTES = 128 * 1024 * 1024;
export const BATCH_OUTPUT_BYTES = 32 * 1024 * 1024;
export interface BatchResult {
  results: WorkerResult[];
  terminal: WorkerResult | null;
  durationMs: number;
}
export function encodeBatch(contents: Buffer[]): Buffer {
  if (!contents.length || contents.length > 2000) throw new Error('Invalid batch size.');
  let bytes = 0;
  const lines = contents.map((content, index) => {
    if (content.length > 64 * 1024 * 1024) throw new Error('Invalid module size.');
    const line = `${JSON.stringify({ index, input: content.toString('base64') })}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > BATCH_INPUT_BYTES) throw new Error('Invalid batch size.');
    return line;
  });
  return Buffer.from(lines.join(''));
}
/** Only complete, ordered module frames survive a timeout or a killed worker. */
export function decodeBatch(execution: WorkerResult, count: number): BatchResult {
  const results: WorkerResult[] = [];
  const failure = (code: string): WorkerResult => ({
    ...execution,
    status: 'error',
    errorCode: code,
    output: Buffer.alloc(0),
    durationMs: 0,
  });
  let terminal: WorkerResult | null =
    execution.status === 'success'
      ? null
      : { ...execution, output: Buffer.alloc(0), durationMs: 0 };
  let offset = 0;
  while (offset < execution.output.length) {
    const end = execution.output.indexOf(10, offset);
    if (end < 0) {
      if (!terminal) terminal = failure('invalid_worker_output');
      break;
    }
    try {
      if (end - offset > 3 * 1024 * 1024) throw new Error();
      const frame = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(execution.output.subarray(offset, end)),
      );
      if (
        !frame ||
        typeof frame !== 'object' ||
        Array.isArray(frame) ||
        Object.keys(frame).sort().join(',') !== 'error,index,output' ||
        frame.index !== results.length ||
        frame.index >= count ||
        ![null, 'worker_failed'].includes(frame.error) ||
        (frame.error === null ? typeof frame.output !== 'string' : frame.output !== null)
      )
        throw new Error();
      const output = frame.error === null ? Buffer.from(frame.output, 'base64') : Buffer.alloc(0);
      if (
        output.length > 2 * 1024 * 1024 ||
        (frame.error === null && output.toString('base64') !== frame.output)
      )
        throw new Error();
      results.push({
        status: frame.error === null ? 'success' : 'error',
        errorCode: frame.error,
        version: execution.version,
        durationMs: 0,
        output,
      });
    } catch {
      terminal = failure('invalid_worker_output');
      break;
    }
    offset = end + 1;
  }
  if (!terminal && results.length !== count) terminal = failure('incomplete_batch');
  return { results, terminal, durationMs: execution.durationMs };
}
